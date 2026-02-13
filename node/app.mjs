import express from "express";
import { scheduleJob } from "node-schedule";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import { join, resolve, basename, extname, dirname, normalize } from "path";
import { createReadStream } from "fs"; // Callback-based version of fs
import { promises as fs } from "fs"; // Use the promise-based version of fs
import compression from "compression";
import cors from "cors";
import axios from "axios";
import { createSpriteRoutes } from "./sprite-route.mjs";
import { initializeDatabase, insertOrUpdateMovie, getMovies, isDatabaseEmpty, getTVShows, insertOrUpdateTVShow, insertOrUpdateMissingDataMedia, getMissingDataMedia, deleteMovie, deleteTVShow, getMovieByName, getTVShowByName, releaseDatabase } from "./sqliteDatabase.mjs";
import { getMediaTypeHashes, getShowHashes, getSeasonHashes, generateMovieHashes, generateTVShowHashes, getHash, updateAllMovieHashes, updateAllTVShowHashes } from "./sqlite/metadataHashes.mjs";
import { initializeBlurhashHashesTable, getHashesModifiedSince, generateMovieBlurhashHashes, generateTVShowBlurhashHashes, updateAllMovieBlurhashHashes, updateAllTVShowBlurhashHashes, getMovieBlurhashData, getTVShowBlurhashData } from "./sqlite/blurhashHashes.mjs";
import { initializeTmdbBlurhashCacheTable } from "./sqlite/tmdbBlurhashCache.mjs";
import { setupRoutes } from "./routes/index.mjs";
import { authenticateWebhookOrUser } from "./middleware/auth.mjs";
import { generateFrame, fileExists, ensureCacheDirs, mainCacheDir, generalCacheDir, spritesheetCacheDir, framesCacheDir, findMp4File, getStoredBlurhash, calculateDirectoryHash, getLastModifiedTime, clearSpritesheetCache, clearFramesCache, clearGeneralCache, clearVideoClipsCache, clearOriginalSegmentsCache, convertToAvif, generateCacheKey, getEpisodeFilename, getEpisodeKey, deriveEpisodeTitle, getCleanVideoPath, shouldUseAvif } from "./utils/utils.mjs";
import { generateChapters } from "./chapter-generator.mjs";
import { checkAutoSync, updateLastSyncTime, initializeIndexes, initializeMongoDatabase } from "./database.mjs";
import { handleVideoRequest, handleVideoClipRequest } from "./videoHandler.mjs";
import { CURRENT_VERSION, getInfo } from "./infoManager.mjs";
import { fileURLToPath } from "url";
import { createCategoryLogger, createPythonLogger, getCategories } from "./lib/logger.mjs";
import chokidar from "chokidar";
import { createOrUpdateProcessQueue, finalizeProcessQueue, getAllProcesses, getProcessByFileKey, getProcessesWithFilters, getProcessTrackingDb, markInProgressAsInterrupted, removeInProgressProcesses, updateProcessQueue } from "./sqlite/processTracking.mjs";
import { chapterInfo } from "./ffmpeg/ffprobe.mjs";
import { TaskType, enqueueTask } from "./lib/taskManager.mjs";
import { createHash } from "crypto";
import { runPython } from "./lib/processRunner.mjs";
import { MetadataGenerator } from "./lib/metadataGenerator.mjs";
import { scanMovies, scanTVShows } from "./components/media-scanner/index.mjs";
const logger = createCategoryLogger('main');
const posterLogger = createPythonLogger('GeneratePosterCollage');
const tmdbLogger   = createCategoryLogger('DownloadTMDBImages');
const __filename = fileURLToPath(import.meta.url); // Get __filename
const __dirname = dirname(__filename); // Get __dirname
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
const MOVIE_LIST_VERSION = 1.0001;

// Enable compression for all responses
app.use(compression());

