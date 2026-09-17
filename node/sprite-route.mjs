import express from 'express';
import { join } from 'path';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { generateSpriteSheet, generateVttFileFFmpeg, FAILURE_KIND } from './sprite.mjs';
import { initializeDatabase, getTVShowByName, getMovieByName, releaseDatabase } from './sqliteDatabase.mjs';
import { createOrUpdateProcessQueue, finalizeProcessQueue, getProcessTrackingDb, updateProcessQueue } from './sqlite/processTracking.mjs';
import { fileExists, shouldUseAvif, convertToAvif, spritesheetCacheDir } from './utils/utils.mjs';
import { resolveMovieVideo, resolveEpisodeVideo, findEpisodeEntry } from './utils/mediaResolution.mjs';
import { getInfo } from './infoManager.mjs';
import { createCategoryLogger } from './lib/logger.mjs';

const logger = createCategoryLogger('sprite-route');

// Chrome's maximum image height limit
const CHROME_HEIGHT_LIMIT = 30780;

// Track processing files to avoid duplicate work
const spriteSheetProcessingFiles = new Set();
const spriteSheetRequestQueues = new Map();
// VTT generation is fire-and-forget: the first request starts it and every
// request while it runs gets a 202 with progress, so no socket is held for
// the minutes a long film takes. Jobs are keyed by the UUID-versioned VTT
// filename, so a replaced source file starts clean. A failure is remembered
// for VTT_FAILURE_HOLD_MS and answered with its status, so a polling client
// does not restart the job on every probe; the first request after that
// window retries from scratch.
const vttJobs = new Map();
const VTT_TOTAL_STEPS = 3;
const VTT_RETRY_AFTER_SECONDS = 5;
const VTT_FAILURE_HOLD_MS = Math.max(0, parseInt(process.env.VTT_FAILURE_HOLD_MS, 10) || 60_000);
const VTT_MESSAGE_MAX = 120;

function truncateMessage(message) {
  return String(message ?? '').slice(0, VTT_MESSAGE_MAX);
}

// The contract's progress is the fraction of the current step: 0 while the
// file is analysed, the share of frames done while extracting, 1 while the
// sheet is converted and the VTT written.
function normalizeProgress(progress, step) {
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    return Math.max(0, Math.min(1, progress));
  }
  return step >= VTT_TOTAL_STEPS ? 1 : 0;
}

function sendGenerating(res, job) {
  res.status(202);
  res.setHeader('Retry-After', String(VTT_RETRY_AFTER_SECONDS));
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    status: 'generating',
    step: job.step,
    totalSteps: VTT_TOTAL_STEPS,
    progress: job.progress,
    message: job.message,
  });
}

/**
 * Maps a generation failure onto the delivery contract: a probe failure means
 * the title cannot have previews as it stands (404, the client stops asking);
 * a tool failure is ffmpeg or avifenc exiting non-zero (502); anything else
 * is ours (500).
 */
export function classifyVttFailure(error) {
  const message = truncateMessage(error?.message || error);
  if (error?.failureKind === FAILURE_KIND.PROBE) {
    return { status: 404, body: { status: 'unavailable', message } };
  }
  if (error?.failureKind === FAILURE_KIND.TOOL) {
    return { status: 502, body: { status: 'failed', message } };
  }
  return { status: 500, body: { status: 'failed', message } };
}

function vttFileNameFor(type, { movieName, showName, season, episode }, videoUUID) {
  const sanitize = (value) => value.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const sanitizedName = sanitize(movieName || showName);
  const shortUUID = videoUUID.substring(0, 8);
  const version = Math.floor(1.0001 * 10000).toString().padStart(4, '0'); // Use same version as SPRITE_VERSION
  if (type === 'movies') {
    return `movie_${sanitizedName}_spritesheet_${shortUUID}_v${version}.vtt`;
  }
  return `tv_${sanitizedName}_${sanitize(season)}_${sanitize(episode)}_spritesheet_${shortUUID}_v${version}.vtt`;
}

/**
 * Answers every request that queued behind an in-flight generation which has
 * now failed. They were parked in the map with no timer, so without this they
 * are never responded to and hang until the client gives up.
 */
function failQueuedRequests(queues, fileKey, message = "Internal server error") {
  const queued = queues.get(fileKey) || [];
  queues.delete(fileKey);
  for (const queuedRes of queued) {
    if (!queuedRes.headersSent) {
      queuedRes.status(500).send(message);
    }
  }
}

/**
 * Helper function to get video path from database
 */
