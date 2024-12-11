const express = require("express");
const schedule = require("node-schedule");
const { exec } = require("child_process");
const util = require("util");
const os = require("os");
const path = require("path");
const _fs = require("fs"); // Callback-based version of fs
const fs = require("fs").promises; // Use the promise-based version of fs
const compression = require("compression");
const axios = require("axios");
const app = express();
const thumbnailGenerationInProgress = new Set();
const { generateSpriteSheet } = require("./sprite");
const {
  initializeDatabase,
  insertOrUpdateMovie,
  getMovies,
  isDatabaseEmpty,
  getTVShows,
  insertOrUpdateTVShow,
  insertOrUpdateMissingDataMedia,
  getMissingDataMedia,
  deleteMovie,
  deleteTVShow,
  getMovieByName,
  getTVShowByName,
  releaseDatabase,
} = require("./sqliteDatabase");
const {
  generateFrame,
  getVideoDuration,
  fileExists,
  ensureCacheDirs,
  mainCacheDir,
  generalCacheDir,
  spritesheetCacheDir,
  framesCacheDir,
  findMp4File,
  getStoredBlurhash,
  calculateDirectoryHash,
  getLastModifiedTime,
  clearSpritesheetCache,
  clearFramesCache,
  clearGeneralCache,
  clearVideoClipsCache,
  convertToAvif,
  generateCacheKey,
} = require("./utils");
const { generateChapters, hasChapterInfo } = require("./chapter-generator");
const {
  checkAutoSync,
  updateLastSyncTime,
  initializeIndexes,
  initializeMongoDatabase,
} = require("./database");
const {
  handleVideoRequest,
  handleVideoClipRequest,
} = require("./videoHandler");
const sharp = require("sharp");
const { getInfo, getHeaderData } = require("./infoManager");
const execAsync = util.promisify(exec);
//const { handleVideoRequest } = require("./videoHandler");
const LOG_FILE = process.env.LOG_PATH
  ? path.join(process.env.LOG_PATH, "cron.log")
  : "/var/log/cron.log";
// Define the base path to the tv/movie folders
const BASE_PATH = process.env.BASE_PATH
  ? process.env.BASE_PATH
  : "/var/www/html";
// PREFIX_PATH is used to prefix the URL path for the server. Useful for reverse proxies.
const PREFIX_PATH = process.env.PREFIX_PATH || "";
const scriptsDir = path.resolve(__dirname, "../scripts");
// Moderately spaced out interval to check for missing data
const RETRY_INTERVAL_HOURS = 24; // Interval to retry downloading missing tmdb data

const generatePosterCollageScript = path.join(
  scriptsDir,
  "generate_poster_collage.py"
);
const downloadTmdbImagesScript = path.join(
  scriptsDir,
  "download_tmdb_images.py"
);
//const generateThumbnailJsonScript = path.join(scriptsDir, 'generate_thumbnail_json.sh');

const isDebugMode =
  process.env.DEBUG && process.env.DEBUG.toLowerCase() === "true";
const debugMessage = isDebugMode ? " [Debugging Enabled]" : "";
const CHROME_HEIGHT_LIMIT = 30780; // Chrome's maximum image height limit

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

  if (type === "movies") {
    directoryPath = path.join(`${BASE_PATH}/movies`, movie_name);
    frameFileName = `movie_${movie_name}_${timestamp}.avif`;
  } else {
    // Extract episode number
    const episodeMatch =
      episode.match(/E(\d{1,2})/i) || episode.match(/^(\d{1,2})( -)?/);
    const episodeNumber = episodeMatch ? episodeMatch[1] : "Unknown"; // Default to 'Unknown' if not found

    directoryPath = path.join(`${BASE_PATH}/tv`, show_name, `Season ${season}`);
    frameFileName = `tv_${show_name}_S${season}E${episodeNumber}_${timestamp}.avif`;

    const db = await initializeDatabase();
    const showData = await getTVShowByName(db, show_name);
    await releaseDatabase(db);
    if (showData) {
      const _season = showData.metadata.seasons[`Season ${season}`];
      if (_season) {
        const _episode = _season.fileNames.find((e) => {
          // Match S01E01 format
          const standardMatch = e.match(/S(\d{2})E(\d{2})/i);
          if (standardMatch) {
            const seasonNum = standardMatch[1].padStart(2, "0");
            const episodeNum = standardMatch[2].padStart(2, "0");
            return (
              seasonNum === season.padStart(2, "0") &&
              episodeNum === episodeNumber.padStart(2, "0")
            );
          }

          // Match "01 - Episode Name.mp4" format
          const alternateMatch = e.match(/^(\d{2})\s*-/);
          if (alternateMatch) {
            const episodeNum = alternateMatch[1].padStart(2, "0");
            // For this format, we assume the file is already in the correct season folder
            // so we only need to match the episode number
            return episodeNum === episodeNumber.padStart(2, "0");
          }

          // No match found
          return false;
        });

        if (_episode) {
          specificFileName = _episode;
        } else {
          throw new Error(
            `Episode not found: ${show_name} - Season ${season} Episode ${episode}`
          );
        }
      } else {
        throw new Error(
          `Season not found: ${show_name} - Season ${season} Episode ${episode}`
        );
      }
    }
  }

  const framePath = path.join(framesCacheDir, frameFileName);

  try {
    if (await fileExists(framePath)) {
      // Serve from cache if exists
      console.log(`Serving cached frame: ${frameFileName}`);
    } else {
      wasCached = false;
      // Find the MP4 file dynamically
      videoPath = await findMp4File(directoryPath, specificFileName, framePath);

      // Generate the frame
      await generateFrame(videoPath, timestamp, framePath);
      console.log(`Generated new frame: ${frameFileName}`);
    }

    res.sendFile(framePath);

    //
    // Historic usage where it would generate
    // all frames for a given media file, this
    // is no longer necessary.
    //
    // Check if thumbnail generation is in progress to avoid duplication
    // if (!thumbnailGenerationInProgress.has(videoPath) && videoPath) {
    //   thumbnailGenerationInProgress.add(videoPath);
    //   generateAllThumbnails(
    //     videoPath,
    //     type,
    //     req.params.movieName ||
    //       (req.params.showName ? req.params.showName.replace(/%20/g, " ") : ""),
    //     req.params.season ? req.params.season.replace(/%20/g, " ") : "",
    //     req.params.episode
    //   )
    //     .then(() => {
    //       console.log("Processing complete show generation");
    //       thumbnailGenerationInProgress.delete(videoPath);
    //     })
    //     .catch((error) => {
    //       console.error(error);
    //       thumbnailGenerationInProgress.delete(videoPath);
    //     });
    // }
  } catch (error) {
    console.error(error);
    return res.status(404).send("Video file not found");
  }
}

