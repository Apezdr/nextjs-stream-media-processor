// MUST BE FIRST - Initialize OpenTelemetry before any other imports
import './lib/telemetry.mjs';

import express from "express";
import { scheduleJob } from "node-schedule";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import { join, resolve, dirname, normalize } from "path";
import { createReadStream } from "fs"; // Callback-based version of fs
import { promises as fs } from "fs"; // Use the promise-based version of fs
import compression from "compression";
import cors from "cors";
import axios from "axios";
import { createSpriteRoutes } from "./sprite-route.mjs";
// P-1b: only the functions app.mjs itself calls. The scan-pipeline writers
// (insertOrUpdateMovie/TVShow, delete*, missing-data bookkeeping) are live via
// scanner-repository.mjs, not here — importing them in app.mjs wrongly implied
// this file participates in scan persistence.
import { initializeDatabase, getMovies, isDatabaseEmpty, getTVShows, getTVShowByName, releaseDatabase, getMediaTableGeneration } from "./sqliteDatabase.mjs";
import { getMediaTypeHashes, getShowHashes, getSeasonHashes, generateMovieHashes, generateTVShowHashes, getHash, updateAllMovieHashes, updateAllTVShowHashes } from "./sqlite/metadataHashes.mjs";
import { initializeTmdbBlurhashCacheTable } from "./sqlite/tmdbBlurhashCache.mjs";
import { setupRoutes } from "./routes/index.mjs";
import {
  sweepOrphanTempFiles as sweepOrphanCaptionTempFiles,
  injectMovieStubs,
  injectTvStubs
} from "./components/caption-generator/index.mjs";
import { authenticateWebhookOrUser } from "./middleware/auth.mjs";
import { generateFrame, fileExists, ensureCacheDirs, mainCacheDir, generalCacheDir, spritesheetCacheDir, framesCacheDir, videoClipsCacheDir, getStoredBlurhash, calculateDirectoryHash, getLastModifiedTime, clearSpritesheetCache, clearFramesCache, clearGeneralCache, clearVideoClipsCache, clearOriginalSegmentsCache, convertToAvif, generateCacheKey, deriveEpisodeTitle, shouldUseAvif } from "./utils/utils.mjs";
import { resolveMovieVideo, resolveEpisodeVideo, findEpisodeEntry } from "./utils/mediaResolution.mjs";
import { buildMoviePayloadEntry, buildTvPayloadEntry } from "./lib/mediaPayload.mjs";
import {
  MediaPayloadCache,
  createMediaListHandler,
  compressionFilter,
  watchPayloadContext,
  autoCaptionsContextKey,
  clearPayloadsAfterScan
} from "./lib/mediaPayloadCache.mjs";
import { tvManifestKeys, createManifestHandler } from "./lib/mediaManifest.mjs";
import { createGlobalJsonParser, mountMediaEntriesRoute } from "./lib/requestBodyParsers.mjs";
import { getAutoCaptionsConfigCached } from "./components/caption-generator/data-access/caption-config.mjs";
import { checkAutoSync, updateLastSyncTime, initializeIndexes } from "./database.mjs";
import { handleVideoClipRequest } from "./videoHandler.mjs";
import { sweepClipTempFiles } from "./ffmpeg/clipEncode.mjs";
import { CURRENT_VERSION, getInfo } from "./infoManager.mjs";
import { fileURLToPath } from "url";
import { createCategoryLogger, createPythonLogger } from "./lib/logger.mjs";
import { createOrUpdateProcessQueue, finalizeProcessQueue, getActiveProcesses, getAllProcesses, getProcessesWithFilters, getProcessTrackingDb, markInProgressAsInterrupted, removeInProgressProcesses, updateProcessQueue } from "./sqlite/processTracking.mjs";
import { createLibraryScanProgress } from "./lib/scanProgress.mjs";
import { TaskType, enqueueTask } from "./lib/taskManager.mjs";
import { createMediaScanHandler, scanIfTableEmpty } from "./lib/libraryScanTask.mjs";
import { createHash } from "crypto";
import { runPython } from "./lib/processRunner.mjs";
import { MetadataGenerator } from "./lib/metadataGenerator.mjs";
import { scanMovies, scanTVShows } from "./components/media-scanner/index.mjs";
import { createIdentityService } from "./integrations/identity/index.mjs";
import { listMultiSourceTitles } from "./sqlite/multiSourceTitles.mjs";
import { setupIdentityRoutes } from "./integrations/identity/routes.mjs";
import { destroyPool } from "./lib/blurhash-pool.mjs";
import { healMissingBlurhashSidecars } from "./lib/blurhashHealing.mjs";
import { langMap } from "./utils/languageMap.mjs";
const logger = createCategoryLogger('main');
const posterLogger = createPythonLogger('GeneratePosterCollage');
const tmdbLogger   = createCategoryLogger('DownloadTMDBImages');
const __filename = fileURLToPath(import.meta.url); // Get __filename
const __dirname = dirname(__filename); // Get __dirname
const app = express();
const LOG_FILE = process.env.LOG_PATH
  ? join(process.env.LOG_PATH, "cron.log")
  : "/var/log/cron.log";
