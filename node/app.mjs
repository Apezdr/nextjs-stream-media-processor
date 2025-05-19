import express from "express";
import { scheduleJob } from "node-schedule";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import { join, resolve, basename, extname, dirname, normalize } from "path";
import { createReadStream } from "fs"; // Callback-based version of fs
import { promises as fs } from "fs"; // Use the promise-based version of fs
import compression from "compression";
import axios from "axios";
import { generateSpriteSheet, generateVttFileFFmpeg } from "./sprite.mjs";
import { initializeDatabase, insertOrUpdateMovie, getMovies, isDatabaseEmpty, getTVShows, insertOrUpdateTVShow, insertOrUpdateMissingDataMedia, getMissingDataMedia, deleteMovie, deleteTVShow, getMovieByName, getTVShowByName, releaseDatabase } from "./sqliteDatabase.mjs";
import { getMediaTypeHashes, getShowHashes, getSeasonHashes, generateMovieHashes, generateTVShowHashes, getHash } from "./sqlite/metadataHashes.mjs";
import { initializeBlurhashHashesTable, getHashesModifiedSince, generateMovieBlurhashHashes, generateTVShowBlurhashHashes, updateAllMovieBlurhashHashes, updateAllTVShowBlurhashHashes, getMovieBlurhashData, getTVShowBlurhashData } from "./sqlite/blurhashHashes.mjs";
import { setupRoutes } from "./routes/index.mjs";
import { generateFrame, fileExists, ensureCacheDirs, mainCacheDir, generalCacheDir, spritesheetCacheDir, framesCacheDir, findMp4File, getStoredBlurhash, calculateDirectoryHash, getLastModifiedTime, clearSpritesheetCache, clearFramesCache, clearGeneralCache, clearVideoClipsCache, convertToAvif, generateCacheKey, getEpisodeFilename, getEpisodeKey } from "./utils/utils.mjs";
import { generateChapters } from "./chapter-generator.mjs";
import { checkAutoSync, updateLastSyncTime, initializeIndexes, initializeMongoDatabase } from "./database.mjs";
import { handleVideoRequest, handleVideoClipRequest } from "./videoHandler.mjs";
import sharp from "sharp";
import { CURRENT_VERSION, getInfo } from "./infoManager.mjs";
import { fileURLToPath } from "url";
import { createCategoryLogger, getCategories } from "./lib/logger.mjs";
import chokidar from "chokidar";
import { createOrUpdateProcessQueue, finalizeProcessQueue, getAllProcesses, getProcessByFileKey, getProcessesWithFilters, getProcessTrackingDb, markInProgressAsInterrupted, removeInProgressProcesses, updateProcessQueue } from "./sqlite/processTracking.mjs";
import { chapterInfo } from "./ffmpeg/ffprobe.mjs";
import { TaskType, enqueueTask } from "./lib/taskManager.mjs";
import { createHash } from "crypto";
const logger = createCategoryLogger('main');
const __filename = fileURLToPath(import.meta.url); // Get __filename
const __dirname = dirname(__filename); // Get __dirname
const execAsync = promisify(exec);
const app = express();
//const { handleVideoRequest } = require("./videoHandler");
const logDirectory = resolve('logs');
const LOG_FILE = process.env.LOG_PATH
  ? join(process.env.LOG_PATH, "cron.log")
  : "/var/log/cron.log";
// Define the base path to the tv/movie folders
const BASE_PATH = process.env.BASE_PATH
  ? process.env.BASE_PATH
  : "/var/www/html";
// PREFIX_PATH is used to prefix the URL path for the server. Useful for reverse proxies.
const PREFIX_PATH = process.env.PREFIX_PATH || "";
const scriptsDir = resolve(__dirname, "../scripts");
// Moderately spaced out interval to check for missing data
const RETRY_INTERVAL_HOURS = 24; // Interval to retry downloading missing tmdb data

const generatePosterCollageScript = join(
  scriptsDir,
  "generate_poster_collage.py"
);
const downloadTmdbImagesScript = join(
  scriptsDir,
  "download_tmdb_images.py"
);
//const generateThumbnailJsonScript = path.join(scriptsDir, 'generate_thumbnail_json.sh');

const isDebugMode =
  process.env.DEBUG && process.env.DEBUG.toLowerCase() === "true";
const debugMessage = isDebugMode ? " [Debugging Enabled]" : "";
const CHROME_HEIGHT_LIMIT = 30780; // Chrome's maximum image height limit

// Used to validate the version supported by frontend
// To log a need to update code to support file server
const TV_LIST_VERSION = 1.0001;
const MOVIE_LIST_VERSION = 1.0000;

// Enable compression for all responses
app.use(compression());

ensureCacheDirs();

const langMap = {
  en: "English",
  eng: "English",
  es: "Spanish",
  spa: "Spanish",
  tl: "Tagalog",
  tgl: "Tagalog",
  zh: "Chinese",
  zho: "Chinese",
  cs: "Czech",
  cze: "Czech",
  da: "Danish",
  dan: "Danish",
  nl: "Dutch",
  dut: "Dutch",
  fi: "Finnish",
  fin: "Finnish",
  fr: "French",
  fre: "French",
  de: "German",
  ger: "German",
  el: "Greek",
  gre: "Greek",
  hu: "Hungarian",
  hun: "Hungarian",
  it: "Italian",
  ita: "Italian",
  ja: "Japanese",
  jpn: "Japanese",
  ko: "Korean",
  kor: "Korean",
  no: "Norwegian",
  nor: "Norwegian",
  pl: "Polish",
  pol: "Polish",
  pt: "Portuguese",
  por: "Portuguese",
  ro: "Romanian",
  ron: "Romanian",
  rum: "Romanian",
  sk: "Slovak",
  slo: "Slovak",
  sv: "Swedish",
  swe: "Swedish",
  tr: "Turkish",
  tur: "Turkish",
  ara: "Arabic",
  bul: "Bulgarian",
  chi: "Chinese",
  est: "Estonian",
  fin: "Finnish",
  fre: "French",
  ger: "German",
  gre: "Greek",
  heb: "Hebrew",
  hin: "Hindi",
  hun: "Hungarian",
  ind: "Indonesian",
  ita: "Italian",
  jpn: "Japanese",
  kor: "Korean",
  lav: "Latvian",
  lit: "Lithuanian",
  may: "Malay",
  nor: "Norwegian",
  pol: "Polish",
  por: "Portuguese",
  rus: "Russian",
  slo: "Slovak",
  slv: "Slovenian",
  spa: "Spanish",
  swe: "Swedish",
  tam: "Tamil",
  tel: "Telugu",
  tha: "Thai",
  tur: "Turkish",
  ukr: "Ukrainian",
  vie: "Vietnamese",
};

// Track Repeat Requests to avoid
// creating too many workers
const vttProcessingFiles = new Set();
const vttRequestQueues = new Map();
//
const spriteSheetProcessingFiles = new Set();
const spriteSheetRequestQueues = new Map();

app.get("/frame/movie/:movieName/:timestamp.:ext?", (req, res) => {
  handleFrameRequest(req, res, "movies");
});

app.get("/frame/tv/:showName/:season/:episode/:timestamp.:ext?", (req, res) => {
  handleFrameRequest(req, res, "tv");
});

async function handleFrameRequest(req, res, type) {
  let frameFileName,
    directoryPath,
    videoPath,
    specificFileName = null,
    wasCached = true;

  const { movieName, showName, season, episode, timestamp } = req.params;
  let movie_name = decodeURIComponent(movieName);
  let show_name = decodeURIComponent(showName);
  // Cant use `:` on Windows so replace with `-`
  const sanitizeTimestamp = timestamp.replace(/:/g, '-');

  if (type === "movies") {
    directoryPath = join(`${BASE_PATH}/movies`, movie_name);
    frameFileName = `movie_${movie_name}_${sanitizeTimestamp}.avif`;
  } else {
    // Extract episode number
    const episodeMatch =
      episode.match(/E(\d{1,2})/i) || episode.match(/^(\d{1,2})( -)?/);
    const episodeNumber = episodeMatch ? episodeMatch[1] : "Unknown"; // Default to 'Unknown' if not found

    directoryPath = join(`${BASE_PATH}/tv`, show_name, `Season ${season}`);
    frameFileName = `tv_${show_name}_S${season}E${episodeNumber}_${sanitizeTimestamp}.avif`;

    const db = await initializeDatabase();
    const showData = await getTVShowByName(db, show_name);
    await releaseDatabase(db);
    if (showData) {
      const _episode = getEpisodeFilename(showData, season, episode)
      specificFileName = _episode;
      } else {
        throw new Error(
          `Season not found: ${show_name} - Season ${season} Episode ${episode}`
        );
      }
  }

  const framePath = join(framesCacheDir, frameFileName);

  try {
    if (await fileExists(framePath)) {
      // Serve from cache if exists
      logger.info(`Serving cached frame: ${frameFileName}`);
    } else {
      wasCached = false;
      // Find the MP4 file dynamically
      videoPath = await findMp4File(directoryPath, specificFileName, framePath);

      // Generate the frame
      await generateFrame(videoPath, timestamp, framePath);
      logger.info(`Generated new frame: ${frameFileName}`);
    }

    res.set('Content-Disposition', 'inline');
    res.type('image/avif').sendFile(framePath);
  } catch (error) {
    logger.error(error);
    return res.status(404).send("Video file not found");
  }
}

//
// Sprite
//
app.get("/spritesheet/movie/:movieName", (req, res) => {
  handleSpriteSheetRequest(req, res, "movies");
});

app.get("/spritesheet/tv/:showName/:season/:episode", (req, res) => {
  handleSpriteSheetRequest(req, res, "tv");
});

app.get("/vtt/movie/:movieName", (req, res) => {
  handleVttRequest(req, res, "movies");
});

app.get("/vtt/tv/:showName/:season/:episode", (req, res) => {
  handleVttRequest(req, res, "tv");
});