async function getVideoPath(type, db, { movieName, showName, season, episode }, BASE_PATH) {
  if (type === "movies") {
    const movie = await getMovieByName(movieName);
    if (!movie) {
      throw new Error(`Movie not found: ${movieName}`);
    }
    // Resolve from disk rather than from urls.mp4: the stored URL is a
    // publishing artifact, and rebuilding a filesystem path out of it broke
    // whenever the container on disk differed from the one last scanned.
    const videoRef = await resolveMovieVideo({ basePath: BASE_PATH, movieName });
    if (!videoRef) {
      throw new Error(`Movie file not found: ${movieName}`);
    }
    return videoRef.path;
  } else {
    const showData = await getTVShowByName(showName);
    if (!showData) {
      throw new Error(`Show not found: ${showName}`);
    }
    const entry = findEpisodeEntry(showData, season, episode);
    if (!entry) {
      throw new Error(
        `Episode not found: ${showName} - Season ${season} Episode ${episode}`
      );
    }
    const videoRef = await resolveEpisodeVideo({
      basePath: BASE_PATH,
      showName,
      season,
      episode,
      preferFilename: entry.episode.filename,
    });
    if (!videoRef) {
      throw new Error(
        `Episode file not found: ${showName} - Season ${season} Episode ${episode}`
      );
    }
    return videoRef.path;
  }
}

/**
 * Helper function to find existing UUID-based sprite sheet files
 */
async function findExistingUUIDSpriteFile(cacheDir, type, name, season, episode, videoUUID) {
  try {
    const files = await fs.readdir(cacheDir);
    const sanitizedName = name.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const shortUUID = videoUUID.substring(0, 8);
    
    let pattern;
    if (type === 'movies') {
      pattern = new RegExp(`^movie_${sanitizedName}_spritesheet_${shortUUID}_v\\d+\\.(avif|png)$`);
    } else {
      const sanitizedSeason = season.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const sanitizedEpisode = episode.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      pattern = new RegExp(`^tv_${sanitizedName}_${sanitizedSeason}_${sanitizedEpisode}_spritesheet_${shortUUID}_v\\d+\\.(avif|png)$`);
    }
    
    const matchedFiles = files.filter(file => pattern.test(file));
    if (matchedFiles.length > 0) {
      const file = matchedFiles[0];
      return {
        path: join(cacheDir, file),
        format: file.endsWith('.avif') ? 'avif' : 'png'
      };
    }
    
    return null;
  } catch (error) {
    logger.warn(`Error finding existing UUID sprite file: ${error.message}`);
    return null;
  }
}

/**
 * Handles HTTP requests for sprite sheets, serving cached files and managing conversions.
 */