// Define the base path to the tv/movie folders
const BASE_PATH = process.env.BASE_PATH
  ? process.env.BASE_PATH
  : "/var/www/html";
// PREFIX_PATH is used to prefix the URL path for the server. Useful for reverse proxies.
const PREFIX_PATH = process.env.PREFIX_PATH || "";

// Identity providers (Radarr/Sonarr today): exact TMDB ids for managed
// folders, reconciled into tmdb.config at the top of every scan tick and on
// provider webhooks. Enabled purely by provider env; unset = no-op.
// See integrations/identity/README.md.
const identityService = createIdentityService({
  basePath: BASE_PATH,
  logger: createCategoryLogger('identity'),
  requestScan: requestEarlyScan,
  listMultiSourceTitles: () => listMultiSourceTitles(),
});

// A webhook asks for the normal tick to run now. Coalesce: one early run at a
// time, and never a pile-up when a batch of imports lands together.
let earlyScanInFlight = null;
function requestEarlyScan(reason) {
  if (earlyScanInFlight) return earlyScanInFlight;
  logger.info(`Early media scan requested (${reason})`);
  earlyScanInFlight = runGenerateList()
    .catch((error) => logger.error(`Early media scan failed (${reason}): ${error.message ?? error}`))
    .finally(() => { earlyScanInFlight = null; });
  return earlyScanInFlight;
}
const scriptsDir = resolve(__dirname, "../scripts");
// (RETRY_INTERVAL_HOURS used to live here but was dead code after the Python
// scheduled job was removed; the canonical constant now lives in
// node/components/media-scanner/data-access/scanner-repository.mjs.)

const generatePosterCollageScript = join(
  scriptsDir,
  "generate_poster_collage.py"
);

const isDebugMode =
  process.env.DEBUG && process.env.DEBUG.toLowerCase() === "true";
const debugMessage = isDebugMode ? " [Debugging Enabled]" : "";
const CHROME_HEIGHT_LIMIT = 30780; // Chrome's maximum image height limit

// Used to validate the version supported by frontend
// To log a need to update code to support file server
const TV_LIST_VERSION = 1.0001;
const MOVIE_LIST_VERSION = 1.0001;

// Enable compression for all responses, except the cached media lists, which
// send their own gzip copy (lib/mediaPayloadCache.mjs).
app.use(compression({ filter: compressionFilter }));

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

// Parse JSON request bodies (with increased size limit for subtitle uploads),
// except on /api/discord/events, which needs the raw body to verify the
// Discord webhook signature, and on the media entries routes, which parse
// their own body after auth. See lib/requestBodyParsers.mjs.
app.use(createGlobalJsonParser());

ensureCacheDirs();

app.get("/frame/movie/:movieName/:timestamp{.:ext}", (req, res) =>
  handleFrameRequest(req, res, "movies")
);

app.get("/frame/tv/:showName/:season/:episode/:timestamp{.:ext}", (req, res) =>
  handleFrameRequest(req, res, "tv")
);