async function getVideoPath(
  type,
  db,
  { movieName, showName, season, episode }
) {
  if (type === "movies") {
    const movie = await getMovieByName(db, movieName);
    if (!movie) {
      throw new Error(`Movie not found: ${movieName}`);
    }
    const videoMp4 = decodeURIComponent(JSON.parse(movie.urls).mp4);
    return join(BASE_PATH, videoMp4);
  } else {
    const showData = await getTVShowByName(db, showName);
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
 * Handles HTTP requests for sprite sheets, serving cached files and managing conversions.
 *
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {string} type - 'movies' or 'tv'.
 * @returns {Promise<void>}
 */
async function handleSpriteSheetRequest(req, res, type) {
  try {
    const db = await initializeDatabase();
    const processDB = await getProcessTrackingDb();
    const { movieName, showName, season, episode } = req.params;
    let spriteSheetFileName;

    if (type === "movies") {
      spriteSheetFileName = `movie_${movieName}_spritesheet`;
    } else if (type === "tv") {
      spriteSheetFileName = `tv_${showName}_${season}_${episode}_spritesheet`;
    }

    // Check both formats
    const avifPath = join(
      spritesheetCacheDir,
      spriteSheetFileName + ".avif"
    );
    const pngPath = join(
      spritesheetCacheDir,
      spriteSheetFileName + ".png"
    );

    let existingPath = null;
    let format = null;

    // First check if either format exists
    if (await fileExists(avifPath)) {
      existingPath = avifPath;
      format = "avif";
    } else if (await fileExists(pngPath)) {
      existingPath = pngPath;
      format = "png";
    }

    if (existingPath) {
      logger.info(`Serving existing sprite sheet: ${existingPath}`);

      // For PNG files, check dimensions to see if we should convert to AVIF
      if (format === "png") {
        try {
          const metadata = await sharp(existingPath).metadata();
          const shouldBeAvif = metadata.height <= CHROME_HEIGHT_LIMIT;

          if (shouldBeAvif && !(await fileExists(avifPath))) {
            // Attempt AVIF conversion in background
            res.setHeader("Cache-Control", "public, max-age=60");
            res.setHeader("Content-Type", "image/png");
            res.sendFile(existingPath);

            try {
              await convertToAvif(existingPath, avifPath, 60, 4, false);
              logger.info(
                `Background conversion to AVIF successful: ${avifPath}`
              );
            } catch (error) {
              logger.error("Background AVIF conversion failed:", error);
            }
            return;
          }
        } catch (error) {
          logger.error("Error checking PNG dimensions:", error);
        }
      }

      // Serve the file with appropriate headers
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader(
        "Content-Type",
        format === "avif" ? "image/avif" : "image/png"
      );
      if (format === "avif") {
        res.setHeader("Accept-Ranges", "bytes");
      }
      return res.sendFile(existingPath);
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
      return;
    }

    spriteSheetProcessingFiles.add(fileKey);
    
    // -- Step 0: Create a process queue entry with totalSteps = 3
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
      // Get video path logic...
      const videoPath = await getVideoPath(type, db, {
        movieName,
        showName,
        season,
        episode,
      });
      await releaseDatabase(db);

      // Generate sprite sheet
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
      // -- Mark the process as completed
      const dbFinal = await initializeDatabase();
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
      const dbErr = await initializeDatabase();
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

async function handleVttRequest(req, res, type) {
  const db = await initializeDatabase();
  const processDB = await getProcessTrackingDb();
  const { movieName, showName, season, episode } = req.params;
  let vttFileName;

  if (type === "movies") {
    vttFileName = `movie_${movieName}_spritesheet.vtt`;
  } else if (type === "tv") {
    vttFileName = `tv_${showName}_${season}_${episode}_spritesheet.vtt`;
  }

  const vttFilePath = join(spritesheetCacheDir, vttFileName);

  try {
    if (await fileExists(vttFilePath)) {
      logger.info(`Serving VTT file from cache: ${vttFileName}`);
      res.setHeader("Content-Type", "text/vtt");
      const fileStream = createReadStream(vttFilePath);
      fileStream.pipe(res);
    } else {
      logger.info(`VTT file not found in cache: ${vttFileName}`);

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

      // Generate the VTT file
      let videoPath;
      if (type === "movies") {
        const movie = await getMovieByName(db, movieName);
        if (!movie) {
          vttProcessingFiles.delete(fileKey);
          return res.status(404).send(`Movie not found: ${movieName}`);
        }
        let videoMp4 = movie.urls.mp4;
        videoMp4 = decodeURIComponent(videoMp4);
        videoPath = join(BASE_PATH, videoMp4);
        // await generateSpriteSheet({
        //   videoPath,
        //   type,
        //   name: movieName,
        //   cacheDir: spritesheetCacheDir,
        // });
      } else if (type === "tv") {
        try {
          const shows = await getTVShows(db);
          const showData = shows.find((show) => show.name === showName);
          if (showData) {
            const _season = showData.seasons[`Season ${season}`];
            if (_season) {
              const episodeKey = getEpisodeKey(showData, season, episode);
              
              if (episodeKey) {
                const episodeVideo = _season.episodes[episodeKey].filename;
                const directoryPath = join(
                  `${BASE_PATH}/tv`,
                  showName,
                  `Season ${season}`
                );
                videoPath = join(directoryPath, episodeVideo);
              } else {
                throw new Error(
                  `Episode not found: ${showName} - Season ${season} Episode ${episode}`
                );
              }
            } else {
              throw new Error(
                `Season not found: ${showName} - Season ${season} Episode ${episode}`
              );
            }
          } else {
            throw new Error(`Show not found: ${showName}`);
          }
        } catch (error) {
          logger.error(`Error accessing tv db data: ${error.message}`);
          vttProcessingFiles.delete(fileKey);
          return res.status(500).send("Internal server error");
        }
      }

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
      }
    }
  } catch (error) {
    logger.error(error);
    res.status(500).send("Internal server error");
  }
}

// Handle Chapter Requests
app.get("/chapters/movie/:movieName", async (req, res) => {
  await handleChapterRequest(req, res, "movies");
});

app.get("/chapters/tv/:showName", async (req, res) => {
  await handleChapterRequest(req, res, "tv", true);
});

app.get("/chapters/tv/:showName/:season/:episode", async (req, res) => {
  await handleChapterRequest(req, res, "tv");
});

async function handleChapterRequest(
  req,
  res,
  type,
  generateAllChapters = false
) {
  const db = await initializeDatabase();
  const { movieName, showName, season, episode } = req.params;
  let chapterFileName, mediaPath, chapterFilePath;

  if (type === "movies") {
    const movie = await db.get("SELECT * FROM movies WHERE name = ?", [
      movieName,
    ]);
    if (!movie) {
      return res.status(404).send(`Movie not found: ${movieName}`);
    }
    let videoMp4 = JSON.parse(movie.urls).mp4;
    videoMp4 = decodeURIComponent(videoMp4);
    let videoPath = join(BASE_PATH, videoMp4);
    const movieFileName = basename(videoPath, extname(videoPath));
    chapterFileName = `${movieFileName}_chapters.vtt`;
    mediaPath = join(
      `${BASE_PATH}/movies`,
      movieName,
      `${movieFileName}.mp4`
    );
    chapterFilePath = join(
      `${BASE_PATH}/movies`,
      movieName,
      "chapters",
      chapterFileName
    );
    await generateChapterFileIfNotExists(chapterFilePath, mediaPath);
  } else if (type === "tv") {
    if (generateAllChapters) {
      const shows = await getTVShows(db);
      const showData = shows.find((show) => show.name === showName);

      if (showData) {
        for (const seasonName in showData.seasons) {
          const season = showData.seasons[seasonName];
          for (const episodeKey in season.episodes) {
            const episode = season.episodes[episodeKey];
            const episodeFileName = episode.filename;
            
            // Extract episode number from the episode key (SxxEyy format)
            const episodeMatch = episodeKey.match(/E(\d+)/i);
            const episodeNumber = episodeMatch ? episodeMatch[1] : null;
            
            if (!episodeNumber) {
              logger.warn(`Could not extract episode number from ${episodeKey}, skipping`);
              continue;
            }
            
            const seasonNumber = seasonName.replace("Season ", "");
            const chapterFilePath = join(
              `${BASE_PATH}/tv`,
              showName,
              seasonName,
              "chapters",
              `${showName} - S${seasonNumber.padStart(
                2,
                "0"
              )}E${episodeNumber.padStart(2, "0")}_chapters.vtt`
            );
            const directoryPath = join(
              `${BASE_PATH}/tv`,
              showName,
              seasonName
            );
            const mediaPath = join(directoryPath, episodeFileName);

            await generateChapterFileIfNotExists(chapterFilePath, mediaPath, true); // Use quietMode for bulk operations
          }
        }

        return res.status(200).send("Chapter files generated successfully");
      } else {
        return res.status(404).send(`Show not found: ${showName}`);
      }
    }
    if (!season && !episode) {
      const shows = await getTVShows(db);
      const showData = shows.find((show) => show.name === showName);

      if (showData) {
        for (const seasonName in showData.seasons) {
          const season = showData.seasons[seasonName];
          for (const episodeKey in season.episodes) {
            const episode = season.episodes[episodeKey];
            const episodeFileName = episode.filename;
            
            // Extract episode number from the episode key (SxxEyy format)
            const episodeMatch = episodeKey.match(/E(\d+)/i);
            const episodeNumber = episodeMatch ? episodeMatch[1] : null;
            
            if (!episodeNumber) {
              logger.warn(`Could not extract episode number from ${episodeKey}, skipping`);
              continue;
            }
            
            const seasonNumber = seasonName.replace("Season ", "");
            const chapterFilePath = join(
              `${BASE_PATH}/tv`,
              showName,
              seasonName,
              "chapters",
              `${showName} - S${seasonNumber.padStart(
                2,
                "0"
              )}E${episodeNumber.padStart(2, "0")}_chapters.vtt`
            );
            const directoryPath = join(
              `${BASE_PATH}/tv`,
              showName,
              seasonName
            );
            const mediaPath = join(directoryPath, episodeFileName);

            await generateChapterFileIfNotExists(chapterFilePath, mediaPath, true); // Use quietMode for bulk operations
          }
        }

        return res.status(200).send("Chapter files generated successfully");
      } else {
        return res.status(404).send(`Show not found: ${showName}`);
      }
    } else {
      const directoryPath = join(
        `${BASE_PATH}/tv`,
        showName,
        `Season ${season}`
      );
      const episodeNumber = episode.padStart(2, "0");
      const seasonNumber = season.padStart(2, "0");
      chapterFileName = `${showName} - S${seasonNumber}E${episodeNumber}_chapters.vtt`;
      chapterFilePath = join(directoryPath, "chapters", chapterFileName);

      try {
        const mp4Files = await fs.readdir(directoryPath);
        const mp4File = mp4Files.find(
          (file) =>
            file.includes(`S${seasonNumber}E${episodeNumber}`) &&
            file.endsWith(".mp4")
        );

        if (mp4File) {
          mediaPath = join(directoryPath, mp4File);
        } else {
          logger.error(
            `Associated MP4 file not found for ${showName} - S${seasonNumber}E${episodeNumber}`
          );
          return res.status(404).send("Associated MP4 file not found");
        }
      } catch (error) {
        logger.error(
          `Error accessing directory or reading its contents: ${directoryPath}`,
          error
        );
        return res.status(500).send("Internal server error");
      }
    }
  }

  await releaseDatabase(db);
  await generateChapterFileIfNotExists(chapterFilePath, mediaPath);

  res.setHeader("Content-Type", "text/vtt");
  res.sendFile(chapterFilePath);
}

function getEpisodeNumber(episodeFileName) {
  const match = episodeFileName.match(/E(\d+)/i);
  return match ? match[1] : null;
}

async function generateChapterFileIfNotExists(chapterFilePath, mediaPath, quietMode = false) {
  try {
    if (await fileExists(chapterFilePath)) {
      if (!quietMode) {
        logger.info(
          `Serving chapter file from cache: ${basename(chapterFilePath)}`
        );
      }
    } else {
      if (!quietMode) {
        logger.info(
          `Chapter file not found in cache: ${basename(chapterFilePath)}`
        );
      }

      // Check if the media file has chapter information
      const hasChapters = await chapterInfo(mediaPath);

      if (hasChapters) {
        // Create the chapters directory if it doesn't exist
        await fs.mkdir(dirname(chapterFilePath), { recursive: true });

        // If the media file has chapter information, generate the chapter file
        const chapterContent = await generateChapters(mediaPath);

        // Save the generated chapter content to the file
        await fs.writeFile(chapterFilePath, chapterContent);
        if (!quietMode) {
          logger.info("The file has been saved!");
        }
      } else {
        // If the media file doesn't have chapter information, send a 404 response
        if (!quietMode) {
          logger.warn(
            `Chapter information not found for ${basename(mediaPath)}`
          );
        }
      }
    }
  } catch (error) {
    if (error.code === "EACCES") {
      logger.error(
        `Permission denied while accessing ${chapterFilePath}.\nPlease check the directory permissions.`,
        error
      );
    } else {
      logger.error(
        `Error generating chapter file for ${basename(mediaPath)}:`,
        error
      );
    }
  }
}

/**
 * GET /processes
 * Retrieves the current process queue information in JSON format.
 * Optional query parameters:
 * - processType: Filter by process_type (e.g., "spritesheet", "vtt")
 * - status: Filter by status (e.g., "in-progress", "queued", "completed", "error")
 */
app.get('/processes', async (req, res) => {
  try {
    const db = await getProcessTrackingDb();

    // Extract query parameters for filtering
    const { processType, status } = req.query;

    let processes;
    if (processType || status) {
      // Use the filtered retrieval function
      processes = await getProcessesWithFilters(db, { processType, status });
    } else {
      // Retrieve all processes
      processes = await getAllProcesses(db);
    }

    await releaseDatabase(db);

    res.json({ success: true, data: processes });
  } catch (error) {
    logger.error(`Error fetching processes: ${error.message}`);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

/**
 * GET /processes/:fileKey
 * Retrieves the process information for a specific fileKey.
 */
app.get('/processes/:fileKey', async (req, res) => {
  try {
    const { fileKey } = req.params;
    const db = await getProcessTrackingDb();

    const process = await getProcessByFileKey(db, fileKey);

    await releaseDatabase(db);

    if (process) {
      res.json({ success: true, data: process });
    } else {
      res.status(404).json({ success: false, message: 'Process not found' });
    }
  } catch (error) {
    logger.error(`Error fetching process ${req.params.fileKey}: ${error.message}`);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
});

//
// Handle MP4 video requests
// Enhanced to allow transcoding with video codec desired as well as audio channels exposed
app.get("/video/movie/:movieName", async (req, res) => {
  const db = await initializeDatabase();
  await handleVideoRequest(req, res, "movies", BASE_PATH, db);
  await releaseDatabase(db);
});

app.get("/rescan/tmdb", async (req, res) => {
  try {
    await runDownloadTmdbImages(null, null, true);
    res.status(200).send("Rescan initiated");
  } catch (error) {
    logger.error(error);
    res.status(500).send("Rescan Failed: Internal server error");
  }
});

app.get("/video/tv/:showName/:season/:episode", async (req, res) => {
  const db = await initializeDatabase();
  await handleVideoRequest(req, res, "tv", BASE_PATH, db);
  await releaseDatabase(db);
});

// Instead of using setInterval for cache cleanup, use node-schedule with the task manager
// This gives better coordination with other tasks and avoids database contention

// Clear General Cache every 30 minutes (at 00 and 30 minutes past each hour)
scheduleJob("0,30 * * * *", () => {
  enqueueTask(TaskType.CACHE_CLEANUP, 'General Cache Cleanup', async () => {
    logger.info("Running General Cache Cleanup...");
    await clearGeneralCache();
    logger.info("General Cache Cleanup Completed.");
    return 'General cache cleanup completed successfully';
  }).catch(error => {
    logger.error(`Failed to enqueue general cache cleanup task: ${error.message}`);
  });
});

// Clear Video Clips Cache at 1:15 AM daily
scheduleJob("15 1 * * *", () => {
  enqueueTask(TaskType.CACHE_CLEANUP, 'Video Clips Cache Cleanup', async () => {
    logger.info("Running Video Clips Cache Cleanup...");
    await clearVideoClipsCache();
    logger.info("Video Clips Cache Cleanup Completed.");
    return 'Video clips cache cleanup completed successfully';
  }).catch(error => {
    logger.error(`Failed to enqueue video clips cache cleanup task: ${error.message}`);
  });
});

// Clear Spritesheet Cache at 2:15 AM daily
scheduleJob("15 2 * * *", () => {
  enqueueTask(TaskType.CACHE_CLEANUP, 'Spritesheet Cache Cleanup', async () => {
    logger.info("Running Spritesheet Cache Cleanup...");
    await clearSpritesheetCache();
    logger.info("Spritesheet Cache Cleanup Completed.");
    return 'Spritesheet cache cleanup completed successfully';
  }).catch(error => {
    logger.error(`Failed to enqueue spritesheet cache cleanup task: ${error.message}`);
  });
});

// Clear Frames Cache at 3:15 AM daily
scheduleJob("15 3 * * *", () => {
  enqueueTask(TaskType.CACHE_CLEANUP, 'Frames Cache Cleanup', async () => {
    logger.info("Running Frames Cache Cleanup...");
    await clearFramesCache();
    logger.info("Frames Cache Cleanup Completed.");
    return 'Frames cache cleanup completed successfully';
  }).catch(error => {
    logger.error(`Failed to enqueue frames cache cleanup task: ${error.message}`);
  });
});

// Update blurhash hashes every 18 minutes to stagger from other tasks
// Use a scheduled job instead of setInterval for better precision and to coordinate with other scheduled tasks
scheduleJob("8,26,44 * * * *", () => { // At 8, 26, and 44 minutes past each hour
  // Use the task manager to handle concurrency and database access
  enqueueTask(TaskType.BLURHASH_GENERATION, 'Blurhash Hashes Update', async () => {
    logger.info("Running Blurhash Hashes Update...");
    const db = await initializeDatabase();
    
    try {
      // Use a timestamp to track changes since last scan
      const lastScanTime = new Date();
      lastScanTime.setMinutes(lastScanTime.getMinutes() - 18); // Only process files modified in the last 18 minutes
      const sinceTimestamp = lastScanTime.toISOString();
      
      // Process movies first in a controlled manner
      logger.info("Starting blurhash update for movies...");
      await updateAllMovieBlurhashHashes(db, BASE_PATH, sinceTimestamp);
      logger.info("Movie blurhash hashes completed, processing TV shows...");
      
      // Then process TV shows
      await updateAllTVShowBlurhashHashes(db, BASE_PATH, sinceTimestamp);
      logger.info("Blurhash Hashes Update Completed.");
      
      return 'Blurhash update completed successfully';
    } catch (error) {
      logger.error(`Blurhash Hashes Update Error: ${error.message}`);
      throw error; // Let task manager handle the error
    } finally {
      await releaseDatabase(db);
    }
  }).catch(error => {
    logger.error(`Failed to enqueue blurhash task: ${error.message}`);
  });
});
//
// End Cache Management
async function generateListTV(db, dirPath) {
  const shows = await fs.readdir(dirPath, { withFileTypes: true });
  const missingDataMedia = await getMissingDataMedia(db);
  const now = new Date();

  // Get the list of TV shows currently in the database
  const existingShows = await getTVShows(db);
  const existingShowNames = new Set(existingShows.map((show) => show.name));

  // Start a transaction for batch updates
  await db.run("BEGIN TRANSACTION");

  try {
    for (let index = 0; index < shows.length; index++) {
      const show = shows[index];
      if (isDebugMode) {
        logger.info(`Processing show: ${show.name}: ${index + 1} of ${shows.length}`);
      }
      if (!show.isDirectory()) continue; // Skip if not a directory

      const showName = show.name;
      existingShowNames.delete(showName); // Remove from the set of existing shows
      const encodedShowName = encodeURIComponent(showName);
      const showPath = normalize(join(dirPath, showName));
      const allItems = await fs.readdir(showPath, { withFileTypes: true });
      const seasonFolders = allItems.filter(
        (item) => item.isDirectory() && item.name.startsWith("Season")
      );
      const sortedSeasonFolders = seasonFolders.sort((a, b) => {
        const aNum = parseInt(a.name.replace("Season", ""));
        const bNum = parseInt(b.name.replace("Season", ""));
        return aNum - bNum;
      });
      const otherItems = allItems.filter((item) => !seasonFolders.includes(item));
      const seasons = [...sortedSeasonFolders, ...otherItems];

      // Initialize individual fields
      let metadataUrl = "";
      let metadata = "";
      let poster = "";
      let posterBlurhash = "";
      let logo = "";
      let logoBlurhash = "";
      let backdrop = "";
      let backdropBlurhash = "";

      // Initialize runDownloadTmdbImagesFlag
      let runDownloadTmdbImagesFlag = false;

      // Handle show poster
      const posterPath = join(showPath, "show_poster.jpg");
      if (await fileExists(posterPath)) {
        const posterStats = await fs.stat(posterPath);
        const posterImageHash = createHash('md5').update(posterStats.mtime.toISOString()).digest('hex').substring(0, 10);
        poster = `${PREFIX_PATH}/tv/${encodedShowName}/show_poster.jpg?hash=${posterImageHash}`;
        const blurhash = await getStoredBlurhash(posterPath, BASE_PATH);
        if (blurhash) {
          posterBlurhash = blurhash;
        }
      } else {
        runDownloadTmdbImagesFlag = true;
      }

      // Handle show logo
      const logoExtensions = ["svg", "jpg", "png", "gif"];
      let logoFound = false;
      for (const ext of logoExtensions) {
        const logoPath = join(showPath, `show_logo.${ext}`);
        if (await fileExists(logoPath)) {
          const logoStats = await fs.stat(logoPath);
          const logoImageHash = createHash('md5').update(logoStats.mtime.toISOString()).digest('hex').substring(0, 10);
          logo = `${PREFIX_PATH}/tv/${encodedShowName}/show_logo.${ext}?hash=${logoImageHash}`;
          if (ext !== "svg") {
            const blurhash = await getStoredBlurhash(logoPath, BASE_PATH);
            if (blurhash) {
              logoBlurhash = blurhash;
            }
          }
          logoFound = true;
          break;
        }
      }
      if (!logoFound) {
        runDownloadTmdbImagesFlag = true;
      }

      // Handle show backdrop
      const backdropExtensions = ["jpg", "png", "gif"];
      let backdropFound = false;
      for (const ext of backdropExtensions) {
        const backdropPath = join(showPath, `show_backdrop.${ext}`);
        if (await fileExists(backdropPath)) {
          const backdropStats = await fs.stat(backdropPath);
          const backdropImageHash = createHash('md5').update(backdropStats.mtime.toISOString()).digest('hex').substring(0, 10);
          backdrop = `${PREFIX_PATH}/tv/${encodedShowName}/show_backdrop.${ext}?hash=${backdropImageHash}`;
          const blurhash = await getStoredBlurhash(backdropPath, BASE_PATH);
          if (blurhash) {
            backdropBlurhash = blurhash;
          }
          backdropFound = true;
          break;
        }
      }
      if (!backdropFound) {
        runDownloadTmdbImagesFlag = true;
      }

      // Check for metadata.json
      const metadataFilePath = join(showPath, "metadata.json");
      if (!(await fileExists(metadataFilePath))) {
        runDownloadTmdbImagesFlag = true;
      } else {
        metadataUrl = `${PREFIX_PATH}/tv/${encodedShowName}/metadata.json`
        // metadata
        metadata = JSON.stringify(JSON.parse(await fs.readFile(metadataFilePath, 'utf8')))
      }

      // Handle missing data attempts
      const missingDataShow = missingDataMedia.find((media) => media.name === showName);
      if (missingDataShow) {
        const lastAttempt = new Date(missingDataShow.lastAttempt);
        const hoursSinceLastAttempt = (now - lastAttempt) / (1000 * 60 * 60);
        if (hoursSinceLastAttempt >= RETRY_INTERVAL_HOURS) {
          runDownloadTmdbImagesFlag = true;
        } else {
          runDownloadTmdbImagesFlag = false;
        }
      }

      if (runDownloadTmdbImagesFlag) {
        await insertOrUpdateMissingDataMedia(db, showName);
        await runDownloadTmdbImages(showName);
        const retryFiles = await fs.readdir(showPath);
        const retryFileSet = new Set(retryFiles);

        // Retry poster
        if (retryFileSet.has("show_poster.jpg")) {
          const posterPath = join(showPath, "show_poster.jpg");
          const posterStats = await fs.stat(posterPath);
          const posterImageHash = createHash('md5').update(posterStats.mtime.toISOString()).digest('hex').substring(0, 10);
          poster = `${PREFIX_PATH}/tv/${encodedShowName}/show_poster.jpg?hash=${posterImageHash}`;
          const blurhash = await getStoredBlurhash(posterPath, BASE_PATH);
          if (blurhash) {
            posterBlurhash = blurhash;
          }
        }

        // Retry logo
        for (const ext of logoExtensions) {
          const logoPath = join(showPath, `show_logo.${ext}`);
          if (retryFileSet.has(`show_logo.${ext}`)) {
            const logoStats = await fs.stat(logoPath);
            const logoImageHash = createHash('md5').update(logoStats.mtime.toISOString()).digest('hex').substring(0, 10);
            logo = `${PREFIX_PATH}/tv/${encodedShowName}/show_logo.${ext}?hash=${logoImageHash}`;
            if (ext !== "svg") {
              const blurhash = await getStoredBlurhash(logoPath, BASE_PATH);
              if (blurhash) {
                logoBlurhash = blurhash;
              }
            }
            break;
          }
        }

        // Retry backdrop
        for (const ext of backdropExtensions) {
          const backdropPath = join(showPath, `show_backdrop.${ext}`);
          if (retryFileSet.has(`show_backdrop.${ext}`)) {
            const backdropStats = await fs.stat(backdropPath);
            const backdropImageHash = createHash('md5').update(backdropStats.mtime.toISOString()).digest('hex').substring(0, 10);
            backdrop = `${PREFIX_PATH}/tv/${encodedShowName}/show_backdrop.${ext}?hash=${backdropImageHash}`;
            const blurhash = await getStoredBlurhash(backdropPath, BASE_PATH);
            if (blurhash) {
              backdropBlurhash = blurhash;
            }
            break;
          }
        }
      }

      // Initialize seasons object
      const seasonsObj = {};

      // Process each season
      await Promise.all(
        seasons.map(async (season) => {
          if (!season.isDirectory()) return;

          const seasonName = season.name;
          const encodedSeasonName = encodeURIComponent(seasonName);
          const seasonPath = join(showPath, seasonName);
          const seasonNumberMatch = seasonName.match(/\d+/);
          const seasonNumber = seasonNumberMatch ? seasonNumberMatch[0].padStart(2, "0") : "00";

          const episodes = await fs.readdir(seasonPath);
          const validEpisodes = episodes.filter(
            (episode) => episode.endsWith(".mp4") && !episode.includes("-TdarrCacheFile-")
          );
          if (validEpisodes.length === 0) return;

          // Restructure to use episodeKey = SxxExx
          const seasonData = {
            episodes: {},
            lengths: {},
            dimensions: {},
            seasonNumber: parseInt(seasonNumber, 10)
          };

          // Handle season poster
          const seasonPosterPath = join(seasonPath, "season_poster.jpg");
          if (await fileExists(seasonPosterPath)) {
            const seasonPosterStats = await fs.stat(seasonPosterPath);
            const seasonPosterImageHash = createHash('md5').update(seasonPosterStats.mtime.toISOString()).digest('hex').substring(0, 10);
            seasonData.season_poster = `${PREFIX_PATH}/tv/${encodedShowName}/${encodedSeasonName}/season_poster.jpg?hash=${seasonPosterImageHash}`;
            const blurhash = await getStoredBlurhash(seasonPosterPath, BASE_PATH);
            if (blurhash) {
              seasonData.seasonPosterBlurhash = blurhash;
            }
          }

          for (const episode of validEpisodes) {
            const episodePath = join(seasonPath, episode);
            const encodedEpisodePath = encodeURIComponent(episode);

            let fileLength;
            let fileDimensions;
            let hdrInfo;
            let mediaQuality;
            let additionalMetadata;
            let uuid;

            try {
              const info = await getInfo(episodePath);
              fileLength = info.length;
              fileDimensions = info.dimensions;
              hdrInfo = info.hdr;
              mediaQuality = info.mediaQuality;
              additionalMetadata = info.additionalMetadata;
              uuid = info.uuid;
            } catch (error) {
              logger.error(`Failed to retrieve info for ${episodePath}:`, error);
            }

            // Extract episode number
            const episodeNumberMatch = episode.match(/S\d+E(\d+)/i);
            const episodeNumber = episodeNumberMatch ? episodeNumberMatch[1] : (episode.match(/\d+/) || ["0"])[0];
            if (!episodeNumber || !seasonNumber) {
              logger.warn(`Could not extract episode or season number from ${episode}, skipping.`);
              continue;
            }

            const paddedEpisodeNumber = episodeNumber.padStart(2, "0");
            const episodeKey = `S${seasonNumber}E${paddedEpisodeNumber}`;

            // Store length/dimensions keyed by episodeKey
            seasonData.lengths[episodeKey] = parseInt(fileLength, 10);
            seasonData.dimensions[episodeKey] = fileDimensions;

            const episodeData = {
              _id: uuid,
              filename: episode, // store original filename for reference
              videoURL: `${PREFIX_PATH}/tv/${encodedShowName}/${encodedSeasonName}/${encodedEpisodePath}`,
              mediaLastModified: (await fs.stat(episodePath)).mtime.toISOString(),
              hdr: hdrInfo || null,
              mediaQuality: mediaQuality || null,
              additionalMetadata: additionalMetadata || {},
              episodeNumber: parseInt(episodeNumber, 10),
            };

            // Handle thumbnail
            const thumbnailPath = join(seasonPath, `${episodeNumber} - Thumbnail.jpg`);
            if (await fileExists(thumbnailPath)) {
              const thumbnailStats = await fs.stat(thumbnailPath);
              const thumbnailImageHash = createHash('md5').update(thumbnailStats.mtime.toISOString()).digest('hex').substring(0, 10);
              episodeData.thumbnail = `${PREFIX_PATH}/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(
                `${episodeNumber} - Thumbnail.jpg`
              )}?hash=${thumbnailImageHash}`;
              const blurhash = await getStoredBlurhash(thumbnailPath, BASE_PATH);
              if (blurhash) {
                episodeData.thumbnailBlurhash = blurhash;
              }
            }

            // Handle episode metadata
            const episodeMetadataPath = join(seasonPath, `${episodeNumber}_metadata.json`);
            if (await fileExists(episodeMetadataPath)) {
              episodeData.metadata = `${PREFIX_PATH}/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(
                `${episodeNumber}_metadata.json`
              )}`;
            }

            // Handle chapters
            const chaptersPath = join(
              seasonPath,
              "chapters",
              `${showName} - S${seasonNumber}E${paddedEpisodeNumber}_chapters.vtt`
            );
            
            // Generate chapter file before checking if it exists
            await generateChapterFileIfNotExists(chaptersPath, episodePath, true); // Use quietMode for bulk operations
            
            if (await fileExists(chaptersPath)) {
              episodeData.chapters = `${PREFIX_PATH}/tv/${encodedShowName}/${encodedSeasonName}/chapters/${encodeURIComponent(
                `${showName} - S${seasonNumber}E${paddedEpisodeNumber}_chapters.vtt`
              )}`;
            }

            // Generate a Unique ID for each episode
            // if (episodeNumber && seasonNumber && showName) {
            //   episodeData._id = generateCacheKey(`${showName.toLowerCase()}_S${seasonNumber}E${episodeNumber}`);
            // }

            // Find subtitles
            const subtitleFiles = await fs.readdir(seasonPath);
            const subtitles = {};
            for (const subtitleFile of subtitleFiles) {
              if (
                subtitleFile.startsWith(episode.replace(".mp4", "")) &&
                subtitleFile.endsWith(".srt")
              ) {
                const parts = subtitleFile.split(".");
                const srtIndex = parts.lastIndexOf("srt");
                const isHearingImpaired = parts[srtIndex - 1] === "hi";
                const langCode = isHearingImpaired
                  ? parts[srtIndex - 2]
                  : parts[srtIndex - 1];
                const langName = langMap[langCode] || langCode;
                const subtitleKey = isHearingImpaired
                  ? `${langName} Hearing Impaired`
                  : langName;
                subtitles[subtitleKey] = {
                  url: `${PREFIX_PATH}/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(
                    subtitleFile
                  )}`,
                  srcLang: langCode,
                  lastModified: (await fs.stat(join(seasonPath, subtitleFile))).mtime.toISOString(),
                };
              }
            }
            if (Object.keys(subtitles).length > 0) {
              episodeData.subtitles = subtitles;
            }

            // Store episode data under canonical episodeKey
            seasonData.episodes[episodeKey] = episodeData;
          }

          // Process all thumbnails to ensure blurhash is generated (optional)
          const thumbnailFiles = episodes.filter((file) =>
            file.endsWith(" - Thumbnail.jpg")
          );
          for (const thumbnailFile of thumbnailFiles) {
            const thumbnailPath = join(seasonPath, thumbnailFile);
            // Even if we don't store them by filename now, we ensure blurhash is available.
            await getStoredBlurhash(thumbnailPath, BASE_PATH);
          }
          
          seasonsObj[seasonName] = seasonData;
        })
      );

      // Sort seasons
      const sortedSeasons = Object.fromEntries(
        Object.entries(seasonsObj).sort((a, b) => {
          // Extract numbers from season names and pad with zeros for proper string comparison
          const seasonA = a[0].match(/\d+/)?.[0].padStart(3, '0') || '000';
          const seasonB = b[0].match(/\d+/)?.[0].padStart(3, '0') || '000';
          return seasonA.localeCompare(seasonB);
        })
      );

      // Prepare individual fields for insertion
      const seasonsFinal = sortedSeasons;

      // Extract and store file paths for direct access
      const posterFilePath = await fileExists(join(showPath, "show_poster.jpg")) ? 
                             join(showPath, "show_poster.jpg") : null;
      
      let logoFilePath = null;
      for (const ext of logoExtensions) {
        const logoPath = join(showPath, `show_logo.${ext}`);
        if (await fileExists(logoPath)) {
          logoFilePath = logoPath;
          break;
        }
      }
      
      let backdropFilePath = null;
      for (const ext of backdropExtensions) {
        const backdropPath = join(showPath, `show_backdrop.${ext}`);
        if (await fileExists(backdropPath)) {
          backdropFilePath = backdropPath;
          break;
        }
      }

      await insertOrUpdateTVShow(
        db,
        showName,
        metadata,
        metadataUrl,
        poster,
        posterBlurhash,
        logo,
        logoBlurhash,
        backdrop,
        backdropBlurhash,
        seasonsFinal,
        posterFilePath,
        backdropFilePath,
        logoFilePath,
        BASE_PATH // Store the base path for future reference
      );
    }

    // Remove TV shows from the database that no longer exist in the file system
    for (const showName of existingShowNames) {
      await deleteTVShow(db, showName);
    }

    // Commit the transaction after all operations are done
    await db.run("COMMIT");
  } catch (error) {
    // Rollback the transaction in case of error
    await db.run("ROLLBACK");
    logger.error("Error during database update:", error);
  }
}

app.get("/media/tv", async (req, res) => {
  try {
    const db = await initializeDatabase();
    if (await isDatabaseEmpty(db, "tv_shows")) {
      await generateListTV(db, `${BASE_PATH}/tv`);
    }
    const shows = await getTVShows(db);
    await releaseDatabase(db);

    const tvData = shows.reduce((acc, show) => {
      acc[show.name] = {
        metadata: show.metadata_path,
        poster: show.poster,
        posterBlurhash: show.posterBlurhash,
        logo: show.logo,
        logoBlurhash: show.logoBlurhash,
        backdrop: show.backdrop,
        backdropBlurhash: show.backdropBlurhash,
        seasons: show.seasons,
      };
      return acc;
    }, {});

    res.json({ ...tvData, version: TV_LIST_VERSION });
  } catch (error) {
    logger.error(`Error fetching TV shows: ${error}`);
    res.status(500).send("Internal server error");
  }
});

async function generateListMovies(db, dirPath) {
  const dirs = await fs.readdir(dirPath, { withFileTypes: true });
  const missingDataMovies = await getMissingDataMedia(db);
  const now = new Date();

  // Get the list of movies currently in the database
  const existingMovies = await getMovies(db);
  const existingMovieNames = new Set(existingMovies.map((movie) => movie.name));

  await Promise.all(
    dirs.map(async (dir, index) => {
      if (isDebugMode) {
        logger.info(
          `Processing movie: ${dir.name}: ${index + 1} of ${dirs.length}`
        );
      }
      if (dir.isDirectory()) {
        const dirName = dir.name;
        const fullDirPath = join(dirPath, dirName);
        const files = await fs.readdir(join(dirPath, dirName));
        const hash = await calculateDirectoryHash(fullDirPath);

        const existingMovie = await db.get(
          "SELECT * FROM movies WHERE name = ?",
          [dirName]
        );
        existingMovieNames.delete(dirName); // Remove from the set of existing movies
        const dirHashChanged =
          existingMovie && existingMovie.directory_hash !== hash;

        // Check if we need to regenerate info files due to version updates
        let needInfoRegeneration = false;
        if (!dirHashChanged && existingMovie) {
          // Even if directory hasn't changed, we still need to check if info files need to be regenerated
          // Find all mp4 files and check if their info files need updating
          const mp4Files = files.filter(file => file.endsWith('.mp4'));
          
          for (const mp4File of mp4Files) {
            const filePath = join(dirPath, dirName, mp4File);
            const infoFile = `${filePath}.info`;
            
            if (await fileExists(infoFile)) {
              try {
                const fileInfo = await fs.readFile(infoFile, 'utf-8');
                const info = JSON.parse(fileInfo);
                
                // If info version is outdated, we need to process this movie
                if (!info.version || info.version < CURRENT_VERSION) {
                  logger.info(`Info file for ${mp4File} has outdated version (${info.version}), regeneration needed`);
                  needInfoRegeneration = true;
                  break;
                }
              } catch (error) {
                logger.warn(`Error reading info file for ${mp4File}, regeneration needed:` + error);
                needInfoRegeneration = true;
                break;
              }
            } else {
              // If info file doesn't exist, we need to process this movie
              logger.info(`Info file for ${mp4File} doesn't exist, regeneration needed`);
              needInfoRegeneration = true;
              break;
            }
          }
          
          // If we don't need to regenerate info files and directory hasn't changed, skip processing
          if (!needInfoRegeneration) {
            if (isDebugMode) {
              logger.info(
                `No changes detected in ${dirName}, skipping processing.`
              );
            }
            return; // Use return instead of continue
          } else {
            logger.info(`Processing ${dirName} to update info files`);
          }
        }

        logger.info(`Directory Hash invalidated for, ${dirName}`);

        const encodedDirName = encodeURIComponent(dirName);
        const fileSet = new Set(files); // Create a set of filenames for quick lookup
        const fileNames = files.filter(
          (file) =>
            file.endsWith(".mp4") ||
            file.endsWith(".srt") ||
            file.endsWith(".json") ||
            file.endsWith(".info") ||
            file.endsWith(".nfo") ||
            file.endsWith(".jpg") ||
            file.endsWith(".png")
        );
        const fileLengths = {};
        const fileDimensions = {};
        let hdrInfo;
        let mediaQuality;
        let additionalMetadata;
        const urls = {};
        const subtitles = {};
        let _id = null;

        let runDownloadTmdbImagesFlag = false;

        const tmdbConfigPath = join(dirPath, dirName, "tmdb.config");
        let tmdbConfigLastModified = null;

        // Check if tmdb.config exists before getting its last modified time
        if (await fileExists(tmdbConfigPath)) {
          tmdbConfigLastModified = await getLastModifiedTime(tmdbConfigPath);
        }

        // If tmdb.config exists, try to extract tmdb_id from it
        if (await fileExists(tmdbConfigPath)) {
          tmdbConfigLastModified = await getLastModifiedTime(tmdbConfigPath);
          try {
            const tmdbConfigContent = await fs.readFile(tmdbConfigPath, "utf8");
            const tmdbConfig = JSON.parse(tmdbConfigContent);

            if (tmdbConfig.tmdb_id) {
              // Use TMDb ID as primary identifier
              _id = `tmdb_${tmdbConfig.tmdb_id}`;
            }
          } catch (error) {
            logger.error(`Failed to parse tmdb.config for ${dirName}:`, error);
          }
        }

        for (const file of fileNames) {
          const filePath = join(dirPath, dirName, file);
          const encodedFilePath = encodeURIComponent(file);

          if (file.endsWith(".mp4")) {
            let fileLength;
            let fileDimensionsStr;

            try {
              const info = await getInfo(filePath);
              fileLength = info.length;
              fileDimensionsStr = info.dimensions;
              hdrInfo = info.hdr;
              mediaQuality = info.mediaQuality;
              additionalMetadata = info.additionalMetadata;
              _id = info.uuid;
            } catch (error) {
              logger.error(`Failed to retrieve info for ${filePath}:`, error);
            }

            fileLengths[file] = parseInt(fileLength, 10);
            fileDimensions[file] = fileDimensionsStr;
            urls[
              "mp4"
            ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodedFilePath}`;
            urls["mediaLastModified"] = (
              await fs.stat(filePath)
            ).mtime.toISOString();
            // Generate a Unique ID for each episode
            // Bypassing the TMDB id
            // if (await fileExists(filePath)) {
            //   const headerInfo = getHeaderData(filePath);
            //   _id = generateCacheKey(headerInfo);
            // }
          }

          if (file.endsWith(".srt")) {
            const parts = file.split(".");
            const srtIndex = parts.lastIndexOf("srt");
            const isHearingImpaired = parts[srtIndex - 1] === "hi";
            const langCode = isHearingImpaired
              ? parts[srtIndex - 2]
              : parts[srtIndex - 1];
            const langName = langMap[langCode] || langCode;
            const subtitleKey = isHearingImpaired
              ? `${langName} Hearing Impaired`
              : langName;

            subtitles[subtitleKey] = {
              url: `${PREFIX_PATH}/movies/${encodedDirName}/${encodedFilePath}`,
              srcLang: langCode,
              lastModified: (await fs.stat(filePath)).mtime.toISOString(),
            };
          }
        }

        // Check for required files using the set
        if (fileSet.has("backdrop.jpg")) {
          const backdropPath = join(dirPath, dirName, "backdrop.jpg");
          const backdropStats = await fs.stat(backdropPath);
          const backdropImageHash = createHash('md5').update(backdropStats.mtime.toISOString()).digest('hex').substring(0, 10);
          urls[
            "backdrop"
          ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
            "backdrop.jpg"
          )}?hash=${backdropImageHash}`;
          if (await fileExists(`${backdropPath}.blurhash`)) {
            urls[
              "backdropBlurhash"
            ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
              "backdrop.jpg"
            )}.blurhash`;
          } else {
            await getStoredBlurhash(backdropPath, BASE_PATH);
          }

          // Check if tmdb.config has been updated more recently
          const backdropLastModified = await getLastModifiedTime(backdropPath);
          if (
            tmdbConfigLastModified &&
            backdropLastModified &&
            tmdbConfigLastModified > backdropLastModified
          ) {
            runDownloadTmdbImagesFlag = true;
          }
        } else {
          runDownloadTmdbImagesFlag = true;
        }

        if (fileSet.has("poster.jpg")) {
          const posterPath = join(dirPath, dirName, "poster.jpg");
          const posterStats = await fs.stat(posterPath);
          const posterImageHash = createHash('md5').update(posterStats.mtime.toISOString()).digest('hex').substring(0, 10);
          urls[
            "poster"
          ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
            "poster.jpg"
          )}?hash=${posterImageHash}`;
          if (await fileExists(`${posterPath}.blurhash`)) {
            urls[
              "posterBlurhash"
            ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
              "poster.jpg"
            )}.blurhash`;
          } else {
            await getStoredBlurhash(posterPath, BASE_PATH);
          }

          // Check if tmdb.config has been updated more recently
          const posterLastModified = await getLastModifiedTime(posterPath);
          if (
            tmdbConfigLastModified &&
            posterLastModified &&
            tmdbConfigLastModified > posterLastModified
          ) {
            runDownloadTmdbImagesFlag = true;
          }
        } else {
          runDownloadTmdbImagesFlag = true;
        }

        if (fileSet.has("movie_logo.png") || fileSet.has("logo.png")) {
          const logoPath = join(dirPath, dirName, fileSet.has("movie_logo.png") ? "movie_logo.png" : "logo.png");
          const logoStats = await fs.stat(logoPath);
          const logoImageHash = createHash('md5').update(logoStats.mtime.toISOString()).digest('hex').substring(0, 10);
          urls[
            "logo"
          ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
            fileSet.has("movie_logo.png") ? "movie_logo.png" : "logo.png"
          )}?hash=${logoImageHash}`;
          if (await fileExists(`${logoPath}.blurhash`)) {
            urls[
              "logoBlurhash"
            ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
              fileSet.has("movie_logo.png") ? "movie_logo.png" : "logo.png"
            )}.blurhash`;
          } else {
            const blurhash = await getStoredBlurhash(logoPath, BASE_PATH);
            if (blurhash) {
              urls["logoBlurhash"] = blurhash;
            }
          }
        } else {
          runDownloadTmdbImagesFlag = true;
        }

        if (fileSet.has("metadata.json")) {
          urls[
            "metadata"
          ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
            "metadata.json"
          )}`;

          // Check if tmdb.config has been updated more recently
          const metadataPath = join(dirPath, dirName, "metadata.json");
          const metadataLastModified = await getLastModifiedTime(metadataPath);
          if (
            tmdbConfigLastModified &&
            metadataLastModified &&
            tmdbConfigLastModified > metadataLastModified
          ) {
            runDownloadTmdbImagesFlag = true;
          }
        } else {
          runDownloadTmdbImagesFlag = true;
        }

        // Check if the movie is in the missing data table and if it should be retried
        const missingDataMovie = missingDataMovies.find(
          (movie) => movie.name === dirName
        );
        if (missingDataMovie && !dirHashChanged) {
          const lastAttempt = new Date(missingDataMovie.lastAttempt);
          const hoursSinceLastAttempt = (now - lastAttempt) / (1000 * 60 * 60);
          if (hoursSinceLastAttempt >= RETRY_INTERVAL_HOURS) {
            runDownloadTmdbImagesFlag = true; // Retry if it was more than RETRY_INTERVAL_HOURS
          } else {
            runDownloadTmdbImagesFlag = false; // Skip download attempt if it was recently tried
          }
        } else if (dirHashChanged) {
          runDownloadTmdbImagesFlag = true; // Retry if the directory hash changed
        }

        if (runDownloadTmdbImagesFlag) {
          await insertOrUpdateMissingDataMedia(db, dirName); // Update the last attempt timestamp
          await runDownloadTmdbImages(null, dirName);
          // Retry fetching the data after running the script
          const retryFiles = await fs.readdir(join(dirPath, dirName));
          const retryFileSet = new Set(retryFiles); // Create a set of filenames for quick lookup

          if (retryFileSet.has("backdrop.jpg")) {
          const backdropPath = join(dirPath, dirName, "backdrop.jpg");
          const backdropStats = await fs.stat(backdropPath);
          const backdropImageHash = createHash('md5').update(backdropStats.mtime.toISOString()).digest('hex').substring(0, 10);
          urls[
            "backdrop"
          ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
            "backdrop.jpg"
          )}?hash=${backdropImageHash}`;
          if (await fileExists(`${backdropPath}.blurhash`)) {
            urls[
              "backdropBlurhash"
            ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
              "backdrop.jpg"
            )}.blurhash`;
          } else {
            await getStoredBlurhash(backdropPath, BASE_PATH);
          }
          }

          if (retryFileSet.has("poster.jpg")) {
            const posterPath = join(dirPath, dirName, "poster.jpg");
            const posterStats = await fs.stat(posterPath);
            const posterImageHash = createHash('md5').update(posterStats.mtime.toISOString()).digest('hex').substring(0, 10);
            urls[
              "poster"
            ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
              "poster.jpg"
            )}?hash=${posterImageHash}`;
            if (await fileExists(`${posterPath}.blurhash`)) {
              urls[
                "posterBlurhash"
              ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
                "poster.jpg"
              )}.blurhash`;
            } else {
              await getStoredBlurhash(posterPath, BASE_PATH);
            }
          }

          if (
            retryFileSet.has("movie_logo.png") ||
            retryFileSet.has("logo.png")
          ) {
            const logoPath = join(dirPath, dirName, retryFileSet.has("movie_logo.png") ? "movie_logo.png" : "logo.png");
            const logoStats = await fs.stat(logoPath);
            const logoImageHash = createHash('md5').update(logoStats.mtime.toISOString()).digest('hex').substring(0, 10);
            urls[
              "logo"
            ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
              retryFileSet.has("movie_logo.png") ? "movie_logo.png" : "logo.png"
            )}?hash=${logoImageHash}`;
            if (await fileExists(`${logoPath}.blurhash`)) {
              urls[
                "logoBlurhash"
              ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
                retryFileSet.has("movie_logo.png") ? "movie_logo.png" : "logo.png"
              )}.blurhash`;
            } else {
              const blurhash = await getStoredBlurhash(logoPath, BASE_PATH);
              if (blurhash) {
                urls["logoBlurhash"] = blurhash;
              }
            }
          }

          if (retryFileSet.has("metadata.json")) {
            urls[
              "metadata"
            ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
              "metadata.json"
            )}`;
          }
        }

        let mp4Filename = fileNames.find(
          (e) => e.endsWith(".mp4") && !e.endsWith(".mp4.info")
        );
        mp4Filename = mp4Filename?.replace(".mp4", "");

        // Add chapter information
        const chaptersPath = join(
          dirPath,
          dirName,
          "chapters",
          `${dirName}_chapters.vtt`
        );
        const chaptersPath2 = join(
          dirPath,
          dirName,
          "chapters",
          `${mp4Filename}_chapters.vtt`
        );
        
        // Generate chapter files if the media exists
        if (mp4Filename) {
          const mediaPath = join(dirPath, dirName, `${mp4Filename}.mp4`);
          if (await fileExists(mediaPath)) {
            await generateChapterFileIfNotExists(chaptersPath, mediaPath, true);
            // Only try the second path if the first one didn't work or doesn't exist
            if (!await fileExists(chaptersPath)) {
              await generateChapterFileIfNotExists(chaptersPath2, mediaPath, true);
            }
          }
        }
        
        if (await fileExists(chaptersPath)) {
          urls[
            "chapters"
          ] = `${PREFIX_PATH}/movies/${encodedDirName}/chapters/${encodeURIComponent(
            `${dirName}_chapters.vtt`
          )}`;
        } else if (await fileExists(chaptersPath2)) {
          urls[
            "chapters"
          ] = `${PREFIX_PATH}/movies/${encodedDirName}/chapters/${encodeURIComponent(
            `${mp4Filename}_chapters.vtt`
          )}`;
        }

        // Remove empty sections
        if (Object.keys(subtitles).length === 0) {
          delete urls["subtitles"];
        } else {
          urls["subtitles"] = subtitles;
        }

        if (Object.keys(urls).length === 0) {
          urls = {}; // Initialize urls as an empty object instead of deleting it
        }

        const final_hash = await calculateDirectoryHash(fullDirPath);

        // Extract file paths for direct access
        const posterFilePath = fileSet.has("poster.jpg") ? join(dirPath, dirName, "poster.jpg") : null;
        const backdropFilePath = fileSet.has("backdrop.jpg") ? join(dirPath, dirName, "backdrop.jpg") : null;
        const logoFilePath = fileSet.has("movie_logo.png") 
          ? join(dirPath, dirName, "movie_logo.png") 
          : (fileSet.has("logo.png") ? join(dirPath, dirName, "logo.png") : null);

        // Always update the database with the latest data including file paths
        await insertOrUpdateMovie(
          db,
          dirName,
          fileNames, // Array of filenames
          fileLengths, // Object mapping filenames to lengths
          fileDimensions, // Object mapping filenames to dimensions
          urls, // URLs and related data
          urls["metadata"] || "", // metadata_url
          final_hash, // directory_hash
          hdrInfo,
          mediaQuality,
          additionalMetadata,
          _id,
          posterFilePath,
          backdropFilePath,
          logoFilePath,
          BASE_PATH // Store the base path for future reference
        );
      }
    })
  );
  // Remove movies from the database that no longer exist in the file system
  for (const movieName of existingMovieNames) {
    await deleteMovie(db, movieName);
  }
}

app.get("/media/movies", async (req, res) => {
  try {
    const db = await initializeDatabase();
    if (await isDatabaseEmpty(db)) {
      await generateListMovies(db, `${BASE_PATH}/movies`);
    }
    const movies = await getMovies(db);
    await releaseDatabase(db);

    const movieData = movies.reduce((acc, movie) => {
      acc[movie.name] = {
        _id: movie._id,
        fileNames: movie.fileNames,
        length: movie.lengths,
        dimensions: movie.dimensions,
        urls: movie.urls,
        hdr: movie.hdr,
        mediaQuality: movie.mediaQuality,
        additional_metadata: movie.additional_metadata,
      };
      return acc;
    }, {});

    res.json({...movieData, 'version': MOVIE_LIST_VERSION});
  } catch (error) {
    logger.error(`Error fetching movies: ${error}`);
    res.status(500).send("Internal server error");
  }
});

app.post("/media/scan", async (req, res) => {
  try {
    const db = await initializeDatabase();
    await generateListMovies(db, `${BASE_PATH}/movies`);
    await releaseDatabase(db);
    res.status(200).send("Library scan completed");
  } catch (error) {
    logger.error(`Error scanning library: ${error}`);
    res.status(500).send("Internal server error");
  }
});

async function runGeneratePosterCollage() {
  logger.info(`Running generate_poster_collage.py job${debugMessage}`);
  // Use custom Python executable if provided in environment (for debug with virtual env)
  const pythonExecutable = process.env.PYTHON_EXECUTABLE || (process.platform === "win32" ? "python" : "python3");
  const escapedScript =
    process.platform === "win32"
      ? generatePosterCollageScript.replace(/"/g, '\\"')
      : generatePosterCollageScript.replace(/(["\s'\\])/g, "\\$1");
  const command = isDebugMode
    ? `${pythonExecutable} "${escapedScript}" >> "${LOG_FILE}" 2>&1`
    : `${pythonExecutable} "${escapedScript}"`;

  try {
    const env = {
      ...process.env,
      DEBUG: process.env.DEBUG,
      TMDB_API_KEY: process.env.TMDB_API_KEY,
    };
    await execAsync(command, { env });
  } catch (error) {
    logger.error(`Error executing generate_poster_collage.py: ${error}`);
  }
}
async function runDownloadTmdbImages(
  specificShow = null,
  specificMovie = null,
  fullScan = false
) {
  const debugMessage = isDebugMode ? " with debug" : "";
  const pythonExecutable = process.env.PYTHON_EXECUTABLE || (process.platform === "win32" ? "python" : "python3");
  logger.info(
    `Download tmdb request${specificShow ? ` for show "${specificShow}"` : ""}${
      specificMovie ? ` for movie "${specificMovie}"` : ""
    }${fullScan ? " with full scan" : ""}`
  );

  // Construct the command using cross-platform path handling
  let command = `${pythonExecutable} "${downloadTmdbImagesScript}"`;

  // Append arguments
  if (specificShow) {
    command += ` --show "${specificShow}"`;
  } else if (specificMovie) {
    command += ` --movie "${specificMovie}"`;
  }

  // Handle logging if in debug mode
  let logRedirect = "";
  if (isDebugMode) {
    try {
      await fs.access(LOG_FILE, fs.constants.W_OK);
      logRedirect =
        process.platform === "win32"
          ? ` >> "${LOG_FILE}" 2>&1`
          : ` >> "${LOG_FILE}" 2>&1`;
    } catch (err) {
      logger.warn(
        `No write access to ${LOG_FILE}. Logging to console instead.`
      );
    }
  }

  try {
    logger.info(
      `Running download_tmdb_images.py job${debugMessage}${
        specificShow ? ` for show "${specificShow}"` : ""
      }${specificMovie ? ` for movie "${specificMovie}"` : ""}${
        fullScan ? " with full scan" : ""
      }`
    );
    const { stdout, stderr } = await execAsync(command + logRedirect, {
      env: {
        ...process.env,
        DEBUG: process.env.DEBUG,
        TMDB_API_KEY: process.env.TMDB_API_KEY,
      },
    });

    if (stderr) {
      logger.error(`download_tmdb_images.py error: ${stderr}`);
    }
    logger.info(
      `Finished running download_tmdb_images.py job${debugMessage}${
        specificShow ? ` for show "${specificShow}"` : ""
      }${
        specificMovie
          ? ` for movie "${specificMovie}"${fullScan ? " with full scan" : ""}`
          : ""
      }`
    );
  } catch (error) {
    logger.error(`Error executing download_tmdb_images.py: ${error}`);
  }
}
// async function runGenerateThumbnailJson() {
//   logger.info(`Running generate_thumbnail_json.sh job${debugMessage}`);
//   const command = isDebugMode
//     ? `sudo bash -c 'env DEBUG=${process.env.DEBUG} bash ${generateThumbnailJsonScript} >> ${LOG_FILE} 2>&1'`
//     : `sudo bash -c 'env DEBUG=${process.env.DEBUG} bash ${generateThumbnailJsonScript}'`;

//   try {
//     await execAsync(command);
//   } catch (error) {
//     logger.error(`Error executing generate_thumbnail_json.sh: ${error}`);
//   }
// }

// Function to parse and format a log line
const formatLogEntry = (entry) => {
  try {
    const timestamp = entry.timestamp || new Date().toISOString();
    const category = entry.category || "general";
    const message = entry.message || "";

    // Format: [category timestamp] message
    return `[${category} ${timestamp}] ${message}`;
  } catch (e) {
    console.error("Failed to format log entry:", e);
    return null;
  }
};

// Function to load all logs up to the current point
const loadHistoricalLogs = async (category) => {
  const logs = [];
  const logFiles = (await fs.readdir(logDirectory)).filter((file) => file.endsWith(".log"));

  for (const file of logFiles) {
    const filePath = join(logDirectory, file);
    const fileContent = await fs.readFile(filePath, "utf8");
    const logLines = fileContent.split("\n").filter((line) => line);

    logLines.forEach((line) => {
      try {
        const logEntry = JSON.parse(line);
        if (!category || logEntry.category === category) {
          logs.push(formatLogEntry(logEntry));
        }
      } catch (e) {
        console.error("Failed to parse log line:", e);
      }
    });
  }

  // Sort logs by timestamp ascending
  return logs.sort((a, b) => {
    const timestampA = a.match(/\[(.*?)\]/)[1];
    const timestampB = b.match(/\[(.*?)\]/)[1];
    return new Date(timestampA) - new Date(timestampB);
  });
};

// SSE Headers
const setSSEHeaders = (res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders(); // Flush headers to establish SSE connection
};

// SSE Streaming Logs
const streamLogs = async (req, res, category) => {
  setSSEHeaders(res);

  // Load historical logs and send them to the client
  try {
    const historicalLogs = await loadHistoricalLogs(category);
    historicalLogs.forEach((log) => {
      res.write(`data: ${log}\n\n`);
    });
  } catch (err) {
    console.error("Failed to load historical logs:", err);
    res.write(`event: error\ndata: ${JSON.stringify({ error: "Failed to load historical logs" })}\n\n`);
  }

  // Keep connection alive with a comment
  const keepAliveInterval = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000); // Send a keep-alive message every 15 seconds

  // Watch for new logs
  const watcher = chokidar.watch(logDirectory, {
    persistent: true,
    ignoreInitial: true,
  });

  // Function to handle new or updated log files
  const sendLog = async (filePath) => {
    if (!filePath.endsWith(".log")) return;

    try {
      const fileContent = await fs.readFile(filePath, "utf8");
      const logLines = fileContent.split("\n").filter((line) => line);

      logLines.forEach((line) => {
        try {
          const logEntry = JSON.parse(line);
          if (!category || logEntry.category === category) {
            const formattedLog = formatLogEntry(logEntry);
            if (formattedLog) {
              res.write(`data: ${formattedLog}\n\n`);
            }
          }
        } catch (e) {
          console.error("Failed to parse log line:", e);
        }
      });
    } catch (e) {
      console.error(`Error reading log file ${filePath}:`, e);
    }
  };

  // Set up chokidar event handlers
  watcher
    .on("add", sendLog) // Triggered when a new log file is added
    .on("change", sendLog) // Triggered when an existing log file is updated
    .on("error", (error) => {
      console.error("Watcher error:", error);
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Watcher error" })}\n\n`);
    });

  // Handle client disconnection
  req.on("close", () => {
    console.log("Client disconnected from SSE");
    clearInterval(keepAliveInterval); // Clear the keep-alive interval
    watcher.close(); // Close the file watcher
    res.end(); // End the response
  });
};

// Enhanced /api/logs endpoint
app.get("/api/logs", async (req, res) => {
  res.header("Access-Control-Allow-Origin", process.env.FRONT_END_1);
  res.header("Access-Control-Allow-Methods", "GET");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  const { category, format = "json", stream } = req.query;

  if (stream === "true") {
    await streamLogs(req, res, category);
    return;
  }

  // Default behavior: Load logs without streaming
  try {
    const logs = await loadHistoricalLogs(category);

    if (format === "logViewer") {
      res.setHeader("Content-Type", "text/plain");
      res.send(logs.join("\n"));
    } else {
      res.json(logs); // Wrap logs in objects for JSON
    }
  } catch (err) {
    console.error("Error retrieving logs:", err);
    res.status(500).json({ error: "Failed to retrieve logs" });
  }
});

// Log Categories
app.get('/api/logs/categories', (req, res) => {
  res.header("Access-Control-Allow-Origin", process.env.FRONT_END_1);
  res.header("Access-Control-Allow-Methods", "GET");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.json(getCategories());
});


// Clipping routes for movies and TV shows
app.get("/videoClip/movie/:movieName", async (req, res) => {
  const db = await initializeDatabase();
  await handleVideoClipRequest(req, res, "movies", BASE_PATH, db);
  await releaseDatabase(db);
});

app.get("/videoClip/tv/:showName/:season/:episode", async (req, res) => {
  const db = await initializeDatabase();
  await handleVideoClipRequest(req, res, "tv", BASE_PATH, db);
  await releaseDatabase(db);
});

let isScanning = false;

async function runGenerateList() {
  // Use the MEDIA_SCAN task type for overall orchestration
  return enqueueTask(TaskType.MEDIA_SCAN, 'Media List Generation', async () => {
    logger.info('Generating media list - controlled by task manager');
    
    // Process movies using the specialized MOVIE_SCAN task type
    await enqueueTask(TaskType.MOVIE_SCAN, 'Movie List Generation', async () => {
      const movieDb = await initializeDatabase();
      try {
        logger.info('Processing movies');
        await generateListMovies(movieDb, `${BASE_PATH}/movies`);
        logger.info('Finished processing movies');
      } catch (error) {
        logger.error(`Error processing movies: ${error}`);
        throw error; // Allow task manager to handle the error
      } finally {
        await releaseDatabase(movieDb);
      }
    });
    
    // Process TV shows using the specialized TV_SCAN task type
    await enqueueTask(TaskType.TV_SCAN, 'TV Show List Generation', async () => {
      const tvDb = await initializeDatabase();
      try {
        logger.info('Processing TV shows');
        await generateListTV(tvDb, `${BASE_PATH}/tv`);
        logger.info('Finished processing TV shows');
      } catch (error) {
        logger.error(`Error processing TV shows: ${error}`);
        throw error; // Allow task manager to handle the error
      } finally {
        await releaseDatabase(tvDb);
      }
    });
    
    logger.info('Finished generating complete media list');
    
    // Run auto sync as a separate task
    await enqueueTask(TaskType.API_REQUEST, 'Auto Sync', async () => {
      try {
        await autoSync();
      } catch (error) {
        logger.error(`Auto sync error: ${error}`);
        // Don't rethrow this error as it's non-critical
      }
    });
    
    return 'Media list generation completed';
  });
}

async function autoSync() {
  let errorMessage = "";
  logger.info("Checking autoSync Settings..");
  const autoSyncEnabled = await checkAutoSync();
  if (autoSyncEnabled) {
    logger.info("Auto Sync is enabled. Proceeding with sync...");

    try {
      const headers = {
        "X-Webhook-ID": process.env.WEBHOOK_ID_1,
        "Content-Type": "application/json",
      };

      if (isDebugMode) {
        logger.info(`Sending headers:${debugMessage}`, headers);
      }

      const response = await axios.post(
        `${process.env.FRONT_END_1}/api/authenticated/admin/sync`,
        {},
        { headers }
      );

      if (response.status >= 200 && response.status < 300) {
        logger.info("Sync request completed successfully.");
        await updateLastSyncTime();
      } else {
        logger.info(`Sync request failed with status code: ${response.status}`);
      }
    } catch (error) {
      const prefix = "Sync request failed: ";

      if (error.response && error.response.data) {
        logger.error(`${prefix}${JSON.stringify(error.response.data)}`);
        errorMessage = error.response.data;
      } else if (error.response && error.response.status === 404) {
        const unavailableMessage = `${process.env.FRONT_END_1}/api/authenticated/admin/sync is unavailable`;
        logger.error(`${prefix}${unavailableMessage}`);
        errorMessage = unavailableMessage;
      } else if (error.code === "ECONNRESET") {
        const connectionResetMessage =
          "Connection was reset. Please try again later.";
        logger.error(
          `${prefix}${connectionResetMessage}` + 
          JSON.stringify(error)
        );
        errorMessage = connectionResetMessage;
      } else {
        logger.error(`${prefix}An unexpected error occurred. ` + JSON.stringify(error));
      }
    }
  } else {
    logger.info("Auto Sync is disabled. Skipping sync...");
  }
}

function scheduleTasks() {
  // Schedule for download_tmdb_images.py - stagger with specific minute patterns
  // Runs at 7, 25, 43 minutes past the hour to avoid overlapping with other tasks
  scheduleJob("7,25,43 * * * *", () => {
    // Use task manager instead of isScanning flag
    enqueueTask(TaskType.DOWNLOAD, 'TMDB Image Download', async () => {
      logger.info('Running scheduled TMDB image download with task manager');
      await runDownloadTmdbImages(null, null, true);
      return 'TMDB image download completed successfully';
    }).catch(error => {
      logger.error(`Failed to enqueue TMDB download task: ${error.message}`);
    });
  });

  // Schedule for generate_poster_collage.py
  // Run at 12, 42 minutes past the hour to avoid overlapping with other tasks
  scheduleJob("12,42 * * * *", () => {
    // Use task manager instead of isScanning flag
    enqueueTask(TaskType.DOWNLOAD, 'Poster Collage Generation', async () => {
      logger.info('Running scheduled poster collage generation with task manager');
      await runGeneratePosterCollage();
      return 'Poster collage generation completed successfully';
    }).catch(error => {
      logger.error(`Failed to enqueue poster collage task: ${error.message}`);
    });
  });
  
  // Schedule for runGenerateList and autoSync
  // Run every 3 minutes to balance between freshness and performance
  // Changed from specific minutes to reduce SQLITE_BUSY errors
  scheduleJob("*/3 * * * *", () => {
    runGenerateList().catch(logger.error);
  });
  
  // Schedule metadata hash updates - runs at 5, 20, 35, 50 minutes past the hour
  scheduleJob("5,20,35,50 * * * *", () => {
    // Use task manager instead of the isScanning flag
    enqueueTask(TaskType.METADATA_HASH, 'Metadata Hashes Update', async () => {
      logger.info("Running Metadata Hashes Update...");
      const db = await initializeDatabase();
      
      try {
        // Use a timestamp to track changes since last scan
        const lastScanTime = new Date();
        lastScanTime.setMinutes(lastScanTime.getMinutes() - 16);
        const sinceTimestamp = lastScanTime.toISOString();
        
        // Import hash functions
        const { updateAllMovieHashes, updateAllTVShowHashes } = await import('./sqlite/metadataHashes.mjs');
        
        // Process movies first
        await updateAllMovieHashes(db, sinceTimestamp);
        logger.info("Movie metadata hashes completed, processing TV shows...");
        
        // Process TV shows second
        await updateAllTVShowHashes(db, sinceTimestamp);
        logger.info("Metadata Hashes Update Completed.");
        
        return 'Metadata hash update completed successfully';
      } catch (error) {
        logger.error(`Metadata Hashes Update Error: ${error.message}`);
        throw error; // Let task manager handle the error
      } finally {
        await releaseDatabase(db);
      }
    }).catch(error => {
      logger.error(`Failed to enqueue metadata hash task: ${error.message}`);
    });
  });
  
  // Schedule cache cleanups at staggered times
  // General cache cleanup runs at 15 and 45 past the hour
  scheduleJob("15,45 * * * *", () => {
    // Use task manager instead of checking isScanning flag
    enqueueTask(TaskType.CACHE_CLEANUP, 'General Cache Cleanup (Regular)', async () => {
      logger.info("Running General Cache Cleanup...");
      await clearGeneralCache();
      logger.info("General Cache Cleanup Completed.");
      return 'Regular general cache cleanup completed successfully';
    }).catch(error => {
      logger.error(`Failed to enqueue regular general cache cleanup task: ${error.message}`);
    });
  });
  
  // Less frequent cache cleanups run at staggered overnight hours
  // to minimize impact on active usage times
  
  // Frames cache cleanup at 1:30 AM
  scheduleJob("30 1 * * *", () => {
    logger.info("Running Frames Cache Cleanup...");
    clearFramesCache()
      .then(() => {
        logger.info("Frames Cache Cleanup Completed.");
      })
      .catch((error) => {
        logger.error(`Frames Cache Cleanup Error: ${error.message}`);
      });
  });
  
  // Sprite sheet cache cleanup at 2:30 AM
  scheduleJob("30 2 * * *", () => {
    logger.info("Running Spritesheet Cache Cleanup...");
    clearSpritesheetCache()
      .then(() => {
        logger.info("Spritesheet Cache Cleanup Completed.");
      })
      .catch((error) => {
        logger.error(`Spritesheet Cache Cleanup Error: ${error.message}`);
      });
  });
  
  // Video clips cache cleanup at 3:30 AM
  scheduleJob("30 3 * * *", () => {
    logger.info("Running Video Clips Cache Cleanup...");
    clearVideoClipsCache()
      .then(() => {
        logger.info("Video Clips Cache Cleanup Completed.");
      })
      .catch((error) => {
        logger.error(`Video Clips Cache Cleanup Error: ${error.message}`);
      });
  });
}

async function initialize() {
  await ensureCacheDirs();
  const port = 3000;
  app.listen(port, async () => {
    scheduleTasks();
    //runGenerateThumbnailJson().catch(logger.error);
    logger.info(`Server running on port ${port}`);
    const db = await initializeDatabase();

    // Initialize blurhash hashes table at startup
    await initializeBlurhashHashesTable(db);
    logger.info('Blurhash hashes table initialized at startup');
    
    // Perform initial full scan of blurhashes - sequentially to avoid transaction conflicts
    logger.info('Starting initial blurhash scan of all media files...');
    try {
      // Process movies first, then TV shows sequentially to avoid transaction conflicts
      await updateAllMovieBlurhashHashes(db, BASE_PATH);
      logger.info("Movie blurhash hashes completed, processing TV shows...");
      await updateAllTVShowBlurhashHashes(db, BASE_PATH);
      logger.info('Initial blurhash scan completed successfully');
    } catch (error) {
      logger.error(`Error during initial blurhash scan: ${error.message}`);
    }

  // As part of startup clear out any in progress processes from the process tracking database
  // This will prevent any processes from being stuck in the queue
  await markInProgressAsInterrupted(); // This will use the dedicated processTracking database
  logger.info('Process queue has been reset.');
    initializeMongoDatabase()
      .then(() => {
        return initializeIndexes();
      })
      .then(() => {
        logger.info("Database and indexes initialized successfully.");
      })
      .catch((error) => {
        logger.error("Error during initialization:", error);
      });
    runGenerateList().catch(logger.error);
    runGeneratePosterCollage().catch(logger.error);
  });
}

// Use the modular route system
app.use(setupRoutes());

// Initialize the application
initialize().catch(logger.error);
