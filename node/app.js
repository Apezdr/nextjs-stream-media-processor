const express = require("express");
const schedule = require('node-schedule');
const { exec } = require("child_process");
const util = require('util');
const path = require("path");
const _fs = require("fs"); // Callback-based version of fs
const fs = require("fs").promises; // Use the promise-based version of fs
const compression = require("compression");
const axios = require('axios');
const app = express();
const thumbnailGenerationInProgress = new Set();
const { generateSpriteSheet } = require("./sprite");
const { initializeDatabase, insertOrUpdateMovie, getMovies, isDatabaseEmpty, getTVShows, insertOrUpdateTVShow } = require("./sqliteDatabase");
const {
  generateFrame,
  getVideoDuration,
  fileExists,
  ensureCacheDir,
  cacheDir,
  findMp4File,
  getStoredBlurhash,
} = require("./utils");
const { generateChapters, hasChapterInfo } = require("./chapter-generator");
const { checkAutoSync, updateLastSyncTime } = require("./database");
const execAsync = util.promisify(exec);
//const { handleVideoRequest } = require("./videoHandler");
const LOG_FILE = '/var/log/cron.log';
const BASE_PATH = "/var/www/html";
const scriptsDir = path.resolve(__dirname, '../scripts');

const generatePosterCollageScript = path.join(scriptsDir, 'generate_poster_collage.py');
const downloadTmdbImagesScript = path.join(scriptsDir, 'download_tmdb_images.py');
const generateThumbnailJsonScript = path.join(scriptsDir, 'generate_thumbnail_json.sh');

const isDebugMode = process.env.DEBUG && process.env.DEBUG.toLowerCase() === 'true';
const debugMessage = isDebugMode ? ' [Debugging Enabled]' : '';

ensureCacheDir();

const langMap = {
  "en": "English",
  "eng": "English",
  "es": "Spanish",
  "spa": "Spanish",
  "tl": "Tagalog",
  "tgl": "Tagalog",
  "zh": "Chinese",
  "zho": "Chinese",
  "cs": "Czech",
  "cze": "Czech",
  "da": "Danish",
  "dan": "Danish",
  "nl": "Dutch",
  "dut": "Dutch",
  "fi": "Finnish",
  "fin": "Finnish",
  "fr": "French",
  "fre": "French",
  "de": "German",
  "ger": "German",
  "el": "Greek",
  "gre": "Greek",
  "hu": "Hungarian",
  "hun": "Hungarian",
  "it": "Italian",
  "ita": "Italian",
  "ja": "Japanese",
  "jpn": "Japanese",
  "ko": "Korean",
  "kor": "Korean",
  "no": "Norwegian",
  "nor": "Norwegian",
  "pl": "Polish",
  "pol": "Polish",
  "pt": "Portuguese",
  "por": "Portuguese",
  "ro": "Romanian",
  "ron": "Romanian",
  "rum": "Romanian",
  "sk": "Slovak",
  "slo": "Slovak",
  "sv": "Swedish",
  "swe": "Swedish",
  "tr": "Turkish",
  "tur": "Turkish",
  "ara": "Arabic",
  "bul": "Bulgarian",
  "chi": "Chinese",
  "est": "Estonian",
  "fin": "Finnish",
  "fre": "French",
  "ger": "German",
  "gre": "Greek",
  "heb": "Hebrew",
  "hin": "Hindi",
  "hun": "Hungarian",
  "ind": "Indonesian",
  "ita": "Italian",
  "jpn": "Japanese",
  "kor": "Korean",
  "lav": "Latvian",
  "lit": "Lithuanian",
  "may": "Malay",
  "nor": "Norwegian",
  "pol": "Polish",
  "por": "Portuguese",
  "rus": "Russian",
  "slo": "Slovak",
  "slv": "Slovenian",
  "spa": "Spanish",
  "swe": "Swedish",
  "tam": "Tamil",
  "tel": "Telugu",
  "tha": "Thai",
  "tur": "Turkish",
  "ukr": "Ukrainian",
  "vie": "Vietnamese"
};

// Track Repeat Requests to avoid
// creating too many workers
const vttProcessingFiles = new Set();
const vttRequestQueues = new Map();

app.get("/frame/movie/:movieName/:timestamp.:ext?", (req, res) => {
  handleFrameRequest(req, res, "movies");
});

app.get("/frame/tv/:showName/:season/:episode/:timestamp.:ext?", (req, res) => {
  handleFrameRequest(req, res, "tv");
});