// Historic, no longer necessary
//
// async function generateAllThumbnails(
//   videoPath,
//   type,
//   name,
//   season = null,
//   episode = null
// ) {
//   try {
//     const duration = await getVideoDuration(videoPath);
//     const floorDuration = Math.floor(duration);
//     console.log(`Total Duration: ${floorDuration} seconds`);

//     const interval = 5; // Adjust if needed for debugging
//     for (
//       let currentTime = 0;
//       currentTime <= floorDuration;
//       currentTime += interval
//     ) {
//       let timestamp = new Date(currentTime * 1000).toISOString().substr(11, 8);
//       console.log(`Processing timestamp: ${timestamp}`); // Debugging log

//       let frameFileName;
//       if (type === "movies") {
//         frameFileName = `movie_${name}_${timestamp}.jpg`;
//       } else if (type === "tv") {
//         frameFileName = `${type}_${name}_${season}_${episode}_${timestamp}.jpg`;
//       }

//       let framePath = path.join(framesCacheDir, frameFileName);

//       if (!(await fileExists(framePath))) {
//         console.log(`Generating new frame: ${frameFileName}`);
//         await generateFrame(videoPath, timestamp, framePath);
//       } else {
//         console.log(`Frame already exists: ${frameFileName}, skipping...`);
//       }
//     }
//   } catch (error) {
//     console.error(`Error in generateAllThumbnails: ${error}`);
//   }
// }

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
    return path.join(BASE_PATH, videoMp4);
  } else {
    const showData = await getTVShowByName(db, showName);
    if (!showData) {
      throw new Error(`Show not found: ${showName}`);
    }

    const _season = showData.metadata.seasons[`Season ${season}`];
    if (!_season) {
      throw new Error(`Season not found: ${showName} - Season ${season}`);
    }

    const _episode = _season.fileNames.find((e) => {
      const episodeNumber = episode.padStart(2, "0");
      const seasonNumber = season.padStart(2, "0");

      // Match S01E01 format
      const standardMatch = e.match(/S(\d{2})E(\d{2})/i);
      if (standardMatch) {
        const matchedSeason = standardMatch[1].padStart(2, "0");
        const matchedEpisode = standardMatch[2].padStart(2, "0");
        return (
          matchedSeason === seasonNumber && matchedEpisode === episodeNumber
        );
      }

      // Match "01 - Episode Name.mp4" format or variations
      const alternateMatch = e.match(/^(\d{2})\s*-/);
      if (alternateMatch) {
        const matchedEpisode = alternateMatch[1].padStart(2, "0");
        return matchedEpisode === episodeNumber;
      }

      // Legacy format matches (keeping for backward compatibility)
      return (
        e.includes(` - `) &&
        (e.startsWith(episodeNumber) || e.includes(` ${episodeNumber} - `))
      );
    });

    if (!_episode) {
      throw new Error(
        `Episode not found; video path not found: ${showName} - Season ${season} Episode ${episode}`
      );
    }

    return path.join(`${BASE_PATH}/tv`, showName, `Season ${season}`, _episode);
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
    const { movieName, showName, season, episode } = req.params;
    let spriteSheetFileName;

    if (type === "movies") {
      spriteSheetFileName = `movie_${movieName}_spritesheet`;
    } else if (type === "tv") {
      spriteSheetFileName = `tv_${showName}_${season}_${episode}_spritesheet`;
    }

    // Check both formats
    const avifPath = path.join(
      spritesheetCacheDir,
      spriteSheetFileName + ".avif"
    );
    const pngPath = path.join(
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
      console.log(`Serving existing sprite sheet: ${existingPath}`);

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
              console.log(
                `Background conversion to AVIF successful: ${avifPath}`
              );
            } catch (error) {
              console.error("Background AVIF conversion failed:", error);
            }
            return;
          }
        } catch (error) {
          console.error("Error checking PNG dimensions:", error);
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
      });

      // Process queued requests
      const queuedRequests = spriteSheetRequestQueues.get(fileKey) || [];
      spriteSheetRequestQueues.delete(fileKey);
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
      throw error;
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    }
  }
}

