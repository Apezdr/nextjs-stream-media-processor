import express from 'express';
import { join } from 'path';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import { generateSpriteSheet, generateVttFileFFmpeg } from './sprite.mjs';
import { initializeDatabase, getTVShowByName, getMovieByName, releaseDatabase } from './sqliteDatabase.mjs';
import { createOrUpdateProcessQueue, finalizeProcessQueue, getProcessTrackingDb, updateProcessQueue } from './sqlite/processTracking.mjs';
import { fileExists, shouldUseAvif, convertToAvif, spritesheetCacheDir, getEpisodeKey, getEpisodeFilename, getCleanVideoPath } from './utils/utils.mjs';
import { getInfo } from './infoManager.mjs';
import { createCategoryLogger } from './lib/logger.mjs';

const logger = createCategoryLogger('sprite-route');
const router = express.Router();

// Chrome's maximum image height limit
const CHROME_HEIGHT_LIMIT = 30780;

// Track processing files to avoid duplicate work
const spriteSheetProcessingFiles = new Set();
const spriteSheetRequestQueues = new Map();
const vttProcessingFiles = new Set();
const vttRequestQueues = new Map();

/**
 * Helper function to get video path from database
 */
async function getVideoPath(type, db, { movieName, showName, season, episode }, BASE_PATH) {
  if (type === "movies") {
    const movie = await getMovieByName(movieName);
    if (!movie) {
      throw new Error(`Movie not found: ${movieName}`);
    }
    const urls = typeof movie.urls === 'string' ? JSON.parse(movie.urls) : movie.urls;
    const videoMp4 = decodeURIComponent(urls.mp4);
    const cleanPath = getCleanVideoPath(videoMp4);
    return join(BASE_PATH, cleanPath);
  } else {
    const showData = await getTVShowByName(showName);
    if (!showData) {
      throw new Error(`Show not found: ${showName}`);
    }
    const _season = showData.seasons[`Season ${season}`];
    const episodeKey = getEpisodeKey(showData, season, episode);
    const _episode = getEpisodeFilename(showData, season, episode);
    let specificFileName = null;

    if (_episode) {
      const fileNameFromEpisode = _season.episodes[episodeKey].filename;
      specificFileName = fileNameFromEpisode;
    } else {
      throw new Error(
        `Episode not found: ${showName} - Season ${season} Episode ${episode}`
      );
    }
    return join(`${BASE_PATH}/tv`, showName, `Season ${season}`, specificFileName);
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
      pattern = new RegExp(`^movie_${sanitizedName}_spritesheet_${shortUUID}_v\\d{4}\\.(avif|png)$`);
    } else {
      const sanitizedSeason = season.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const sanitizedEpisode = episode.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      pattern = new RegExp(`^tv_${sanitizedName}_${sanitizedSeason}_${sanitizedEpisode}_spritesheet_${shortUUID}_v\\d{4}\\.(avif|png)$`);
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

      // Process queued requests
      const queuedRequests = spriteSheetRequestQueues.get(fileKey) || [];
      spriteSheetRequestQueues.delete(fileKey);
      spriteSheetProcessingFiles.delete(fileKey);
      
      // Mark the process as completed
      const dbFinal = await getProcessTrackingDb();
      await finalizeProcessQueue(dbFinal, fileKey + "_spritesheet");
      await releaseDatabase(dbFinal);

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

    // Generate UUID-based VTT filename
    const sanitizedName = (movieName || showName).replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const shortUUID = videoUUID.substring(0, 8);
    const version = Math.floor(1.0001 * 10000).toString().padStart(4, '0'); // Use same version as SPRITE_VERSION
    
    let vttFileName;
    if (type === 'movies') {
      vttFileName = `movie_${sanitizedName}_spritesheet_${shortUUID}_v${version}.vtt`;
    } else {
      const sanitizedSeason = season.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const sanitizedEpisode = episode.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      vttFileName = `tv_${sanitizedName}_${sanitizedSeason}_${sanitizedEpisode}_spritesheet_${shortUUID}_v${version}.vtt`;
    }

    const vttFilePath = join(spritesheetCacheDir, vttFileName);

    if (await fileExists(vttFilePath)) {
      logger.info(`Serving UUID-based VTT file from cache: ${vttFileName}`);
      res.setHeader("Content-Type", "text/vtt");
      const fileStream = createReadStream(vttFilePath);
      await releaseDatabase(db);
      return fileStream.pipe(res);
    }

    logger.info(`UUID-based VTT file not found in cache: ${vttFileName}`);

    const fileKey =
      type === "movies"
        ? `movie_${movieName}`
        : `tv_${showName}_${season}_${episode}`;
        
    if (vttProcessingFiles.has(fileKey)) {
      logger.info(
        `VTT file ${fileKey} is already being processed. Adding request to queue.`
      );
      if (!vttRequestQueues.has(fileKey)) {
        vttRequestQueues.set(fileKey, []);
      }
      vttRequestQueues.get(fileKey).push(res);
      await releaseDatabase(db);
      return;
    }
    
    vttProcessingFiles.add(fileKey);

    // Create or update the queue record for the VTT process
    await createOrUpdateProcessQueue(
      processDB,
      fileKey + "_vtt",  // so we don't conflict with the sprite sheet queue
      "vtt",
      3, // total steps for VTT
      1, // start on step 1
      "in-progress",
      "Starting VTT generation"
    );

    // Create a queue for the spritesheet process
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

      // Generate sprite sheet and VTT with UUID versioning
      await generateSpriteSheet({
        videoPath,
        type,
        name: movieName || showName,
        season,
        episode,
        cacheDir: spritesheetCacheDir,
        onProgress: async (stepNumber, message) => {
          // Utility callback to track each step
          const dbInner = await getProcessTrackingDb();
          await updateProcessQueue(dbInner, fileKey + "_vtt", stepNumber, "in-progress", message);
          await updateProcessQueue(dbInner, fileKey + "_spritesheet", stepNumber, "in-progress", message);
          await releaseDatabase(dbInner);
        },
      });

      const finalizeDBqueue = await getProcessTrackingDb();
      // Finalize the queue
      await finalizeProcessQueue(finalizeDBqueue, fileKey + "_vtt", "completed", "VTT generation done");
      await finalizeProcessQueue(finalizeDBqueue, fileKey + "_spritesheet", "completed", "Spritesheet generation done");
      await releaseDatabase(finalizeDBqueue);

      vttProcessingFiles.delete(fileKey);

      if (await fileExists(vttFilePath)) {
        // Process queued requests
        const queuedRequests = vttRequestQueues.get(fileKey) || [];
        vttRequestQueues.delete(fileKey);
        queuedRequests.forEach((queuedRes) => {
          queuedRes.setHeader("Content-Type", "text/vtt");
          const fileStream = createReadStream(vttFilePath);
          fileStream.pipe(queuedRes);
        });

        // Stream the generated VTT file
        res.setHeader("Content-Type", "text/vtt");
        const fileStream = createReadStream(vttFilePath);
        fileStream.pipe(res);
      } else {
        vttProcessingFiles.delete(fileKey);
        res.status(500).send("Failed to generate VTT file");
      }
    } catch (error) {
      vttProcessingFiles.delete(fileKey);
      const dbErr = await getProcessTrackingDb();
      await finalizeProcessQueue(dbErr, fileKey + "_vtt", "error", error.message);
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
 * Setup sprite sheet routes with BASE_PATH dependency injection
 */
export function createSpriteRoutes(BASE_PATH) {
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

export default router;