async function handleFrameRequest(req, res, type) {
  const timestamp = req.params.timestamp;
  let frameFileName,
    directoryPath,
    videoPath,
    specificFileName = null,
    wasCached = true;

  if (type === "movies") {
    const movieName = req.params.movieName
      ? req.params.movieName.replace(/%20/g, " ")
      : ""; // Replace %20 with space
    directoryPath = path.join("/var/www/html/movies", movieName);
    frameFileName = `movie_${movieName}_${timestamp}.jpg`;
  } else {
    // For TV shows, adjust this logic to fit your directory structure
    const showName = req.params.showName
      ? req.params.showName.replace(/%20/g, " ")
      : "";
    const season = req.params.season
      ? req.params.season.replace(/%20/g, " ")
      : "";
    const episodeString = req.params.episode
      ? req.params.episode.replace(/%20/g, " ")
      : "";

    // Extract episode number
    const episodeMatch =
      episodeString.match(/E(\d{2})/i) || episodeString.match(/^(\d{2}) -/);
    const episodeNumber = episodeMatch ? episodeMatch[1] : "Unknown"; // Default to 'Unknown' if not found

    directoryPath = path.join("/var/www/html/tv", showName, `Season ${season}`);
    frameFileName = `tv_${showName}_S${season}E${episodeNumber}_${timestamp}.jpg`;
    specificFileName = `${episodeString}.mp4`;
  }

  const framePath = path.join(cacheDir, frameFileName);

  try {
    if (await fileExists(framePath)) {
      // Serve from cache if exists
      console.log(`Serving cached frame: ${frameFileName}`);
    } else {
      wasCached = false;
      // Find the MP4 file dynamically
      videoPath = await findMp4File(directoryPath, specificFileName);

      // Generate the frame
      await generateFrame(videoPath, timestamp, framePath);
      console.log(`Generated new frame: ${frameFileName}`);
    }

    res.sendFile(framePath);

    // Check if thumbnail generation is in progress to avoid duplication
    if (!thumbnailGenerationInProgress.has(videoPath) && videoPath) {
      thumbnailGenerationInProgress.add(videoPath);
      generateAllThumbnails(
        videoPath,
        type,
        req.params.movieName ||
          (req.params.showName ? req.params.showName.replace(/%20/g, " ") : ""),
        req.params.season ? req.params.season.replace(/%20/g, " ") : "",
        req.params.episode
      )
        .then(() => {
          console.log("Processing complete show generation");
          thumbnailGenerationInProgress.delete(videoPath);
        })
        .catch((error) => {
          console.error(error);
          thumbnailGenerationInProgress.delete(videoPath);
        });
    }
  } catch (error) {
    console.error(error);
    return res.status(404).send("Video file not found");
  }
}

async function generateAllThumbnails(
  videoPath,
  type,
  name,
  season = null,
  episode = null
) {
  try {
    const duration = await getVideoDuration(videoPath);
    const floorDuration = Math.floor(duration);
    console.log(`Total Duration: ${floorDuration} seconds`);

    const interval = 5; // Adjust if needed for debugging
    for (
      let currentTime = 0;
      currentTime <= floorDuration;
      currentTime += interval
    ) {
      let timestamp = new Date(currentTime * 1000).toISOString().substr(11, 8);
      console.log(`Processing timestamp: ${timestamp}`); // Debugging log

      let frameFileName;
      if (type === "movies") {
        frameFileName = `movie_${name}_${timestamp}.jpg`;
      } else if (type === "tv") {
        frameFileName = `${type}_${name}_${season}_${episode}_${timestamp}.jpg`;
      }

      let framePath = path.join(cacheDir, frameFileName);

      if (!(await fileExists(framePath))) {
        console.log(`Generating new frame: ${frameFileName}`);
        await generateFrame(videoPath, timestamp, framePath);
      } else {
        console.log(`Frame already exists: ${frameFileName}, skipping...`);
      }
    }
  } catch (error) {
    console.error(`Error in generateAllThumbnails: ${error}`);
  }
}

//
// Cache management
//
//
const CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // Max age for cache files in milliseconds, e.g., 1 month (30 days)

function clearOldCacheFiles() {
  const now = new Date().getTime();

  fs.readdir(cacheDir, (err, files) => {
    if (err) {
      console.error("Error reading cache directory:", err);
      return;
    }

    files.forEach((file) => {
      const filePath = path.join(cacheDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) {
          console.error("Error getting file stats:", err);
          return;
        }

        const lastAccessed = stats.atimeMs; // atimeMs is the file last accessed time
        const age = now - lastAccessed;

        if (age > CACHE_MAX_AGE) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error(`Error deleting file ${file}:`, err);
            } else {
              console.log(`Deleted old cache file: ${file}`);
            }
          });
        }
      });
    });
  });
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