async function handleVttRequest(req, res, type) {
  const db = await initializeDatabase();
  const { movieName, showName, season, episode } = req.params;
  let vttFileName;

  if (type === "movies") {
    vttFileName = `movie_${movieName}_spritesheet.vtt`;
  } else if (type === "tv") {
    vttFileName = `tv_${showName}_${season}_${episode}_spritesheet.vtt`;
  }

  const vttFilePath = path.join(spritesheetCacheDir, vttFileName);

  try {
    if (await fileExists(vttFilePath)) {
      console.log(`Serving VTT file from cache: ${vttFileName}`);
      res.setHeader("Content-Type", "text/vtt");
      const fileStream = _fs.createReadStream(vttFilePath);
      fileStream.pipe(res);
    } else {
      console.log(`VTT file not found in cache: ${vttFileName}`);

      const fileKey =
        type === "movies"
          ? `movie_${movieName}`
          : `tv_${showName}_${season}_${episode}`;
      if (vttProcessingFiles.has(fileKey)) {
        console.log(
          `VTT file ${fileKey} is already being processed. Adding request to queue.`
        );
        if (!vttRequestQueues.has(fileKey)) {
          vttRequestQueues.set(fileKey, []);
        }
        vttRequestQueues.get(fileKey).push(res);
        return;
      }
      vttProcessingFiles.add(fileKey);

      // Generate the VTT file
      let videoPath;
      if (type === "movies") {
        const movie = await getMovieByName(db, movieName);
        if (!movie) {
          vttProcessingFiles.delete(fileKey);
          return res.status(404).send(`Movie not found: ${movieName}`);
        }
        videoMp4 = movie.urls.mp4;
        videoMp4 = decodeURIComponent(videoMp4);
        videoPath = path.join(BASE_PATH, videoMp4);
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
            const _season = showData.metadata.seasons[`Season ${season}`];
            if (_season) {
              const _episode = _season.fileNames.find((e) => {
                const episodeNumber = episode.padStart(2, "0");
                const seasonNumber = season.padStart(2, "0");
              
                // Match S01E01 format
                const standardMatch = e.match(/S(\d{2})E(\d{2})/i);
                if (standardMatch) {
                  const matchedSeason = standardMatch[1].padStart(2, "0");
                  const matchedEpisode = standardMatch[2].padStart(2, "0");
                  return matchedSeason === seasonNumber && matchedEpisode === episodeNumber;
                }
              
                // Match "01 - Episode Name.mp4" format or variations
                const alternateMatch = e.match(/^(\d{2})\s*-/);
                if (alternateMatch) {
                  const matchedEpisode = alternateMatch[1].padStart(2, "0");
                  return matchedEpisode === episodeNumber;
                }
              
                // Legacy format matches (keeping for backward compatibility)
                return (
                  e.includes(` - `) &&
                  (e.startsWith(episodeNumber) ||
                   e.includes(` ${episodeNumber} - `))
                );
              });
              
              if (_episode) {
                const directoryPath = path.join(
                  `${BASE_PATH}/tv`,
                  showName,
                  `Season ${season}`
                );
                videoPath = path.join(directoryPath, _episode);
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
          console.error(`Error accessing tv db data: ${error.message}`);
          vttProcessingFiles.delete(fileKey);
          return res.status(500).send("Internal server error");
        }
      }
      await releaseDatabase(db);
      await generateSpriteSheet({
        videoPath,
        type,
        name: movieName || showName,
        season,
        episode,
        cacheDir: spritesheetCacheDir,
      });

      vttProcessingFiles.delete(fileKey);

      if (await fileExists(vttFilePath)) {
        // Process queued requests
        const queuedRequests = vttRequestQueues.get(fileKey) || [];
        vttRequestQueues.delete(fileKey);
        queuedRequests.forEach((queuedRes) => {
          queuedRes.setHeader("Content-Type", "text/vtt");
          const fileStream = _fs.createReadStream(vttFilePath);
          fileStream.pipe(queuedRes);
        });

        // Stream the generated VTT file
        res.setHeader("Content-Type", "text/vtt");
        const fileStream = _fs.createReadStream(vttFilePath);
        fileStream.pipe(res);
      }
    }
  } catch (error) {
    console.error(error);
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
    videoMp4 = JSON.parse(movie.urls).mp4;
    videoMp4 = decodeURIComponent(videoMp4);
    videoPath = path.join(BASE_PATH, videoMp4);
    const movieFileName = path.basename(videoPath, path.extname(videoPath));
    chapterFileName = `${movieFileName}_chapters.vtt`;
    mediaPath = path.join(
      `${BASE_PATH}/movies`,
      movieName,
      `${movieFileName}.mp4`
    );
    chapterFilePath = path.join(
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
        for (const seasonName in showData.metadata.seasons) {
          const season = showData.metadata.seasons[seasonName];
          for (const episodeFileName of season.fileNames) {
            const episodeNumber = getEpisodeNumber(episodeFileName);
            const seasonNumber = seasonName.replace("Season ", "");
            const chapterFilePath = path.join(
              `${BASE_PATH}/tv`,
              showName,
              seasonName,
              "chapters",
              `${showName} - S${seasonNumber.padStart(
                2,
                "0"
              )}E${episodeNumber.padStart(2, "0")}_chapters.vtt`
            );
            const directoryPath = path.join(
              `${BASE_PATH}/tv`,
              showName,
              seasonName
            );
            const mediaPath = path.join(directoryPath, episodeFileName);

            await generateChapterFileIfNotExists(chapterFilePath, mediaPath);
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
        for (const seasonName in showData.metadata.seasons) {
          const season = showData.metadata.seasons[seasonName];
          for (const episodeFileName of season.fileNames) {
            const episodeNumber = getEpisodeNumber(episodeFileName);
            const seasonNumber = seasonName.replace("Season ", "");
            const chapterFilePath = path.join(
              `${BASE_PATH}/tv`,
              showName,
              seasonName,
              "chapters",
              `${showName} - S${seasonNumber.padStart(
                2,
                "0"
              )}E${episodeNumber.padStart(2, "0")}_chapters.vtt`
            );
            const directoryPath = path.join(
              `${BASE_PATH}/tv`,
              showName,
              seasonName
            );
            const mediaPath = path.join(directoryPath, episodeFileName);

            await generateChapterFileIfNotExists(chapterFilePath, mediaPath);
          }
        }

        return res.status(200).send("Chapter files generated successfully");
      } else {
        return res.status(404).send(`Show not found: ${showName}`);
      }
    } else {
      const directoryPath = path.join(
        `${BASE_PATH}/tv`,
        showName,
        `Season ${season}`
      );
      const episodeNumber = episode.padStart(2, "0");
      const seasonNumber = season.padStart(2, "0");
      chapterFileName = `${showName} - S${seasonNumber}E${episodeNumber}_chapters.vtt`;
      chapterFilePath = path.join(directoryPath, "chapters", chapterFileName);

      try {
        const mp4Files = await fs.readdir(directoryPath);
        const mp4File = mp4Files.find(
          (file) =>
            file.includes(`S${seasonNumber}E${episodeNumber}`) &&
            file.endsWith(".mp4")
        );

        if (mp4File) {
          mediaPath = path.join(directoryPath, mp4File);
        } else {
          console.error(
            `Associated MP4 file not found for ${showName} - S${seasonNumber}E${episodeNumber}`
          );
          return res.status(404).send("Associated MP4 file not found");
        }
      } catch (error) {
        console.error(
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

async function generateChapterFileIfNotExists(chapterFilePath, mediaPath) {
  try {
    if (await fileExists(chapterFilePath)) {
      console.log(
        `Serving chapter file from cache: ${path.basename(chapterFilePath)}`
      );
    } else {
      console.log(
        `Chapter file not found in cache: ${path.basename(chapterFilePath)}`
      );

      // Check if the media file has chapter information
      const hasChapters = await hasChapterInfo(mediaPath);

      if (hasChapters) {
        // Create the chapters directory if it doesn't exist
        await fs.mkdir(path.dirname(chapterFilePath), { recursive: true });

        // If the media file has chapter information, generate the chapter file
        const chapterContent = await generateChapters(mediaPath);

        // Save the generated chapter content to the file
        await fs.writeFile(chapterFilePath, chapterContent);
        console.log("The file has been saved!");
      } else {
        // If the media file doesn't have chapter information, send a 404 response
        console.warn(
          `Chapter information not found for ${path.basename(mediaPath)}`
        );
      }
    }
  } catch (error) {
    if (error.code === "EACCES") {
      console.error(
        `Permission denied while accessing ${chapterFilePath}.\nPlease check the directory permissions.`,
        error
      );
    } else {
      console.error(
        `Error generating chapter file for ${path.basename(mediaPath)}:`,
        error
      );
    }
  }
}

//
// Handle MP4 Audio requests
app.get("/video/movie/:movieName", async (req, res) => {
  await handleVideoRequest(req, res, "movies", BASE_PATH);
});

app.get("/rescan/tmdb", async (req, res) => {
  try {
    await runDownloadTmdbImages(null, null, true);
    res.status(200).send("Rescan initiated");
  } catch (error) {
    console.error(error);
    res.status(500).send("Rescan Failed: Internal server error");
  }
});

// app.get("/video/tv/:showName/:season/:episode", async (req, res) => {
//  await handleVideoRequest(req, res, "tv");
// });

//
// Clear General Cache every 30 minutes
setInterval(() => {
  console.log("Running General Cache Cleanup...");
  clearGeneralCache()
    .then(() => {
      console.log("General Cache Cleanup Completed.");
    })
    .catch((error) => {
      console.error(`General Cache Cleanup Error: ${error.message}`);
    });
}, 30 * 60 * 1000); // 30 minutes

// Clear Video Clips Cache every 24 hours
setInterval(() => {
  console.log("Running Video Clips Cache Cleanup...");
  clearVideoClipsCache()
    .then(() => {
      console.log("Video Clips Cache Cleanup Completed.");
    })
    .catch((error) => {
      console.error(`Video Clips Cache Cleanup Error: ${error.message}`);
    });
}, 24 * 60 * 60 * 1000); // 24 hours

//Clear Spritesheet Cache every day
setInterval(() => {
  console.log("Running Spritesheet Cache Cleanup...");
  clearSpritesheetCache()
    .then(() => {
      console.log("Spritesheet Cache Cleanup Completed.");
    })
    .catch((error) => {
      console.error(`Spritesheet Cache Cleanup Error: ${error.message}`);
    });
}, 24 * 60 * 60 * 1000); // 24 hours

//Clear Frames Cache every day
setInterval(() => {
  console.log("Running Frames Cache Cleanup...");
  clearFramesCache()
    .then(() => {
      console.log("Frames Cache Cleanup Completed.");
    })
    .catch((error) => {
      console.error(`Frames Cache Cleanup Error: ${error.message}`);
    });
}, 24 * 60 * 60 * 1000); // 24 hours
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
        console.log(
          `Processing show: ${show.name}: ${index + 1} of ${shows.length}`
        );
      }
      if (show.isDirectory()) {
        const showName = show.name;
        existingShowNames.delete(showName); // Remove from the set of existing shows
        const encodedShowName = encodeURIComponent(showName);
        const showPath = path.normalize(path.join(dirPath, showName));
        const allItems = await fs.readdir(showPath, { withFileTypes: true });
        const seasonFolders = allItems.filter(
          (item) => item.isDirectory() && item.name.startsWith("Season")
        );
        const sortedSeasonFolders = seasonFolders.sort((a, b) => {
          const aNum = parseInt(a.name.replace("Season", ""));
          const bNum = parseInt(b.name.replace("Season", ""));
          return aNum - bNum;
        });
        const otherItems = allItems.filter(
          (item) => !seasonFolders.includes(item)
        );
        const seasons = [...sortedSeasonFolders, ...otherItems];

        const showMetadata = {
          metadata: `${PREFIX_PATH}/tv/${encodedShowName}/metadata.json`,
          seasons: {},
        };

        // Initialize runDownloadTmdbImagesFlag
        let runDownloadTmdbImagesFlag = false;

        // Handle show poster, logo, and backdrop
        const posterPath = path.normalize(
          path.join(showPath, "show_poster.jpg")
        );
        if (await fileExists(posterPath)) {
          showMetadata.poster = `${PREFIX_PATH}/tv/${encodedShowName}/show_poster.jpg`;
          const posterBlurhash = await getStoredBlurhash(posterPath, BASE_PATH);
          if (posterBlurhash) {
            showMetadata.posterBlurhash = posterBlurhash;
          }
        } else {
          runDownloadTmdbImagesFlag = true;
        }

        const logoExtensions = ["svg", "jpg", "png", "gif"];
        let logoFound = false;
        for (const ext of logoExtensions) {
          const logoPath = path.normalize(
            path.join(showPath, `show_logo.${ext}`)
          );
          if (await fileExists(logoPath)) {
            showMetadata.logo = `${PREFIX_PATH}/tv/${encodedShowName}/show_logo.${ext}`;
            if (ext !== "svg") {
              const logoBlurhash = await getStoredBlurhash(logoPath, BASE_PATH);
              if (logoBlurhash) {
                showMetadata.logoBlurhash = logoBlurhash;
              }
            }
            logoFound = true;
            break;
          }
        }
        if (!logoFound) {
          runDownloadTmdbImagesFlag = true;
        }

        const backdropExtensions = ["jpg", "png", "gif"];
        let backdropFound = false;
        for (const ext of backdropExtensions) {
          const backdropPath = path.normalize(
            path.join(showPath, `show_backdrop.${ext}`)
          );
          if (await fileExists(backdropPath)) {
            showMetadata.backdrop = `${PREFIX_PATH}/tv/${encodedShowName}/show_backdrop.${ext}`;
            const backdropBlurhash = await getStoredBlurhash(
              backdropPath,
              BASE_PATH
            );
            if (backdropBlurhash) {
              showMetadata.backdropBlurhash = backdropBlurhash;
            }
            backdropFound = true;
            break;
          }
        }
        if (!backdropFound) {
          runDownloadTmdbImagesFlag = true;
        }

        const metadataPath = path.normalize(
          path.join(showPath, "metadata.json")
        );
        if (!(await fileExists(metadataPath))) {
          runDownloadTmdbImagesFlag = true;
        }

        const missingDataShow = missingDataMedia.find(
          (media) => media.name === showName
        );
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

          if (retryFileSet.has("show_poster.jpg")) {
            showMetadata.poster = `${PREFIX_PATH}/tv/${encodedShowName}/show_poster.jpg`;
            const posterBlurhash = await getStoredBlurhash(
              path.normalize(path.join(showPath, "show_poster.jpg")),
              BASE_PATH
            );
            if (posterBlurhash) {
              showMetadata.posterBlurhash = posterBlurhash;
            }
          }

          for (const ext of logoExtensions) {
            const logoPath = path.join(showPath, `show_logo.${ext}`);
            if (retryFileSet.has(`show_logo.${ext}`)) {
              showMetadata.logo = `${PREFIX_PATH}/tv/${encodedShowName}/show_logo.${ext}`;
              if (ext !== "svg") {
                const logoBlurhash = await getStoredBlurhash(
                  logoPath,
                  BASE_PATH
                );
                if (logoBlurhash) {
                  showMetadata.logoBlurhash = logoBlurhash;
                }
              }
              break;
            }
          }

          for (const ext of backdropExtensions) {
            const backdropPath = path.join(showPath, `show_backdrop.${ext}`);
            if (retryFileSet.has(`show_backdrop.${ext}`)) {
              showMetadata.backdrop = `${PREFIX_PATH}/tv/${encodedShowName}/show_backdrop.${ext}`;
              const backdropBlurhash = await getStoredBlurhash(
                backdropPath,
                BASE_PATH
              );
              if (backdropBlurhash) {
                showMetadata.backdropBlurhash = backdropBlurhash;
              }
              break;
            }
          }
        }

        await Promise.all(
          seasons.map(async (season, index) => {
            if (season.isDirectory()) {
              const seasonName = season.name;
              const encodedSeasonName = encodeURIComponent(seasonName);
              const seasonPath = path.join(showPath, seasonName);
              const episodes = await fs.readdir(seasonPath);

              const validEpisodes = episodes.filter(
                (episode) =>
                  episode.endsWith(".mp4") &&
                  !episode.includes("-TdarrCacheFile-")
              );
              if (validEpisodes.length === 0) {
                return;
              }

              const seasonData = {
                fileNames: [],
                urls: {},
                lengths: {},
                dimensions: {},
              };

              const seasonPosterPath = path.join(
                seasonPath,
                "season_poster.jpg"
              );
              if (await fileExists(seasonPosterPath)) {
                seasonData.season_poster = `${PREFIX_PATH}/tv/${encodedShowName}/${encodedSeasonName}/season_poster.jpg`;
                const seasonPosterBlurhash = await getStoredBlurhash(
                  seasonPosterPath,
                  BASE_PATH
                );
                if (seasonPosterBlurhash) {
                  seasonData.seasonPosterBlurhash = seasonPosterBlurhash;
                }
              }

              for (const episode of validEpisodes) {
                const episodePath = path.join(seasonPath, episode);
                const encodedEpisodePath = encodeURIComponent(episode);

                let fileLength;
                let fileDimensions;
                let hdrInfo;
                let additionalMetadata;

                try {
                  const info = await getInfo(episodePath);
                  fileLength = info.length;
                  fileDimensions = info.dimensions;
                  hdrInfo = info.hdr;
                  additionalMetadata = info.additionalMetadata; // Use additional metadata as needed
                } catch (error) {
                  console.error(
                    `Failed to retrieve info for ${episodePath}:`,
                    error
                  );
                }

                seasonData.fileNames.push(episode);
                seasonData.lengths[episode] = parseInt(fileLength, 10);
                seasonData.dimensions[episode] = fileDimensions;

                const episodeData = {
                  videourl: `${PREFIX_PATH}/tv/${encodedShowName}/${encodedSeasonName}/${encodedEpisodePath}`,
                  mediaLastModified: (
                    await fs.stat(episodePath)
                  ).mtime.toISOString(),
                  hdr: hdrInfo || null,
                  additionalMetadata: additionalMetadata || {},
                };

                // ex. values
                // 01, 02, 03, 04, etc.
                // 2 digit string
                const episodeNumber =
                  episode.match(/S\d+E(\d+)/i)?.[1] ||
                  episode.match(/\d+/)?.[0];

                if (episodeNumber) {
                  episodeData.episodeNumber = parseInt(episodeNumber, 10);
                  const thumbnailPath = path.join(
                    seasonPath,
                    `${episodeNumber} - Thumbnail.jpg`
                  );
                  if (await fileExists(thumbnailPath)) {
                    episodeData.thumbnail = `${PREFIX_PATH}/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(
                      `${episodeNumber} - Thumbnail.jpg`
                    )}`;
                    const thumbnailBlurhash = await getStoredBlurhash(
                      thumbnailPath,
                      BASE_PATH
                    );
                    if (thumbnailBlurhash) {
                      episodeData.thumbnailBlurhash = thumbnailBlurhash;
                    }
                  }

                  const metadataPath = path.join(
                    seasonPath,
                    `${episodeNumber}_metadata.json`
                  );
                  if (await fileExists(metadataPath)) {
                    episodeData.metadata = `${PREFIX_PATH}/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(
                      `${episodeNumber}_metadata.json`
                    )}`;
                  }

                  const seasonNumber = seasonName
                    .match(/\d+/)?.[0]
                    ?.padStart(2, "0");
                  const paddedEpisodeNumber = episodeNumber.padStart(2, "0");
                  const chaptersPath = path.join(
                    seasonPath,
                    "chapters",
                    `${showName} - S${seasonNumber}E${paddedEpisodeNumber}_chapters.vtt`
                  );
                  if (await fileExists(chaptersPath)) {
                    episodeData.chapters = `${PREFIX_PATH}/tv/${encodedShowName}/${encodedSeasonName}/chapters/${encodeURIComponent(
                      `${showName} - S${seasonNumber}E${paddedEpisodeNumber}_chapters.vtt`
                    )}`;
                  }

                  // Generate a Unique ID for each episode
                  // Bypassing the TMDB id
                  if (episodeNumber && seasonNumber && showName) {
                    episodeData._id = generateCacheKey(`${showName.toLowerCase()}_S${seasonNumber}E${episodeNumber}`);
                  }

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
                        lastModified: (
                          await fs.stat(path.join(seasonPath, subtitleFile))
                        ).mtime.toISOString(),
                      };
                    }
                  }
                  if (Object.keys(subtitles).length > 0) {
                    episodeData.subtitles = subtitles;
                  }
                }

                seasonData.urls[episode] = episodeData;
              }

              // Process all thumbnails in the season directory
              const thumbnailFiles = episodes.filter((file) =>
                file.endsWith(" - Thumbnail.jpg")
              );
              for (const thumbnailFile of thumbnailFiles) {
                const thumbnailPath = path.join(seasonPath, thumbnailFile);
                const episodeNumber =
                  thumbnailFile.match(/S\d+E(\d+)/i)?.[1] ||
                  thumbnailFile.match(/\d+/)?.[0];
                if (episodeNumber) {
                  await getStoredBlurhash(thumbnailPath, BASE_PATH);
                }
              }

              showMetadata.seasons[seasonName] = seasonData;
            }
          })
        );

        // Always update the database with the latest data
        await insertOrUpdateTVShow(db, showName, showMetadata, "{}");
      }
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
    console.error("Error during database update:", error);
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
        metadata: show.metadata.metadata,
        poster: show.metadata.poster,
        posterBlurhash: show.metadata.posterBlurhash,
        logo: show.metadata.logo,
        logoBlurhash: show.metadata.logoBlurhash,
        backdrop: show.metadata.backdrop,
        backdropBlurhash: show.metadata.backdropBlurhash,
        seasons: show.metadata.seasons,
      };
      return acc;
    }, {});

    res.json(tvData);
  } catch (error) {
    console.error(`Error fetching TV shows: ${error}`);
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
        console.log(
          `Processing movie: ${dir.name}: ${index + 1} of ${dirs.length}`
        );
      }
      if (dir.isDirectory()) {
        const dirName = dir.name;
        const fullDirPath = path.join(dirPath, dirName);
        const files = await fs.readdir(path.join(dirPath, dirName));
        const hash = await calculateDirectoryHash(fullDirPath);

        const existingMovie = await db.get(
          "SELECT * FROM movies WHERE name = ?",
          [dirName]
        );
        existingMovieNames.delete(dirName); // Remove from the set of existing movies
        const dirHashChanged =
          existingMovie && existingMovie.directory_hash !== hash;

        if (!dirHashChanged && existingMovie) {
          // If the hash is the same, skip detailed processing and use the existing data.
          if (isDebugMode) {
            console.log(
              `No changes detected in ${dirName}, skipping processing.`
            );
          }
          return; // Use return instead of continue
        }

        console.log("Directory Hash invalidated for", dirName);

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
        let additionalMetadata;
        const urls = {};
        const subtitles = {};
        let _id = null;

        let runDownloadTmdbImagesFlag = false;

        const tmdbConfigPath = path.join(dirPath, dirName, "tmdb.config");
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
            console.error(`Failed to parse tmdb.config for ${dirName}:`, error);
          }
        }

        for (const file of fileNames) {
          const filePath = path.join(dirPath, dirName, file);
          const encodedFilePath = encodeURIComponent(file);

          if (file.endsWith(".mp4")) {
            let fileLength;
            let fileDimensionsStr;

            try {
              const info = await getInfo(filePath);
              fileLength = info.length;
              fileDimensionsStr = info.dimensions;
              hdrInfo = info.hdr;
              additionalMetadata = info.additionalMetadata;
            } catch (error) {
              console.error(`Failed to retrieve info for ${filePath}:`, error);
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
            if (await fileExists(filePath)) {
              const headerInfo = getHeaderData(filePath);
              _id = generateCacheKey(headerInfo);
            }
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
          const backdropPath = path.join(dirPath, dirName, "backdrop.jpg");
          urls[
            "backdrop"
          ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
            "backdrop.jpg"
          )}`;
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
          const posterPath = path.join(dirPath, dirName, "poster.jpg");
          urls[
            "poster"
          ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
            "poster.jpg"
          )}`;
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
          urls[
            "logo"
          ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
            fileSet.has("movie_logo.png") ? "movie_logo.png" : "logo.png"
          )}`;
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
          const metadataPath = path.join(dirPath, dirName, "metadata.json");
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
          const retryFiles = await fs.readdir(path.join(dirPath, dirName));
          const retryFileSet = new Set(retryFiles); // Create a set of filenames for quick lookup

          if (retryFileSet.has("backdrop.jpg")) {
            const backdropPath = path.join(dirPath, dirName, "backdrop.jpg");
            urls[
              "backdrop"
            ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
              "backdrop.jpg"
            )}`;
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
            const posterPath = path.join(dirPath, dirName, "poster.jpg");
            urls[
              "poster"
            ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
              "poster.jpg"
            )}`;
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
            urls[
              "logo"
            ] = `${PREFIX_PATH}/movies/${encodedDirName}/${encodeURIComponent(
              retryFileSet.has("movie_logo.png") ? "movie_logo.png" : "logo.png"
            )}`;
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
        const chaptersPath = path.join(
          dirPath,
          dirName,
          "chapters",
          `${dirName}_chapters.vtt`
        );
        const chaptersPath2 = path.join(
          dirPath,
          dirName,
          "chapters",
          `${mp4Filename}_chapters.vtt`
        );
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
          delete urls;
        }

        const final_hash = await calculateDirectoryHash(fullDirPath);

        // Always update the database with the latest data
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
          additionalMetadata,
          _id
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
        additional_metadata: movie.additional_metadata,
      };
      return acc;
    }, {});

    res.json(movieData);
  } catch (error) {
    console.error(`Error fetching movies: ${error}`);
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
    console.error(`Error scanning library: ${error}`);
    res.status(500).send("Internal server error");
  }
});

async function runGeneratePosterCollage() {
  console.log(`Running generate_poster_collage.py job${debugMessage}`);
  const pythonExecutable = process.platform === "win32" ? "python" : "python3";
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
    console.error(`Error executing generate_poster_collage.py: ${error}`);
  }
}
async function runDownloadTmdbImages(
  specificShow = null,
  specificMovie = null,
  fullScan = false
) {
  const debugMessage = isDebugMode ? " with debug" : "";
  console.log(
    `Download tmdb request${specificShow ? ` for show "${specificShow}"` : ""}${
      specificMovie ? ` for movie "${specificMovie}"` : ""
    }${fullScan ? " with full scan" : ""}`
  );

  // Construct the command using cross-platform path handling
  let command = `python "${downloadTmdbImagesScript}"`;

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
      console.warn(
        `No write access to ${LOG_FILE}. Logging to console instead.`
      );
    }
  }

  try {
    console.log(
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
      console.error(`download_tmdb_images.py error: ${stderr}`);
    }
    console.log(
      `Finished running download_tmdb_images.py job${debugMessage}${
        specificShow ? ` for show "${specificShow}"` : ""
      }${
        specificMovie
          ? ` for movie "${specificMovie}"${fullScan ? " with full scan" : ""}`
          : ""
      }`
    );
  } catch (error) {
    console.error(`Error executing download_tmdb_images.py: ${error}`);
  }
}
// async function runGenerateThumbnailJson() {
//   console.log(`Running generate_thumbnail_json.sh job${debugMessage}`);
//   const command = isDebugMode
//     ? `sudo bash -c 'env DEBUG=${process.env.DEBUG} bash ${generateThumbnailJsonScript} >> ${LOG_FILE} 2>&1'`
//     : `sudo bash -c 'env DEBUG=${process.env.DEBUG} bash ${generateThumbnailJsonScript}'`;

//   try {
//     await execAsync(command);
//   } catch (error) {
//     console.error(`Error executing generate_thumbnail_json.sh: ${error}`);
//   }
// }

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
  if (isScanning) {
    console.warn(
      `[${new Date().toISOString()}] Previous scan is still running. Skipping this iteration.`
    );
    return;
  } else {
    console.log(`[${new Date().toISOString()}] Generating media list`);
  }

  isScanning = true;

  try {
    const db = await initializeDatabase();
    await generateListMovies(db, `${BASE_PATH}/movies`);
    await generateListTV(db, `${BASE_PATH}/tv`);
    console.log(`[${new Date().toISOString()}] Finished generating media list`);
    await releaseDatabase(db);
  } catch (error) {
    console.error(`Error generating media list: ${error}`);
  } finally {
    isScanning = false;
    autoSync().catch(console.error); // Add autoSync to the scheduled tasks
  }
}

async function autoSync() {
  console.log("Checking autoSync Settings..");
  const autoSyncEnabled = await checkAutoSync();
  if (autoSyncEnabled) {
    console.log("Auto Sync is enabled. Proceeding with sync...");

    try {
      const headers = {
        "X-Webhook-ID": process.env.WEBHOOK_ID,
        "Content-Type": "application/json",
      };

      if (isDebugMode) {
        console.log(`Sending headers:${debugMessage}`, headers);
      }

      const response = await axios.post(
        `${process.env.FRONT_END}/api/authenticated/admin/sync`,
        {},
        { headers }
      );

      if (response.status >= 200 && response.status < 300) {
        console.log("Sync request completed successfully.");
        await updateLastSyncTime();
      } else {
        console.log(`Sync request failed with status code: ${response.status}`);
      }
    } catch (error) {
      const prefix = "Sync request failed: ";

      if (error.response && error.response.data) {
        console.error(`${prefix}${JSON.stringify(error.response.data)}`);
        errorMessage = error.response.data;
      } else if (error.response && error.response.status === 404) {
        const unavailableMessage = `${process.env.FRONT_END}/api/authenticated/admin/sync is unavailable`;
        console.error(`${prefix}${unavailableMessage}`);
        errorMessage = unavailableMessage;
      } else if (error.code === "ECONNRESET") {
        const connectionResetMessage =
          "Connection was reset. Please try again later.";
        console.error(
          `${prefix}${connectionResetMessage}`,
          JSON.stringify(error)
        );
        errorMessage = connectionResetMessage;
      } else {
        console.error(
          `${prefix}An unexpected error occurred.`,
          JSON.stringify(error)
        );
      }
    }
  } else {
    console.log("Auto Sync is disabled. Skipping sync...");
  }
}

function scheduleTasks() {
  // Schedule for generate_thumbnail_json.sh
  // Scheduled to run every 6 minutes.
  // schedule.scheduleJob('*/6 * * * *', () => {
  //   runGenerateThumbnailJson().catch(console.error);
  // });
  // Disabled because this was the old way of generating
  // a thumbnail seek option. Instead we now use
  // a spritesheet for slider previews.

  // Schedule for download_tmdb_images.py
  // Scheduled to run every 7 minutes.
  schedule.scheduleJob("*/7 * * * *", async () => {
    try {
      await runDownloadTmdbImages(null, null, true);
    } catch (error) {
      console.error(error);
    }
  });

  // Schedule for generate_poster_collage.py
  // Scheduled to run at 3, 6, 9, 12, 15, 18, 21, 24, 27, and 30 hours of the day.
  schedule.scheduleJob("0 3,6,9,12,15,18,21,24,27,30 * * *", () => {
    runGeneratePosterCollage().catch(console.error);
  });
  // Schedule for runGenerateList and autoSync
  // Scheduled to run every 1 minute
  schedule.scheduleJob("*/1 * * * *", () => {
    runGenerateList().catch(console.error);
  });
}

async function initialize() {
  await ensureCacheDirs();
  const port = 3000;
  app.listen(port, async () => {
    scheduleTasks();
    //runGenerateThumbnailJson().catch(console.error);
    console.log(`Server running on port ${port}`);
    initializeMongoDatabase()
      .then(() => {
        return initializeIndexes();
      })
      .then(() => {
        console.log("Database and indexes initialized successfully.");
      })
      .catch((error) => {
        console.error("Error during initialization:", error);
      });
    runGenerateList().catch(console.error);
    runGeneratePosterCollage().catch(console.error);
  });
}

// Initialize the application
initialize().catch(console.error);