// Helper function to check if origin is related to server domain
function isRelatedDomain(origin, serverDomain) {
  try {
    const originUrl = new URL(origin);
    const originDomain = originUrl.hostname;
    
    // Same domain
    if (originDomain === serverDomain) return true;
    
    // Subdomain relationship (both directions)
    if (originDomain.endsWith(`.${serverDomain}`) ||
        serverDomain.endsWith(`.${originDomain}`)) {
      return true;
    }
    
    // Same root domain (e.g., app.example.com and api.example.com)
    const originParts = originDomain.split('.');
    const serverParts = serverDomain.split('.');
    
    if (originParts.length >= 2 && serverParts.length >= 2) {
      const originRoot = originParts.slice(-2).join('.');
      const serverRoot = serverParts.slice(-2).join('.');
      return originRoot === serverRoot;
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// Helper function to check if origin is localhost/development
function isLocalhost(origin) {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' ||
           url.hostname === '127.0.0.1' ||
           url.hostname === '0.0.0.0' ||
           url.hostname.endsWith('.local');
  } catch (error) {
    return false;
  }
}

// Enhanced Dynamic CORS configuration for flexible cross-domain authentication
const configureCORS = () => {
  // Get explicitly configured origins from environment variables
  const explicitOrigins = [];
  let index = 1;
  while (process.env[`FRONT_END_${index}`]) {
    explicitOrigins.push(process.env[`FRONT_END_${index}`]);
    index++;
  }
  
  // Add current server URL if available
  if (process.env.FILE_SERVER_NODE_URL) {
    try {
      const serverUrl = new URL(process.env.FILE_SERVER_NODE_URL);
      explicitOrigins.push(serverUrl.origin);
    } catch (error) {
      logger.warn(`Invalid FILE_SERVER_NODE_URL: ${process.env.FILE_SERVER_NODE_URL}`);
    }
  }
  
  // Get server domain for intelligent subdomain matching (with error handling)
  let serverDomain = null;
  if (process.env.FILE_SERVER_NODE_URL) {
    try {
      serverDomain = new URL(process.env.FILE_SERVER_NODE_URL).hostname;
    } catch (error) {
      logger.warn(`Invalid FILE_SERVER_NODE_URL: ${process.env.FILE_SERVER_NODE_URL}`);
      serverDomain = null;
    }
  }
  
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  logger.info(`CORS configured for explicit origins: ${explicitOrigins.join(', ') || 'none'}`);
  if (serverDomain) {
    logger.info(`CORS intelligent domain matching enabled for: ${serverDomain}`);
  }
  
  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, curl, etc.)
      if (!origin) return callback(null, true);
      
      // Check explicit allowed origins first
      if (explicitOrigins.includes(origin)) {
        return callback(null, true);
      }
      
      // Intelligent subdomain matching if server domain is known
      if (serverDomain && isRelatedDomain(origin, serverDomain)) {
        logger.info(`CORS auto-allowing related domain: ${origin} (related to ${serverDomain})`);
        return callback(null, true);
      }
      
      // Development mode - dynamically allow localhost origins
      if ((isDevelopment || isDebugMode) && isLocalhost(origin)) {
        logger.debug(`CORS allowing localhost in development: ${origin}`);
        return callback(null, true);
      }
      
      // Log blocked requests for debugging
      logger.warn(`CORS blocked origin: ${origin}. Add to FRONT_END_# env vars or ensure it's a related domain if this should be allowed.`);
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-session-token',
      'x-mobile-token',
      'x-webhook-id',
      'Cookie',
      'Origin',
      'X-Requested-With',
      'Accept',
      'Cache-Control'
    ],
    exposedHeaders: ['Set-Cookie', 'X-Total-Count', 'Content-Range'],
    maxAge: 86400, // 24 hours
    optionsSuccessStatus: 200 // Support legacy browsers
  });
};

// Apply CORS middleware
app.use(configureCORS());

// Parse JSON request bodies (with increased size limit for subtitle uploads)
app.use(express.json({ limit: '30mb' }));

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


app.get("/frame/movie/:movieName/:timestamp{.:ext}", (req, res) =>
  handleFrameRequest(req, res, "movies")
);