async function handleFrameRequest(req, res, type) {
  let frameFileName,
    videoPath,
    specificFileName = null,
    wasCached = true;

  const { movieName, showName, season, episode, timestamp } = req.params;
  let movie_name = decodeURIComponent(movieName);
  let show_name = decodeURIComponent(showName);
  // Cant use `:` on Windows so replace with `-`
  const sanitizeTimestamp = timestamp.replace(/:/g, '-');

  let episodeNumber;
  if (type === "movies") {
    frameFileName = `movie_${movie_name}_${sanitizeTimestamp}.avif`;
  } else {
    // Extract episode number
    const episodeMatch =
      episode.match(/E(\d{1,2})/i) || episode.match(/^(\d{1,2})( -)?/);
    episodeNumber = episodeMatch ? episodeMatch[1] : "Unknown"; // Default to 'Unknown' if not found

    frameFileName = `tv_${show_name}_S${season}E${episodeNumber}_${sanitizeTimestamp}.avif`;

    const showData = await getTVShowByName(show_name);
    if (!showData) {
      throw new Error(
        `Season not found: ${show_name} - Season ${season} Episode ${episode}`
      );
    }
    // The stored filename is only a hint — resolveEpisodeVideo falls back to
    // matching the episode by S##E## when the container on disk has changed.
    specificFileName = findEpisodeEntry(showData, season, episode)?.episode?.filename ?? null;
  }

  const framePath = join(framesCacheDir, frameFileName);

  try {
    if (await fileExists(framePath)) {
      // Serve from cache if exists
      logger.info(`Serving cached frame: ${frameFileName}`);
    } else {
      wasCached = false;
      const videoRef =
        type === "movies"
          ? await resolveMovieVideo({ basePath: BASE_PATH, movieName: movie_name })
          : await resolveEpisodeVideo({
              basePath: BASE_PATH,
              showName: show_name,
              season,
              episode,
              preferFilename: specificFileName,
            });
      if (!videoRef) {
        throw new Error(`Video file not found for ${movie_name || show_name}`);
      }
      videoPath = videoRef.path;

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

/**
 * GET /processes
 * Retrieves the current process queue information in JSON format.
 * Requires either webhook authentication or admin user access.
 * Optional query parameters:
 * - active: "true" returns only running or queued processes; the other filters are ignored
 * - processType: Filter by process_type (e.g., "spritesheet", "vtt", "library-scan")
 * - status: Filter by status (e.g., "in-progress", "queued", "completed", "error")
 */
app.get('/processes', authenticateWebhookOrUser, async (req, res) => {
  try {
    const db = await getProcessTrackingDb();

    // Extract query parameters for filtering
    const { processType, status, active } = req.query;

    let processes;
    if (active === 'true') {
      processes = await getActiveProcesses(db);
    } else if (processType || status) {
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

//
// End Cache Management

/**
 * Wrapper function for backward compatibility
 * Calls the new media-scanner component, and shows the scan in /processes
 * @returns {Promise<{titles: number, reprocessed: number, error: Error|null}>}
 *   the scanner's summary; `error` is what stopped the pass, if anything did
 */
async function generateListTV(db, dirPath) {
  const progress = createLibraryScanProgress('tv');
  try {
    const summary = await scanTVShows(
      db,
      dirPath,
      PREFIX_PATH,
      BASE_PATH,
      langMap,
      isDebugMode,
      runDownloadTmdbImages,
      { onProgress: progress.onProgress, managedFilesFor: identityService.managedFilesFor }
    );
    await progress.complete(summary);
    return summary;
  } catch (error) {
    await progress.fail(error);
    throw error;
  }
}

/**
 * The autoCaptions settings the caption stubs are built from, as a cache key.
 * An unreadable config injects no stubs, so it reads as "none" too.
 */
async function readPayloadContext() {
  try {
    return autoCaptionsContextKey(await getAutoCaptionsConfigCached());
  } catch {
    return autoCaptionsContextKey(null);
  }
}

// The /media/tv and /media/movies bodies, built again only when their rows or
// the autoCaptions settings change. See lib/mediaPayloadCache.mjs for when
// they are dropped.
const tvPayloadCache = new MediaPayloadCache({
  kind: 'tv',
  version: TV_LIST_VERSION,
  builder: buildTvPayloadEntry,
  // Each show's season and episode keys, for /media/tv/manifest.
  describe: tvManifestKeys,
  readContext: readPayloadContext,
  // loadRows reads tv_shows only.
  dataGeneration: () => getMediaTableGeneration('tv_shows'),
  logger,
  loadRows: async () => {
    const db = await initializeDatabase();
    // An empty table is scanned first, as a MEDIA_SCAN task: it waits for a
    // running scan tick or healing pass (lib/libraryScanTask.mjs). A scan run
    // from here writes after the build read the generation, so the next clear
    // point drops this body: one extra build, on an empty table.
    await scanIfTableEmpty({
      name: 'TV Show List Generation (empty tv_shows table)',
      isEmpty: () => isDatabaseEmpty("tv_shows"),
      scan: () => generateListTV(db, `${BASE_PATH}/tv`),
    });
    const shows = await getTVShows();
    await releaseDatabase(db);

    // Build-time injection of auto-caption stubs (from the settings, not the
    // rows, which is why a settings change drops the cache).
    await injectTvStubs(shows, langMap);
    return shows;
  },
});

const moviePayloadCache = new MediaPayloadCache({
  kind: 'movies',
  version: MOVIE_LIST_VERSION,
  builder: buildMoviePayloadEntry,
  readContext: readPayloadContext,
  // loadRows reads movies only.
  dataGeneration: () => getMediaTableGeneration('movies'),
  logger,
  loadRows: async () => {
    const db = await initializeDatabase();
    // As for TV: an empty table is scanned first, as a MEDIA_SCAN task.
    await scanIfTableEmpty({
      name: 'Movie List Generation (empty movies table)',
      isEmpty: () => isDatabaseEmpty("movies"),
      scan: () => generateListMovies(db, `${BASE_PATH}/movies`),
    });
    const movies = await getMovies();
    await releaseDatabase(db);

    // Build-time injection of auto-caption stubs (no rescan needed when the
    // autoCaptions flag or language list changes: the cache is dropped).
    await injectMovieStubs(movies, langMap);
    return movies;
  },
});

/**
 * After a scan: drop each cached list body whose rows changed, or both when the
 * scan failed (it may have written some rows before it stopped).
 */
function clearMediaPayloads(reason, { failed = false } = {}) {
  clearPayloadsAfterScan([tvPayloadCache, moviePayloadCache], { reason, failed });
}

app.get(
  "/media/tv",
  authenticateWebhookOrUser,
  createMediaListHandler(tvPayloadCache, { logger, errorLabel: 'Error fetching TV shows' })
);

// Per-title views of the same cached body: a manifest of title hashes (with
// each show's season and episode keys), and the entries for chosen titles.
// See lib/mediaManifest.mjs.
app.get(
  "/media/tv/manifest",
  authenticateWebhookOrUser,
  createManifestHandler(tvPayloadCache, { logger, errorLabel: 'Error building the TV manifest' })
);

// POST /media/tv/entries: auth, then its own body parser, then the handler.
mountMediaEntriesRoute(app, {
  kind: 'tv',
  authenticate: authenticateWebhookOrUser,
  cache: tvPayloadCache,
  logger,
  errorLabel: 'Error sending TV entries',
});

/**
 * Wrapper function for backward compatibility
 * Calls the new media-scanner component, and shows the scan in /processes
 */
async function generateListMovies(db, dirPath) {
  const progress = createLibraryScanProgress('movies');
  try {
    const summary = await scanMovies(
      db,
      dirPath,
      PREFIX_PATH,
      BASE_PATH,
      langMap,
      CURRENT_VERSION,
      isDebugMode,
      runDownloadTmdbImages,
      { onProgress: progress.onProgress, managedFilesFor: identityService.managedFilesFor }
    );
    await progress.complete(summary);
  } catch (error) {
    await progress.fail(error);
    throw error;
  }
}

app.get(
  "/media/movies",
  authenticateWebhookOrUser,
  createMediaListHandler(moviePayloadCache, { logger, errorLabel: 'Error fetching movies' })
);

app.get(
  "/media/movies/manifest",
  authenticateWebhookOrUser,
  createManifestHandler(moviePayloadCache, { logger, errorLabel: 'Error building the movie manifest' })
);

// POST /media/movies/entries: auth, then its own body parser, then the handler.
mountMediaEntriesRoute(app, {
  kind: 'movies',
  authenticate: authenticateWebhookOrUser,
  cache: moviePayloadCache,
  logger,
  errorLabel: 'Error sending movie entries',
});

// The movie scan, as a MEDIA_SCAN task: it waits for a running scan tick or
// healing pass, then answers 200 when it is done (lib/libraryScanTask.mjs).
app.post("/media/scan", authenticateWebhookOrUser, createMediaScanHandler({
  openDatabase: () => initializeDatabase(),
  scanMovies: (db) => generateListMovies(db, `${BASE_PATH}/movies`),
  releaseDatabase,
  clearPayloads: clearMediaPayloads,
  logger,
}));

async function runGeneratePosterCollage() {
  const debugMessage = isDebugMode ? ' with debug' : '';
  posterLogger.info(`Running generate_poster_collage.py job${debugMessage}`);
  await runPython({
    scriptPath: generatePosterCollageScript,
    args: [],                       // no extra flags
    label: 'GeneratePosterCollage', // appears in the log prefix
    logger: posterLogger,          
    logFile: LOG_FILE,              // cron.log, written only in debug mode
    debug: isDebugMode,             // redirect to file when true
    env: {
      ...process.env,
      DEBUG: process.env.DEBUG,
      TMDB_API_KEY: process.env.TMDB_API_KEY,
    }
  });
}
/**
 * Run a TMDB image download cycle for a single show, a single movie, or the
 * whole library. Migrated from the legacy Python `download_tmdb_images.py`
 * script to the Node MetadataGenerator.
 *
 * @param {Object} [options]
 * @param {string|null} [options.showName=null]  - Run a single show
 * @param {string|null} [options.movieName=null] - Run a single movie
 * @param {boolean} [options.fullScan=false]     - Force-refresh entire library
 *   (sets `forceRefresh: true` on the MetadataGenerator, which propagates
 *   `forceDownload: true` to `downloadMediaImages`)
 * @param {Object|null} [options.previousPaths=null] - `{ poster, backdrop, logo }`
 *   from the scanner's existing DB row for the item. Used by the reconcile
 *   step in MetadataGenerator to detect orphans (previously-managed file
 *   path differs from what the current URL would produce). Null is safe —
 *   reconcile no-ops the orphan branch when previousPaths is null.
 * @param {Object|null} [options.previousSourceUrls=null] - `{ poster, backdrop, logo }`
 *   stored `*_source_url` download provenance from the scanner's DB row (I-3).
 *   Used by reconcile to detect upstream URL changes (stale-by-source-url) and
 *   by the generator to decide per-kind provenance updates. Null is safe —
 *   NULL provenance means "unknown" and skips the comparison (bootstrap rule).
 * @returns {Promise<Object>} Result from `MetadataGenerator.generateImages`,
 *   includes per-image-type outcomes the scanner uses for post-condition
 *   logging, plus the `sourceUrls` provenance updates to persist.
 */
async function runDownloadTmdbImages({
  showName = null,
  movieName = null,
  fullScan = false,
  previousPaths = null,
  previousSourceUrls = null,
} = {}) {
  // Debug: this fires once per scanner gate trigger, including invocations
  // that resolve to a frozen no-op inside the generator. Real work is logged
  // at info by the generator's own completion/summary lines.
  tmdbLogger.debug(
    `Running TMDB image download via Node MetadataGenerator` +
    `${showName ? ` for show "${showName}"` : ''}` +
    `${movieName ? ` for movie "${movieName}"` : ''}` +
    `${fullScan ? ' (full scan / forceRefresh)' : ''}`
  );

  try {
    const generator = await MetadataGenerator.create({
      basePath: BASE_PATH,
      forceRefresh: fullScan,
      generateBlurhash: true,
    });

    return await generator.generateImages({ showName, movieName, previousPaths, previousSourceUrls });
  } catch (error) {
    tmdbLogger.error(`TMDB image download failed: ${error.message}`);
    throw error;
  }
}

// Clipping routes for movies and TV shows
app.get("/videoClip/movie/:movieName", async (req, res) => {
  await handleVideoClipRequest(req, res, "movies", BASE_PATH);
});

app.get("/videoClip/tv/:showName/:season/:episode", async (req, res) => {
  await handleVideoClipRequest(req, res, "tv", BASE_PATH);
});

let isScanning = false;

async function runGenerateList() {
  // Use the MEDIA_SCAN task type for overall orchestration
  return enqueueTask(TaskType.MEDIA_SCAN, 'Media List Generation', async () => {
    logger.info('Generating media list - controlled by task manager');

    // Identity reconcile FIRST, so any tmdb.config it writes is already on
    // disk when the scanners below read mtimes. Never throws; disabled = no-op.
    await identityService.reconcileForTick();

    let scanFailed = true;
    try {
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
      const tvSummary = await enqueueTask(TaskType.TV_SCAN, 'TV Show List Generation', async () => {
        const tvDb = await initializeDatabase();
        try {
          logger.info('Processing TV shows');
          const summary = await generateListTV(tvDb, `${BASE_PATH}/tv`);
          logger.info('Finished processing TV shows');
          return summary;
        } catch (error) {
          logger.error(`Error processing TV shows: ${error}`);
          throw error; // Allow task manager to handle the error
        } finally {
          await releaseDatabase(tvDb);
        }
      });
      // The TV scanner logs the error that stopped it and returns it rather
      // than throwing: that is a failed scan too.
      scanFailed = Boolean(tvSummary?.error);
    } finally {
      // Before the sync push below, so the sync it starts reads this scan's
      // rows. A body is dropped only if its rows changed, so after a quiet tick
      // the sync's conditional GET is a 304 without a rebuild. A scan that
      // failed part-way drops both: it may still have written some rows.
      clearMediaPayloads('scan tick', { failed: scanFailed });
    }

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
  // NOTE: The scheduled bulk TMDB image refresh that previously ran at
  // 7, 25, 43 minutes past the hour was removed when the workload moved
  // from `scripts/download_tmdb_images.py` to the in-process Node
  // MetadataGenerator. The scanners triggered by `runGenerateList`
  // (every 3 minutes, below) already drive `runDownloadTmdbImages` for
  // any media flagged as missing data, so a separate blanket refresh
  // is redundant.

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
  
  // The overnight frames/spritesheet/clips cleanups are scheduled ONCE, at
  // module level, through the CACHE_CLEANUP task gate. The direct
  // (gate-bypassing) duplicates that used to live here were removed (V-1) —
  // re-adding a cleanup here without enqueueTask would race the gated ones.
}

/**
 * The blurhash sidecar healing pass, as a BLURHASH task. The task manager
 * never runs a BLURHASH task beside a MEDIA_SCAN (one exclusive group), so the
 * pass and a scheduled scan tick cannot write the same sidecar at once; a tick
 * that comes due meanwhile waits for it. Rows are read when the task starts,
 * so they are the startup scan's.
 */
function healBlurhashSidecars() {
  return enqueueTask(TaskType.BLURHASH, 'Blurhash Sidecar Healing', async () => {
    const summary = await healMissingBlurhashSidecars({
      movies: await getMovies(),
      shows: await getTVShows(),
      basePath: BASE_PATH,
      prefixPath: PREFIX_PATH,
    });
    logger.info(
      `Blurhash sidecar healing: checked ${summary.checked}, generated ${summary.generated}, failed ${summary.failed}`
    );
    return summary;
  });
}

async function initialize() {
  await ensureCacheDirs();
  // An encode cut short by a restart leaves its temp file in the clip cache.
  // Swept here, before the server listens: once requests arrive, a temp file
  // may belong to an encode that is still running.
  await sweepClipTempFiles(videoClipsCacheDir)
    .then(removed => { if (removed > 0) logger.info(`Removed ${removed} unfinished clip temp file(s)`); })
    .catch(err => logger.error(`Clip temp sweep failed: ${err.message}`));
  const port = 3000;
  server = app.listen(port, async () => {
    scheduleTasks();
    // The autoCaptions settings live in Mongo and the frontend writes them, so
    // the cached list bodies learn of a change by polling.
    watchPayloadContext([tvPayloadCache, moviePayloadCache], { logger });
    // The identity reconcile has its own cadence (IDENTITY_RECONCILE_INTERVAL_SECONDS,
    // default 60s) so the report stays fresh while a long scan tick runs.
    identityService.start();
    //runGenerateThumbnailJson().catch(logger.error);
    logger.info(`Server running on port ${port}`);
    // Opens media.db, whose schema setup also drops the retired
    // blurhash_hashes table (dropRetiredTables in sqliteDatabase.mjs).
    await initializeDatabase();

  // As part of startup clear out any in progress processes from the process tracking database
  // This will prevent any processes from being stuck in the queue
  await markInProgressAsInterrupted(); // This will use the dedicated processTracking database
  logger.info('Process queue has been reset.');
    initializeIndexes()
      .then(() => {
        logger.info("Mongo indexes initialized successfully.");
      })
      .catch((error) => {
        logger.error("Error during initialization:", error);
      });
    runGenerateList()
      .catch(logger.error)
      // Once per process, after the startup scan: write the sidecar of any
      // published image that has none (lib/blurhashHealing.mjs).
      .then(() => healBlurhashSidecars())
      .catch((error) => logger.error(`Blurhash sidecar healing failed: ${error?.message ?? error}`));
    runGeneratePosterCollage().catch(logger.error);
    // Sweep stale caption-generator temp files left behind by interrupted jobs
    sweepOrphanCaptionTempFiles().catch(err => logger.error(`Caption temp sweep failed: ${err.message}`));
  });
}

// Use the modular route system
// Identity provider webhooks + status/report: the service instance lives
// here, so the routes mount here.
app.use('/api', setupIdentityRoutes(identityService));
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
        routes: ['/media/movies', '/media/tv', '/media/movies/manifest', '/media/tv/manifest', '/media/movies/entries', '/media/tv/entries', '/media/scan']
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
      clips: {
        description: 'Video clip generation',
        routes: ['/videoClip/movie/:movieName', '/videoClip/tv/:showName/:season/:episode']
      },
      processes: {
        description: 'Process tracking',
        routes: ['/processes']
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
        '/api/metadata-hashes/:mediaType - Get metadata hashes',
        '/api/system-status - System status information',
        '/api/logs - Server logs (admin)'
      ]
    },
    '/media': {
      description: 'Media library endpoints',
      endpoints: [
        '/media/movies - List all movies',
        '/media/tv - List all TV shows',
        '/media/movies/manifest, /media/tv/manifest - Per-title hashes (TV: season and episode keys)',
        '/media/movies/entries, /media/tv/entries - POST {titles} or {all}: chosen entries as NDJSON',
        '/media/scan - POST: scan the movie library, after any running scan; 200 when done'
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
        '/processes - List all processes'
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

    // Stop the identity reconcile job (a run in flight finishes on its own)
    identityService.stop();

    // Close Discord client if it exists
    try {
      const { NotificationManager } = await import('./integrations/index.mjs');
      // Access any global notification manager instance to close Discord
      logger.info('Closing Discord connections...');
    } catch (error) {
      logger.warn('Could not close Discord connections:', error.message);
    }

    // Destroy blurhash worker pool
    try {
      logger.info('Destroying blurhash worker pool...');
      await destroyPool();
    } catch (error) {
      logger.warn('Error destroying blurhash worker pool:', error.message);
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