async function handleSpriteSheetRequest(req, res, type, BASE_PATH) {
  try {
    const db = await initializeDatabase();
    const processDB = await getProcessTrackingDb();
    const { movieName, showName, season, episode } = req.params;

    // Get video path to determine UUID
    const videoPath = await getVideoPath(type, db, {
      movieName,
      showName,
      season,
      episode,
    }, BASE_PATH);

    const videoInfo = await getInfo(videoPath);
    const videoUUID = videoInfo.uuid;

    // Check for existing UUID-based sprite sheet
    const existingFile = await findExistingUUIDSpriteFile(
      spritesheetCacheDir,
      type,
      movieName || showName,
      season,
      episode,
      videoUUID
    );

    if (existingFile) {
      logger.info(`Serving existing UUID-based sprite sheet: ${existingFile.path}`);

      // For PNG files, check dimensions to see if we should convert to AVIF
      if (existingFile.format === "png") {
        try {
          const metadata = await sharp(existingFile.path).metadata();
          const shouldBeAvif = metadata.height <= CHROME_HEIGHT_LIMIT;
          
          // Try to find or create AVIF version
          const avifFile = existingFile.path.replace('.png', '.avif');
          
          if (shouldBeAvif && !(await fileExists(avifFile))) {
            // Attempt AVIF conversion in background
            res.setHeader("Cache-Control", "public, max-age=60");
            res.setHeader("Content-Type", "image/png");
            res.sendFile(existingFile.path);

            try {
              // Only attempt AVIF conversion if enabled
              if (shouldUseAvif(metadata.height)) {
                await convertToAvif(existingFile.path, avifFile, 60, 4, false);
                logger.info(`Background conversion to AVIF successful: ${avifFile}`);
              } else {
                logger.info(`Background AVIF conversion skipped (disabled or height ${metadata.height}px exceeds limit)`);
              }
            } catch (error) {
              logger.error("Background AVIF conversion failed:" + error);
            }
            await releaseDatabase(db);
            return;
          }
        } catch (error) {
          logger.error("Error checking PNG dimensions:" + error);
        }
      }

      // Serve the file with appropriate headers
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader(
        "Content-Type",
        existingFile.format === "avif" ? "image/avif" : "image/png"
      );
      if (existingFile.format === "avif") {
        res.setHeader("Accept-Ranges", "bytes");
      }
      await releaseDatabase(db);
      return res.sendFile(existingFile.path);
    }

    // If no sprite sheet exists, generate it
    const fileKey =
      type === "movies"
        ? `movie_${movieName}`
        : `tv_${showName}_${season}_${episode}`;

    if (spriteSheetProcessingFiles.has(fileKey)) {
      // Handle queued requests
      if (!spriteSheetRequestQueues.has(fileKey)) {
        spriteSheetRequestQueues.set(fileKey, []);
      }
      spriteSheetRequestQueues.get(fileKey).push(res);
      await releaseDatabase(db);
      return;
    }

    spriteSheetProcessingFiles.add(fileKey);
    
    // Create a process queue entry with totalSteps = 3
    await createOrUpdateProcessQueue(
      processDB,
      fileKey + "_spritesheet",
      "spritesheet",
      3,        // total steps
      0,        // current step
      "in-progress",
      "Starting sprite sheet creation"
    );

    try {
      await releaseDatabase(db);

      // Generate sprite sheet with UUID versioning
      const { spriteSheetPath, format } = await generateSpriteSheet({
        videoPath,
        type,
        name: movieName || showName,
        season,
        episode,
        cacheDir: spritesheetCacheDir,
        onProgress: async (stepNumber, message) => {
          // Utility callback to track each step
          const dbInner = await getProcessTrackingDb();
          await updateProcessQueue(dbInner, fileKey + "_spritesheet", stepNumber, "in-progress", message);
          await releaseDatabase(dbInner);
        },
      });

      // Mark the process as completed
      const dbFinal = await getProcessTrackingDb();
      await finalizeProcessQueue(dbFinal, fileKey + "_spritesheet");
      await releaseDatabase(dbFinal);

      // Process queued requests. Taken only now, so anything thrown above
      // still leaves them in the map for the catch block to answer.
      const queuedRequests = spriteSheetRequestQueues.get(fileKey) || [];
      spriteSheetRequestQueues.delete(fileKey);
      spriteSheetProcessingFiles.delete(fileKey);

      queuedRequests.forEach((queuedRes) => {
        queuedRes.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable"
        );
        queuedRes.setHeader(
          "Content-Type",
          format === "avif" ? "image/avif" : "image/png"
        );
        if (format === "avif") {
          queuedRes.setHeader("Accept-Ranges", "bytes");
        }
        queuedRes.sendFile(spriteSheetPath);
      });

      // Serve the generated sprite sheet
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader(
        "Content-Type",
        format === "avif" ? "image/avif" : "image/png"
      );
      if (format === "avif") {
        res.setHeader("Accept-Ranges", "bytes");
      }
      return res.sendFile(spriteSheetPath);
    } catch (error) {
      spriteSheetProcessingFiles.delete(fileKey);
      failQueuedRequests(spriteSheetRequestQueues, fileKey);
      // Mark the queue as errored
      const dbErr = await getProcessTrackingDb();
      await finalizeProcessQueue(dbErr, fileKey + "_spritesheet", "error", error.message);
      await releaseDatabase(dbErr);

      throw error;
    }
  } catch (error) {
    logger.error(error);
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    }
  }
}

/**
 * Handles VTT file requests with UUID-based file lookup
 */
async function handleVttRequest(req, res, type, BASE_PATH) {
  let db;
  try {
    db = await initializeDatabase();
    const { movieName, showName, season, episode } = req.params;

    let videoPath;
    try {
      videoPath = await getVideoPath(type, db, { movieName, showName, season, episode }, BASE_PATH);
    } catch (error) {
      // Unknown title, or no video on disk: there is nothing to generate from.
      logger.warn(`VTT requested for a title with no video: ${error.message}`);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).json({ status: 'unavailable', message: truncateMessage(error.message) });
    }

    const { uuid: videoUUID } = await getInfo(videoPath);
    const vttFileName = vttFileNameFor(type, { movieName, showName, season, episode }, videoUUID);
    const vttFilePath = join(spritesheetCacheDir, vttFileName);

    if (await fileExists(vttFilePath)) {
      logger.info(`Serving UUID-based VTT file from cache: ${vttFileName}`);
      res.setHeader("Content-Type", "text/vtt");
      return createReadStream(vttFilePath).pipe(res);
    }

    logger.info(`UUID-based VTT file not found in cache: ${vttFileName}`);

    const existing = vttJobs.get(vttFileName);
    if (existing?.state === 'generating') {
      return sendGenerating(res, existing);
    }
    if (existing?.state === 'failed') {
      if (Date.now() - existing.at < VTT_FAILURE_HOLD_MS) {
        res.setHeader('Cache-Control', 'no-store');
        if (existing.status >= 500) {
          res.setHeader('Retry-After', String(Math.ceil(VTT_FAILURE_HOLD_MS / 1000)));
        }
        return res.status(existing.status).json(existing.body);
      }
      vttJobs.delete(vttFileName);
    }

    const fileKey =
      type === "movies"
        ? `movie_${movieName}`
        : `tv_${showName}_${season}_${episode}`;
    const job = {
      state: 'generating',
      startedAt: Date.now(),
      step: 1,
      progress: 0,
      message: 'Starting VTT generation',
    };
    vttJobs.set(vttFileName, job);
    runVttGeneration({
      job,
      vttFileName,
      vttFilePath,
      videoPath,
      type,
      name: movieName || showName,
      season,
      episode,
      fileKey,
    }).catch((error) => {
      logger.error(`VTT generation runner failed unexpectedly for ${fileKey}: ${error.message}`);
    });
    return sendGenerating(res, job);
  } catch (error) {
    logger.error(error);
    if (!res.headersSent) {
      res.status(500).json({ status: 'failed', message: 'Internal server error' });
    }
  } finally {
    if (db) {
      await releaseDatabase(db).catch(() => {});
    }
  }
}