app.get("/frame/tv/:showName/:season/:episode/:timestamp{.:ext}", (req, res) =>
  handleFrameRequest(req, res, "tv")
);

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

    const showData = await getTVShowByName(show_name);
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
// Sprite Routes (handled by sprite-route.mjs)
//
app.use(createSpriteRoutes(BASE_PATH));

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
    const urls = typeof movie.urls === 'string' ? JSON.parse(movie.urls) : movie.urls;
    let videoMp4 = urls.mp4;
    videoMp4 = decodeURIComponent(videoMp4);
    const cleanPath = getCleanVideoPath(videoMp4);
    let videoPath = join(BASE_PATH, cleanPath);
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
      const shows = await getTVShows();
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
      const shows = await getTVShows();
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
      const chapterData = await chapterInfo(mediaPath);

      if (chapterData) {
        // Create the chapters directory if it doesn't exist
        await fs.mkdir(dirname(chapterFilePath), { recursive: true });

        // If the media file has chapter information, generate the chapter file
        const chapterContent = await generateChapters(mediaPath, chapterData);

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
 * Requires either webhook authentication or admin user access.
 * Optional query parameters:
 * - processType: Filter by process_type (e.g., "spritesheet", "vtt")
 * - status: Filter by status (e.g., "in-progress", "queued", "completed", "error")
 */
app.get('/processes', authenticateWebhookOrUser, async (req, res) => {
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
 * Requires either webhook authentication or admin user access.
 */
app.get('/processes/:fileKey', authenticateWebhookOrUser, async (req, res) => {
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

// Clear Original Segments Cache every 10 minutes (aggressive cleanup due to large file sizes)
scheduleJob("*/10 * * * *", () => {
  enqueueTask(TaskType.CACHE_CLEANUP, 'Original Segments Cache Cleanup', async () => {
    logger.info("Running Original Segments Cache Cleanup...");
    await clearOriginalSegmentsCache();
    logger.info("Original Segments Cache Cleanup Completed.");
    return 'Original segments cache cleanup completed successfully';
  }).catch(error => {
    logger.error(`Failed to enqueue original segments cache cleanup task: ${error.message}`);
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
      await updateAllMovieBlurhashHashes(BASE_PATH, sinceTimestamp);
      logger.info("Movie blurhash hashes completed, processing TV shows...");
      
      // Then process TV shows
      await updateAllTVShowBlurhashHashes(BASE_PATH, sinceTimestamp);
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

/**
 * Wrapper function for backward compatibility
 * Calls the new media-scanner component
 */
async function generateListTV(db, dirPath) {
  await scanTVShows(
    db,
    dirPath,
    PREFIX_PATH,
    BASE_PATH,
    langMap,
    isDebugMode,
    runDownloadTmdbImages
  );
}

/**
 * Legacy implementation - moved to components/media-scanner/domain/tv-scanner.mjs
 * @deprecated Use scanTVShows from media-scanner component instead
 */

app.get("/media/tv", authenticateWebhookOrUser, async (req, res) => {
  try {
    const db = await initializeDatabase();
    if (await isDatabaseEmpty("tv_shows")) {
      await generateListTV(db, `${BASE_PATH}/tv`);
    }
    const shows = await getTVShows();
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

/**
 * Wrapper function for backward compatibility
 * Calls the new media-scanner component
 */
async function generateListMovies(db, dirPath) {
  await scanMovies(
    db,
    dirPath,
    PREFIX_PATH,
    BASE_PATH,
    langMap,
    CURRENT_VERSION,
    isDebugMode,
    runDownloadTmdbImages
  );
}

/**
 * Legacy implementation - moved to components/media-scanner/domain/movie-scanner.mjs
 * @deprecated Use scanMovies from media-scanner component instead
 */

app.get("/media/movies", authenticateWebhookOrUser, async (req, res) => {
  try {
    const db = await initializeDatabase();
    if (await isDatabaseEmpty()) {
      await generateListMovies(db, `${BASE_PATH}/movies`);
    }
    const movies = await getMovies();
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

app.post("/media/scan", authenticateWebhookOrUser, async (req, res) => {
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
  const debugMessage = isDebugMode ? ' with debug' : '';
  posterLogger.info(`Running generate_poster_collage.py job${debugMessage}`);
  await runPython({
    scriptPath: generatePosterCollageScript,
    args: [],                       // no extra flags
    label: 'GeneratePosterCollage', // appears in the log prefix
    logger: posterLogger,          
    logFile: LOG_FILE,              // python-<date>.log and fallback file
    debug: isDebugMode,             // redirect to file when true
    env: {
      ...process.env,
      DEBUG: process.env.DEBUG,
      TMDB_API_KEY: process.env.TMDB_API_KEY,
    }
  });
}
async function runDownloadTmdbImages(
  specificShow = null,
  specificMovie = null,
  fullScan = false
) {
  const debugMessage = isDebugMode ? ' with debug' : '';
  tmdbLogger.info(
    `Download tmdb request${specificShow ? ` for show "${specificShow}"` : ''}` +
    `${specificMovie ? ` for movie "${specificMovie}"` : ''}` +
    `${fullScan ? ' with full scan' : ''}` +
    `${debugMessage}`
  );

  // Build args for Python script
  const args = [];
  
  if (specificShow)  args.push('--show', specificShow);
  if (specificMovie) args.push('--movie', specificMovie);
  
  if (fullScan) {
    args.push('--full-scan');
  }

  await runPython({
    scriptPath: downloadTmdbImagesScript,
    args,
    label: 'DownloadTMDBImages',
    logger: tmdbLogger,
    logFile: LOG_FILE,
    debug: isDebugMode,
    env: {
      ...process.env,
      DEBUG: process.env.DEBUG,
      TMDB_API_KEY: process.env.TMDB_API_KEY,
    }
  });
}

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
      await runDownloadTmdbImages(null, null, false);  // Don't force refresh - respect age checks
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

        // Process movies first
        await updateAllMovieHashes(sinceTimestamp);
        logger.info("Movie metadata hashes completed, processing TV shows...");
        
        // Process TV shows second
        await updateAllTVShowHashes(sinceTimestamp);
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
  server = app.listen(port, async () => {
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
      await updateAllMovieBlurhashHashes(BASE_PATH);
      logger.info("Movie blurhash hashes completed, processing TV shows...");
      await updateAllTVShowBlurhashHashes(BASE_PATH);
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

//
// Root endpoint - Welcome/Health check
//
app.get('/', (req, res) => {
  const serverInfo = {
    name: 'Media Server API',
    version: MOVIE_LIST_VERSION.toFixed(4),
    status: 'online',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'production',
    debug: isDebugMode,
    endpoints: {
      media: {
        description: 'Media library endpoints',
        routes: ['/media/movies', '/media/tv', '/media/scan']
      },
      video: {
        description: 'Video streaming',
        routes: ['/video/movie/:movieName', '/video/tv/:showName/:season/:episode']
      },
      api: {
        description: 'API operations',
        routes: ['/api/tmdb/*', '/api/admin/*', '/api/system-status', '/api/logs']
      },
      frames: {
        description: 'Frame/thumbnail generation',
        routes: ['/frame/movie/:movieName/:timestamp', '/frame/tv/:showName/:season/:episode/:timestamp']
      },
      spritesheets: {
        description: 'Sprite sheets and VTT files',
        routes: ['/spritesheet/movie/:movieName', '/vtt/movie/:movieName']
      },
      chapters: {
        description: 'Chapter information',
        routes: ['/chapters/movie/:movieName', '/chapters/tv/:showName/:season/:episode']
      },
      clips: {
        description: 'Video clip generation',
        routes: ['/videoClip/movie/:movieName', '/videoClip/tv/:showName/:season/:episode']
      },
      processes: {
        description: 'Process tracking',
        routes: ['/processes', '/processes/:fileKey']
      }
    },
    documentation: 'Access any endpoint category above for detailed API information'
  };
  
  res.json(serverInfo);
});

//
// 404 Handler - Must be after all valid routes but before error handlers
//
app.use((req, res, next) => {
  const requestedPath = req.originalUrl || req.url;
  const method = req.method;
  
  logger.warn(`404 Not Found: ${method} ${requestedPath}`);
  
  // Provide helpful API documentation for common base paths
  const apiDocs = {
    '/api': {
      description: 'API endpoints',
      endpoints: [
        '/api/tmdb/* - TMDB metadata operations',
        '/api/admin/* - Administrative operations (requires auth)',
        '/api/blurhash-changes - Get blurhash changes',
        '/api/metadata-hashes/:mediaType - Get metadata hashes',
        '/api/system-status - System status information',
        '/api/logs - Server logs (supports SSE streaming)'
      ]
    },
    '/media': {
      description: 'Media library endpoints',
      endpoints: [
        '/media/movies - List all movies',
        '/media/tv - List all TV shows',
        '/media/scan - Trigger library scan'
      ]
    },
    '/video': {
      description: 'Video streaming endpoints',
      endpoints: [
        '/video/movie/:movieName - Stream movie',
        '/video/tv/:showName/:season/:episode - Stream TV episode'
      ]
    },
    '/frame': {
      description: 'Frame/thumbnail endpoints',
      endpoints: [
        '/frame/movie/:movieName/:timestamp - Get movie frame',
        '/frame/tv/:showName/:season/:episode/:timestamp - Get TV frame'
      ]
    },
    '/spritesheet': {
      description: 'Sprite sheet endpoints',
      endpoints: [
        '/spritesheet/movie/:movieName - Get movie sprite sheet',
        '/spritesheet/tv/:showName/:season/:episode - Get TV sprite sheet'
      ]
    },
    '/vtt': {
      description: 'VTT file endpoints',
      endpoints: [
        '/vtt/movie/:movieName - Get movie VTT file',
        '/vtt/tv/:showName/:season/:episode - Get TV VTT file'
      ]
    },
    '/chapters': {
      description: 'Chapter endpoints',
      endpoints: [
        '/chapters/movie/:movieName - Get movie chapters',
        '/chapters/tv/:showName/:season/:episode - Get TV chapters'
      ]
    },
    '/videoClip': {
      description: 'Video clip endpoints',
      endpoints: [
        '/videoClip/movie/:movieName - Generate movie clip',
        '/videoClip/tv/:showName/:season/:episode - Generate TV clip'
      ]
    },
    '/processes': {
      description: 'Process tracking endpoints',
      endpoints: [
        '/processes - List all processes',
        '/processes/:fileKey - Get specific process status'
      ]
    }
  };
  
  // Determine which category the request falls into
  let suggestions = null;
  for (const [basePath, info] of Object.entries(apiDocs)) {
    if (requestedPath.startsWith(basePath)) {
      suggestions = info;
      break;
    }
  }
  
  // Build response with helpful information
  const response = {
    error: 'Not Found',
    message: `The requested endpoint '${method} ${requestedPath}' does not exist`,
    statusCode: 404,
    timestamp: new Date().toISOString()
  };
  
  // Add suggestions if we found a matching base path
  if (suggestions) {
    response.suggestion = suggestions.description;
    response.availableEndpoints = suggestions.endpoints;
  } else if (requestedPath === '/') {
    // Special handling for root path
    response.message = 'Welcome to the Media Server API';
    response.suggestion = 'This is an API server with no root endpoint';
    response.availableCategories = Object.keys(apiDocs);
    response.hint = 'Try accessing one of the available categories listed above';
  } else {
    // Generic suggestion for unknown paths
    response.suggestion = 'Check the API documentation for available endpoints';
    response.availableCategories = Object.keys(apiDocs);
  }
  
  res.status(404).json(response);
});

//
// Global Error Handlers for Express 5 Compatibility
//

// Express error handler - MUST be after all routes and middleware
// This catches errors thrown by async route handlers (Express 5 breaking change)
app.use((err, req, res, next) => {
  logger.error(`Unhandled Express error: ${err?.message || err}`);
  if (err?.stack) {
    logger.error(err.stack);
  }

  // If response headers already sent, delegate to Express default handler
  if (res.headersSent) {
    return next(err);
  }

  const isDevelopment = isDebugMode || process.env.NODE_ENV === 'development';

  // Express 5 is stricter about status codes - validate range 100-999
  const status = 
    Number.isInteger(err?.status) && err.status >= 100 && err.status <= 999
      ? err.status
      : 500;

  res.status(status).json({
    error: 'Internal Server Error',
    message: isDevelopment ? (err?.message || String(err)) : 'An error occurred',
    ...(isDevelopment && err?.stack ? { stack: err.stack } : {}),
  });
});

// Graceful shutdown management
let shuttingDown = false;
let server = null; // Will be set in initialize()

async function gracefulShutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal}, starting graceful shutdown...`);

  try {
    // Stop accepting new HTTP connections
    if (server) {
      logger.info('Closing HTTP server...');
      await new Promise((resolve) => {
        server.close(() => {
          logger.info('HTTP server closed');
          resolve();
        });
      });
    }

    // Close Discord client if it exists
    try {
      const { NotificationManager } = await import('./integrations/index.mjs');
      // Access any global notification manager instance to close Discord
      logger.info('Closing Discord connections...');
    } catch (error) {
      logger.warn('Could not close Discord connections:', error.message);
    }

    // Close database connections
    try {
      logger.info('Closing database connections...');
      await releaseDatabase(); // Close any open SQLite connections
    } catch (error) {
      logger.warn('Error closing database:', error.message);
    }

    // Close MongoDB connections if they exist
    try {
      const { closeMongoConnection } = await import('./database.mjs');
      if (typeof closeMongoConnection === 'function') {
        await closeMongoConnection();
        logger.info('MongoDB connections closed');
      }
    } catch (error) {
      logger.warn('Could not close MongoDB connections:', error.message);
    }

    logger.info('Graceful shutdown completed');
  } catch (error) {
    logger.error('Error during graceful shutdown:', error.message);
  }

  process.exit(code);
}

// Process-level error handlers
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection at:', promise);
  logger.error('Rejection reason:', reason?.stack || reason);
  console.error('Unhandled Rejection Details:', {
    promise,
    reason: reason?.stack || reason
  });
  
  // Unhandled rejections indicate the process may be in an unknown state
  // Starting graceful shutdown for safety
  logger.error('Starting graceful shutdown due to unhandled rejection...');
  gracefulShutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error?.message || error);
  logger.error('Exception stack:', error?.stack);
  console.error('Uncaught Exception Details:', error);
  
  // Uncaught exceptions are critical - initiate graceful shutdown
  logger.error('Starting graceful shutdown due to uncaught exception...');
  gracefulShutdown('uncaughtException', 1);
});

// Graceful shutdown on termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT', 0));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0));

// Initialize the application
initialize().catch(logger.error);