async function handleSpriteSheetRequest(req, res, type) {
  const { movieName, showName, season, episode } = req.params;
  let spriteSheetFileName;

  if (type === "movies") {
    spriteSheetFileName = `movie_${movieName}_spritesheet.jpg`;
  } else if (type === "tv") {
    spriteSheetFileName = `tv_${showName}_${season}_${episode}_spritesheet.jpg`;
  }

  const spriteSheetPath = path.join(cacheDir, spriteSheetFileName);

  try {
    if (await fileExists(spriteSheetPath)) {
      console.log(`Serving sprite sheet from cache: ${spriteSheetPath}`);
      res.sendFile(spriteSheetPath);
    } else {
      console.log(`Sprite sheet not found in cache: ${spriteSheetFileName}`);

      // Generate the sprite sheet
      let videoPath;
      if (type === "movies") {
        const directoryPath = path.join("/var/www/html/movies", movieName);
        videoPath = await findMp4File(directoryPath);
      } else if (type === "tv") {
        const showsDataRaw = _fs.readFileSync(
          "/var/www/html/tv_list.json",
          "utf8"
        );
        const showsData = JSON.parse(showsDataRaw);
        const showData = showsData[showName];
        if (showData) {
          const _season = showData.seasons[`Season ${season}`];

          if (_season) {
            const _episode = _season.fileNames.find((e) => {
              const episodeNumber = episode.padStart(2, "0");
              return (
                e.includes(` - `) &&
                (e.startsWith(episodeNumber) ||
                  e.includes(` ${episodeNumber} - `) ||
                  e.includes(`S${season.padStart(2, "0")}E${episodeNumber}`))
              );
            });

            if (_episode) {
              const directoryPath = path.join(
                "/var/www/html/tv",
                showName,
                `Season ${season}`
              );
              videoPath = await findMp4File(directoryPath, _episode);
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
      }

      await generateSpriteSheet({
        videoPath,
        type,
        name: movieName || showName,
        season,
        episode,
        cacheDir,
      });
    }
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal server error");
  }
}

async function handleVttRequest(req, res, type) {
  const { movieName, showName, season, episode } = req.params;
  let vttFileName;

  if (type === "movies") {
    vttFileName = `movie_${movieName}_spritesheet.vtt`;
  } else if (type === "tv") {
    vttFileName = `tv_${showName}_${season}_${episode}_spritesheet.vtt`;
  }

  const vttFilePath = path.join(cacheDir, vttFileName);

  try {
    if (await fileExists(vttFilePath)) {
      console.log(`Serving VTT file from cache: ${vttFileName}`);
      res.setHeader("Content-Type", "text/vtt");
      const fileStream = _fs.createReadStream(vttFilePath);
      fileStream.pipe(res);
    } else {
      console.log(`VTT file not found in cache: ${vttFileName}`);

      const fileKey = type === "movies" 
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
        const directoryPath = path.join("/var/www/html/movies", movieName);
        videoPath = await findMp4File(directoryPath);
        await generateSpriteSheet({
          videoPath,
          type,
          name: movieName,
          cacheDir,
        });
      } else if (type === "tv") {
        try {
          // Load the showsData only for TV show requests
          // Read the tv_list.json file synchronously
          const showsDataRaw = _fs.readFileSync(
            "/var/www/html/tv_list.json",
            "utf8"
          );
          const showsData = JSON.parse(showsDataRaw);

          const showData = showsData[showName];
          if (showData) {
            const _season = showData.seasons[`Season ${season}`];
            if (_season) {
              const _episode = _season.fileNames.find((e) => {
                const episodeNumber = episode.padStart(2, "0");
                return (
                  e.includes(` - `) &&
                  (e.startsWith(episodeNumber) ||
                    e.includes(` ${episodeNumber} - `) ||
                    e.includes(`S${season.padStart(2, "0")}E${episodeNumber}`))
                );
              });
              if (_episode) {
                const directoryPath = path.join(
                  "/var/www/html/tv",
                  showName,
                  `Season ${season}`
                );
                videoPath = await findMp4File(directoryPath, _episode);
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
          console.error(
            `Error accessing tv_list.json or its contents: ${error.message}`
          );
          vttProcessingFiles.delete(fileKey);
          return res.status(500).send("Internal server error");
        }
      }

      await generateSpriteSheet({
        videoPath,
        type,
        name: movieName || showName,
        season,
        episode,
        cacheDir,
      });

      vttProcessingFiles.delete(fileKey);

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
  const { movieName, showName, season, episode } = req.params;
  let chapterFileName, mediaPath, chapterFilePath;

  if (type === "movies") {
    const directoryPath = path.join("/var/www/html/movies", movieName);
    const movieFile = await findMp4File(directoryPath);
    const movieFileName = path.basename(movieFile, path.extname(movieFile));
    chapterFileName = `${movieFileName}_chapters.vtt`;
    mediaPath = path.join(directoryPath, `${movieFileName}.mp4`);
    chapterFilePath = path.join(directoryPath, "chapters", chapterFileName);
    await generateChapterFileIfNotExists(chapterFilePath, mediaPath);
  } else if (type === "tv") {
    if (generateAllChapters) {
      // Generate chapter files for all episodes of the show
      const showsDataRaw = _fs.readFileSync(
        "/var/www/html/tv_list.json",
        "utf8"
      );
      const showsData = JSON.parse(showsDataRaw);
      const showData = showsData[showName];

      if (showData) {
        for (const seasonName in showData.seasons) {
          const season = showData.seasons[seasonName];
          for (const episodeFileName of season.fileNames) {
            const episodeNumber = getEpisodeNumber(episodeFileName);
            const seasonNumber = seasonName.replace("Season ", "");
            const chapterFilePath = path.join(
              "/var/www/html/tv",
              showName,
              seasonName,
              "chapters",
              `${showName} - S${seasonNumber.padStart(
                2,
                "0"
              )}E${episodeNumber.padStart(2, "0")}_chapters.vtt`
            );
            const directoryPath = path.join(
              "/var/www/html/tv",
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
      // Generate chapter files for all episodes of the show
      const showsDataRaw = _fs.readFileSync(
        "/var/www/html/tv_list.json",
        "utf8"
      );
      const showsData = JSON.parse(showsDataRaw);
      const showData = showsData[showName];

      if (showData) {
        for (const seasonName in showData.seasons) {
          const season = showData.seasons[seasonName];
          for (const episodeFileName of season.fileNames) {
            const episodeNumber = getEpisodeNumber(episodeFileName);
            const seasonNumber = seasonName.replace("Season ", "");
            const chapterFilePath = path.join(
              "/var/www/html/tv",
              showName,
              seasonName,
              "chapters",
              `${showName} - S${seasonNumber.padStart(
                2,
                "0"
              )}E${episodeNumber.padStart(2, "0")}_chapters.vtt`
            );
            const directoryPath = path.join(
              "/var/www/html/tv",
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
      // Generate chapter file for a specific episode
      const directoryPath = path.join(
        "/var/www/html/tv",
        showName,
        `Season ${season}`
      );
      const episodeNumber = episode.padStart(2, "0");
      const seasonNumber = season.padStart(2, "0");
      chapterFileName = `${showName} - S${seasonNumber}E${episodeNumber}_chapters.vtt`;
      chapterFilePath = path.join(directoryPath, "chapters", chapterFileName);

      try {
        // Find the associated MP4 file
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
        _fs.writeFile(chapterFilePath, chapterContent, (err) => {
          if (err) throw err;
          console.log("The file has been saved!");
        });
      } else {
        // If the media file doesn't have chapter information, send a 404 response
        console.warn(
          `Chapter information not found for ${path.basename(mediaPath)}`
        );
      }
    }
  } catch (error) {
    console.error(
      `Error generating chapter file for ${path.basename(mediaPath)}:`,
      error
    );
  }
}

//
// Handle MP4 Audio requests
//app.get("/video/movie/:movieName", async (req, res) => {
//  await handleVideoRequest(req, res, "movies");
//});

//app.get("/video/tv/:showName/:season/:episode", async (req, res) => {
//  await handleVideoRequest(req, res, "tv");
//});

// Schedule cache clearing every 30 minutes
setInterval(clearOldCacheFiles, 30 * 60 * 1000);
//
// End Cache Management
//
//
async function generateListTV(db, dirPath) {
  const shows = await fs.readdir(dirPath, { withFileTypes: true });

  for (const show of shows) {
    if (show.isDirectory()) {
      const showName = show.name;
      const encodedShowName = encodeURIComponent(showName);
      const showPath = path.join(dirPath, showName);
      const seasons = await fs.readdir(showPath, { withFileTypes: true });

      const showMetadata = {
        metadata: `/tv/${encodedShowName}/metadata.json`,
        seasons: {}
      };

      // Handle show poster
      const posterPath = path.join(showPath, 'show_poster.jpg');
      if (await fileExists(posterPath)) {
        showMetadata.poster = `/tv/${encodedShowName}/show_poster.jpg`;
        const posterBlurhash = await getStoredBlurhash(posterPath, BASE_PATH);
        if (posterBlurhash) {
          showMetadata.posterBlurhash = posterBlurhash;
        }
      }

      // Handle show logo with various extensions
      const logoExtensions = ['svg', 'jpg', 'png', 'gif'];
      for (const ext of logoExtensions) {
        const logoPath = path.join(showPath, `show_logo.${ext}`);
        if (await fileExists(logoPath)) {
          showMetadata.logo = `/tv/${encodedShowName}/show_logo.${ext}`;
          if (ext !== 'svg') {
            const logoBlurhash = await getStoredBlurhash(logoPath, BASE_PATH);
            if (logoBlurhash) {
              showMetadata.logoBlurhash = logoBlurhash;
            }
          }
          break;
        }
      }

      // Handle show backdrop with various extensions
      const backdropExtensions = ['jpg', 'png', 'gif'];
      for (const ext of backdropExtensions) {
        const backdropPath = path.join(showPath, `show_backdrop.${ext}`);
        if (await fileExists(backdropPath)) {
          showMetadata.backdrop = `/tv/${encodedShowName}/show_backdrop.${ext}`;
          const backdropBlurhash = await getStoredBlurhash(backdropPath, BASE_PATH);
          if (backdropBlurhash) {
            showMetadata.backdropBlurhash = backdropBlurhash;
          }
          break;
        }
      }

      for (const season of seasons) {
        if (season.isDirectory()) {
          const seasonName = season.name;
          const encodedSeasonName = encodeURIComponent(seasonName);
          const seasonPath = path.join(showPath, seasonName);
          const episodes = await fs.readdir(seasonPath);

          // Check if there are any valid episodes in the season
          const validEpisodes = episodes.filter(episode => episode.endsWith('.mp4') && !episode.includes('-TdarrCacheFile-'));
          if (validEpisodes.length === 0) {
            continue; // Skip this season if there are no valid episodes
          }

          const seasonData = {
            fileNames: [],
            urls: {},
            lengths: {},
            dimensions: {}
          };

          // Handle season poster
          const seasonPosterPath = path.join(seasonPath, 'season_poster.jpg');
          if (await fileExists(seasonPosterPath)) {
            seasonData.season_poster = `/tv/${encodedShowName}/${encodedSeasonName}/season_poster.jpg`;
            const seasonPosterBlurhash = await getStoredBlurhash(seasonPosterPath, BASE_PATH);
            if (seasonPosterBlurhash) {
              seasonData.seasonPosterBlurhash = seasonPosterBlurhash;
            }
          }

          for (const episode of validEpisodes) {
            const episodePath = path.join(seasonPath, episode);
            const encodedEpisodePath = encodeURIComponent(episode);
            const infoFile = `${episodePath}.info`;

            let fileLength;
            let fileDimensions;

            if (await fileExists(infoFile)) {
              const fileInfo = await fs.readFile(infoFile, 'utf-8');
              [fileLength, fileDimensions] = fileInfo.trim().split(' ');
            } else {
              const { stdout: length } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${episodePath}"`);
              const { stdout: dimensions } = await execAsync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${episodePath}"`);
              fileLength = Math.floor(parseFloat(length.trim()) * 1000);
              fileDimensions = dimensions.trim();
              await fs.writeFile(infoFile, `${fileLength} ${fileDimensions}`);
            }

            seasonData.fileNames.push(episode);
            seasonData.lengths[episode] = parseInt(fileLength, 10);
            seasonData.dimensions[episode] = fileDimensions;

            const episodeData = {
              videourl: `/tv/${encodedShowName}/${encodedSeasonName}/${encodedEpisodePath}`,
              mediaLastModified: (await fs.stat(episodePath)).mtime.toISOString()
            };

            const episodeNumber = episode.match(/S\d+E(\d+)/i)?.[1] || episode.match(/\d+/)?.[0];

            if (episodeNumber) {
              const thumbnailPath = path.join(seasonPath, `${episodeNumber} - Thumbnail.jpg`);
              if (await fileExists(thumbnailPath)) {
                episodeData.thumbnail = `/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(`${episodeNumber} - Thumbnail.jpg`)}`;
                const thumbnailBlurhash = await getStoredBlurhash(thumbnailPath, BASE_PATH);
                if (thumbnailBlurhash) {
                  episodeData.thumbnailBlurhash = thumbnailBlurhash;
                }
              }

              const metadataPath = path.join(seasonPath, `${episodeNumber}_metadata.json`);
              if (await fileExists(metadataPath)) {
                episodeData.metadata = `/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(`${episodeNumber}_metadata.json`)}`;
              }

              const seasonNumber = seasonName.match(/\d+/)?.[0]?.padStart(2, '0');
              const paddedEpisodeNumber = episodeNumber.padStart(2, '0');
              const chaptersPath = path.join(seasonPath, 'chapters', `${showName} - S${seasonNumber}E${paddedEpisodeNumber}_chapters.vtt`);
              if (await fileExists(chaptersPath)) {
                episodeData.chapters = `/tv/${encodedShowName}/${encodedSeasonName}/chapters/${encodeURIComponent(`${showName} - S${seasonNumber}E${paddedEpisodeNumber}_chapters.vtt`)}`;
              }

              const subtitleFiles = await fs.readdir(seasonPath);
              const subtitles = {};
              for (const subtitleFile of subtitleFiles) {
                if (subtitleFile.startsWith(episode.replace('.mp4', '')) && subtitleFile.endsWith('.srt')) {
                  const parts = subtitleFile.split('.');
                  const srtIndex = parts.lastIndexOf('srt');
                  const isHearingImpaired = parts[srtIndex - 1] === 'hi';
                  const langCode = isHearingImpaired ? parts[srtIndex - 2] : parts[srtIndex - 1];
                  const langName = langMap[langCode] || langCode;
                  const subtitleKey = isHearingImpaired ? `${langName} Hearing Impaired` : langName;
                  subtitles[subtitleKey] = {
                    url: `/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(subtitleFile)}`,
                    srcLang: langCode,
                    lastModified: (await fs.stat(path.join(seasonPath, subtitleFile))).mtime.toISOString()
                  };
                }
              }
              if (Object.keys(subtitles).length > 0) {
                episodeData.subtitles = subtitles;
              }
            }

            seasonData.urls[episode] = episodeData;
          }

          showMetadata.seasons[seasonName] = seasonData;
        }
      }

      await insertOrUpdateTVShow(db, showName, showMetadata, '{}');
    }
  }
}

app.get('/media/tv', async (req, res) => {
  try {
    const db = await initializeDatabase();
    if (await isDatabaseEmpty(db, 'tv_shows')) {
      await generateListTV(db, "/var/www/html/tv");
    }
    const shows = await getTVShows(db);
    await db.close();

    const tvData = shows.reduce((acc, show) => {
      acc[show.name] = {
        metadata: show.metadata.metadata,
        poster: show.metadata.poster,
        posterBlurhash: show.metadata.posterBlurhash,
        logo: show.metadata.logo,
        logoBlurhash: show.metadata.logoBlurhash,
        backdrop: show.metadata.backdrop,
        backdropBlurhash: show.metadata.backdropBlurhash,
        seasons: show.metadata.seasons
      };
      return acc;
    }, {});

    res.json(tvData);
  } catch (error) {
    console.error(`Error fetching TV shows: ${error}`);
    res.status(500).send('Internal server error');
  }
});


async function generateListMovies(db, dirPath) {
  const dirs = await fs.readdir(dirPath, { withFileTypes: true });
  for (const dir of dirs) {
    if (dir.isDirectory()) {
      const dirName = dir.name;
      const encodedDirName = encodeURIComponent(dirName);
      const files = await fs.readdir(path.join(dirPath, dirName));
      const fileNames = files.filter(file => file.endsWith('.mp4') || file.endsWith('.srt') || file.endsWith('.json') || file.endsWith('.info') || file.endsWith('.nfo') || file.endsWith('.jpg') || file.endsWith('.png'));
      const fileLengths = {};
      const fileDimensions = {};
      const urls = {};
      const subtitles = {};

      for (const file of fileNames) {
        const filePath = path.join(dirPath, dirName, file);
        const encodedFilePath = encodeURIComponent(file);
        const infoFile = `${filePath}.info`;

        if (file.endsWith('.mp4')) {
          let fileLength;
          let fileDimensionsStr;

          if (await fileExists(infoFile)) {
            const fileInfo = await fs.readFile(infoFile, 'utf-8');
            [fileLength, fileDimensionsStr] = fileInfo.trim().split(' ');
          } else {
            const { stdout: length } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
            const { stdout: dimensions } = await execAsync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${filePath}"`);
            fileLength = Math.floor(parseFloat(length.trim()) * 1000);
            fileDimensionsStr = dimensions.trim();
            await fs.writeFile(infoFile, `${fileLength} ${fileDimensionsStr}`);
          }

          fileLengths[file] = parseInt(fileLength, 10);
          fileDimensions[file] = fileDimensionsStr;
          urls["mp4"] = `/movies/${encodedDirName}/${encodedFilePath}`;
        }

        if (file.endsWith('.srt')) {
          const parts = file.split('.');
          const srtIndex = parts.lastIndexOf('srt');
          const isHearingImpaired = parts[srtIndex - 1] === 'hi';
          const langCode = isHearingImpaired ? parts[srtIndex - 2] : parts[srtIndex - 1];
          const langName = langMap[langCode] || langCode;
          const subtitleKey = isHearingImpaired ? `${langName} Hearing Impaired` : langName;
          subtitles[subtitleKey] = {
            url: `/movies/${encodedDirName}/${encodedFilePath}`,
            srcLang: langCode,
            lastModified: (await fs.stat(filePath)).mtime.toISOString()
          };
        }

        if (file === 'backdrop.jpg') {
          urls["backdrop"] = `/movies/${encodedDirName}/${encodedFilePath}`;
          if (await fileExists(`${filePath}.blurhash`)) {
            urls["backdropBlurhash"] = `/movies/${encodedDirName}/${encodedFilePath}.blurhash`;
          }
        }

        if (file === 'poster.jpg') {
          urls["poster"] = `/movies/${encodedDirName}/${encodedFilePath}`;
          if (await fileExists(`${filePath}.blurhash`)) {
            urls["posterBlurhash"] = `/movies/${encodedDirName}/${encodedFilePath}.blurhash`;
          }
        }

        if (file === 'movie_logo.png') {
          urls["logo"] = `/movies/${encodedDirName}/${encodedFilePath}`;
        }

        if (file === 'metadata.json') {
          urls["metadata"] = `/movies/${encodedDirName}/${encodedFilePath}`;
        }
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

      await insertOrUpdateMovie(db, dirName, fileNames, fileLengths, fileDimensions, urls, urls["metadata"] || "");
    }
  }
}

app.get('/media/movies', async (req, res) => {
  try {
      const db = await initializeDatabase();
      if (await isDatabaseEmpty(db)) {
          await generateListMovies(db, "/var/www/html/movies");
      }
      const movies = await getMovies(db);
      await db.close();

      const movieData = movies.reduce((acc, movie) => {
          acc[movie.name] = {
              fileNames: movie.fileNames,
              length: movie.lengths,
              dimensions: movie.dimensions,
              urls: movie.urls,
              metadata: movie.metadataUrl
          };
          return acc;
      }, {});

      res.json(movieData);
  } catch (error) {
      console.error(`Error fetching movies: ${error}`);
      res.status(500).send('Internal server error');
  }
});

app.post('/media/scan', async (req, res) => {
  try {
      const db = await initializeDatabase();
      await generateListMovies(db, "/var/www/html/movies");
      await db.close();
      res.status(200).send('Library scan completed');
  } catch (error) {
      console.error(`Error scanning library: ${error}`);
      res.status(500).send('Internal server error');
  }
});

async function runGeneratePosterCollage() {
  console.log(`Running generate_poster_collage.py job${debugMessage}`);
  const command = isDebugMode 
    ? `sudo bash -c 'env DEBUG=${process.env.DEBUG} TMDB_API_KEY=${process.env.TMDB_API_KEY} python3 ${generatePosterCollageScript} >> ${LOG_FILE} 2>&1'` 
    : `sudo bash -c 'env DEBUG=${process.env.DEBUG} TMDB_API_KEY=${process.env.TMDB_API_KEY} python3 ${generatePosterCollageScript}'`;

  try {
    await execAsync(command);
  } catch (error) {
    console.error(`Error executing generate_poster_collage.py: ${error}`);
  }
}

async function runDownloadTmdbImages() {
  console.log(`Running download_tmdb_images.py job${debugMessage}`);
  const command = isDebugMode 
    ? `sudo bash -c 'env DEBUG=${process.env.DEBUG} TMDB_API_KEY=${process.env.TMDB_API_KEY} python3 ${downloadTmdbImagesScript} >> ${LOG_FILE} 2>&1'` 
    : `sudo bash -c 'env DEBUG=${process.env.DEBUG} TMDB_API_KEY=${process.env.TMDB_API_KEY} python3 ${downloadTmdbImagesScript}'`;

  try {
    await execAsync(command);
  } catch (error) {
    console.error(`Error executing download_tmdb_images.py: ${error}`);
  }
}

async function runGenerateThumbnailJson() {
  console.log(`Running generate_thumbnail_json.sh job${debugMessage}`);
  const command = isDebugMode 
    ? `sudo bash -c 'env DEBUG=${process.env.DEBUG} bash ${generateThumbnailJsonScript} >> ${LOG_FILE} 2>&1'` 
    : `sudo bash -c 'env DEBUG=${process.env.DEBUG} bash ${generateThumbnailJsonScript}'`;

  try {
    await execAsync(command);
  } catch (error) {
    console.error(`Error executing generate_thumbnail_json.sh: ${error}`);
  }
}

async function runGenerateList() {
  try {
    const db = await initializeDatabase();
    await generateListMovies(db, "/var/www/html/movies");
    await generateListTV(db, "/var/www/html/tv");
    await db.close();
  } catch (error) {
    console.error(`Error generating media list: ${error}`);
  }
}

async function autoSync() {
  console.log("Checking autoSync Settings..");
  const autoSyncEnabled = await checkAutoSync();
  if (autoSyncEnabled) {
    console.log("Auto Sync is enabled. Proceeding with sync...");

    try {
      const headers = {
        'X-Webhook-ID': process.env.WEBHOOK_ID,
        'Content-Type': 'application/json'
      };
      
      if (isDebugMode) {
        console.log(`Sending headers:${debugMessage}`, headers);
      }

      const response = await axios.post(`${process.env.FRONT_END}/api/authenticated/admin/sync`, {}, { headers });

      if (response.status >= 200 && response.status < 300) {
        console.log("Sync request completed successfully.");
        await updateLastSyncTime();
      } else {
        console.log(`Sync request failed with status code: ${response.status}`);
      }
    } catch (error) {
      const prefix = 'Sync request failed: ';
      if (error.response && error.response.data) {
        console.error(`${prefix}${error.response.data}`);
        errorMessage = error.response.data;
      } else if (error.response && error.response.status === 404) {
        const unavailableMessage = `${process.env.FRONT_END}/api/authenticated/admin/sync is unavailable`;
        console.error(`${prefix}${unavailableMessage}`);
        errorMessage = unavailableMessage;
      } else if (error.code === 'ECONNRESET') {
        const connectionResetMessage = 'Connection was reset. Please try again later.';
        console.error(`${prefix}${connectionResetMessage}`, error);
        errorMessage = connectionResetMessage;
      } else {
        console.error(`${prefix}An unexpected error occurred.`, error);
      }
    }
  } else {
    console.log("Auto Sync is disabled. Skipping sync...");
  }
}

function scheduleTasks() {
  // Schedule for generate_thumbnail_json.sh
  // Scheduled to run every 6 minutes.
  schedule.scheduleJob('*/6 * * * *', () => {
    runGenerateThumbnailJson().catch(console.error);
  });

  // Schedule for download_tmdb_images.py
  // Scheduled to run every 7 minutes.
  schedule.scheduleJob('*/7 * * * *', () => {
    runDownloadTmdbImages().catch(console.error);
  });

  // Schedule for generate_poster_collage.py
  // Scheduled to run at 3, 6, 9, 12, 15, 18, 21, 24, 27, and 30 hours of the day.
  schedule.scheduleJob('0 3,6,9,12,15,18,21,24,27,30 * * *', () => {
    runGeneratePosterCollage().catch(console.error);
  });
  // Schedule for runGenerateList and autoSync
  schedule.scheduleJob('*/1 * * * *', () => {
    runGenerateList().catch(console.error);
    autoSync().catch(console.error); // Add autoSync to the scheduled tasks
  });
}


async function initialize() {
  await ensureCacheDir();
  const port = 3000;
  app.listen(port, () => {
      scheduleTasks();
      runDownloadTmdbImages().catch(console.error);
      runGenerateThumbnailJson().catch(console.error);
      console.log(`Server running on port ${port}`);
  });
}

// Initialize the application
initialize().catch(console.error);