/**
 * Runs one VTT generation in the background, keeping the job the route
 * answers 202 from up to date and mirroring progress into process_queue.
 * On failure the job becomes a remembered failure for VTT_FAILURE_HOLD_MS.
 */
async function runVttGeneration({ job, vttFileName, vttFilePath, videoPath, type, name, season, episode, fileKey }) {
  const vttKey = fileKey + "_vtt";
  const spriteKey = fileKey + "_spritesheet";
  try {
    const processDB = await getProcessTrackingDb();
    await createOrUpdateProcessQueue(processDB, vttKey, "vtt", VTT_TOTAL_STEPS, 1, "in-progress", job.message);
    await createOrUpdateProcessQueue(processDB, spriteKey, "spritesheet", VTT_TOTAL_STEPS, 0, "in-progress", "Starting sprite sheet creation");
    await releaseDatabase(processDB);

    await generateSpriteSheet({
      videoPath,
      type,
      name,
      season,
      episode,
      cacheDir: spritesheetCacheDir,
      onProgress: async (stepNumber, message, progress) => {
        job.step = stepNumber;
        job.message = truncateMessage(message);
        job.progress = normalizeProgress(progress, stepNumber);
        // The generator already throttles fraction events to about one per
        // second, so each one can be mirrored into process_queue.
        const dbInner = await getProcessTrackingDb();
        const dbMessage = stepNumber === 2 ? `${job.message} ${Math.round(job.progress * 100)}%` : job.message;
        await updateProcessQueue(dbInner, vttKey, stepNumber, "in-progress", dbMessage);
        await updateProcessQueue(dbInner, spriteKey, stepNumber, "in-progress", dbMessage);
        await releaseDatabase(dbInner);
      },
    });

    if (!await fileExists(vttFilePath)) {
      throw new Error("Failed to generate VTT file");
    }

    const dbFinal = await getProcessTrackingDb();
    await finalizeProcessQueue(dbFinal, vttKey, "completed", "VTT generation done");
    await finalizeProcessQueue(dbFinal, spriteKey, "completed", "Spritesheet generation done");
    await releaseDatabase(dbFinal);
    vttJobs.delete(vttFileName);
    logger.info(`VTT generation finished for ${fileKey} in ${Math.round((Date.now() - job.startedAt) / 1000)}s`);
  } catch (error) {
    const failure = classifyVttFailure(error);
    vttJobs.set(vttFileName, { state: 'failed', at: Date.now(), ...failure });
    logger.error(`VTT generation failed for ${fileKey} (${failure.status}): ${error.message}`);
    try {
      const dbErr = await getProcessTrackingDb();
      await finalizeProcessQueue(dbErr, vttKey, "error", error.message);
      await finalizeProcessQueue(dbErr, spriteKey, "error", error.message);
      await releaseDatabase(dbErr);
    } catch (dbError) {
      logger.error(`Could not record the VTT failure for ${fileKey}: ${dbError.message}`);
    }
  }
}

/**
 * Setup sprite sheet routes with BASE_PATH dependency injection
 */
export function createSpriteRoutes(BASE_PATH) {
  const router = express.Router();

  // Sprite sheet routes
  router.get("/spritesheet/movie/:movieName", (req, res) => {
    handleSpriteSheetRequest(req, res, "movies", BASE_PATH);
  });

  router.get("/spritesheet/tv/:showName/:season/:episode", (req, res) => {
    handleSpriteSheetRequest(req, res, "tv", BASE_PATH);
  });

  // VTT routes
  router.get("/vtt/movie/:movieName", (req, res) => {
    handleVttRequest(req, res, "movies", BASE_PATH);
  });

  router.get("/vtt/tv/:showName/:season/:episode", (req, res) => {
    handleVttRequest(req, res, "tv", BASE_PATH);
  });

  return router;
}