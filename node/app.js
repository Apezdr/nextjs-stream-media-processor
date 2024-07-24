const express = require("express");
const schedule = require('node-schedule');
const { exec } = require("child_process");
const util = require('util');
const path = require("path");
const _fs = require("fs"); // Callback-based version of fs
const fs = require("fs").promises; // Use the promise-based version of fs
const compression = require("compression");
const app = express();
const thumbnailGenerationInProgress = new Set();
const { generateSpriteSheet } = require("./sprite");
const {
  generateFrame,
  getVideoDuration,
  fileExists,
  ensureCacheDir,
  cacheDir,
  findMp4File,
} = require("./utils");
const { generateChapters, hasChapterInfo } = require("./chapter-generator");
const execAsync = util.promisify(exec);
//const { handleVideoRequest } = require("./videoHandler");
const LOG_FILE = '/var/log/cron.log';

ensureCacheDir();

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
    vttFileName = `${type}_${movieName}_spritesheet.vtt`;
  } else if (type === "tv") {
    vttFileName = `${type}_${showName}_${season}_${episode}_spritesheet.vtt`;
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

// Schedule tasks
async function runGenerateList() {
  const isDebugMode = process.env.DEBUG && process.env.DEBUG.toLowerCase() === 'true';
  const debugMessage = isDebugMode ? ' [Debugging Enabled]' : '';
  console.log(`Running generate_list.sh job${debugMessage}`);
  const command = isDebugMode 
    ? `/usr/src/app/scripts/generate_list.sh >> ${LOG_FILE} 2>&1` 
    : '/usr/src/app/scripts/generate_list.sh';
  
  try {
    await execAsync(command);
  } catch (error) {
    console.error(`Error executing generate_list.sh: ${error}`);
  }
}

async function runGeneratePosterCollage() {
  const isDebugMode = process.env.DEBUG && process.env.DEBUG.toLowerCase() === 'true';
  const debugMessage = isDebugMode ? ' [Debugging Enabled]' : '';
  console.log(`Running generate_poster_collage.py job${debugMessage}`);
  const command = isDebugMode 
    ? `python3 /usr/src/app/scripts/generate_poster_collage.py >> ${LOG_FILE} 2>&1` 
    : 'python3 /usr/src/app/scripts/generate_poster_collage.py';

  try {
    await execAsync(command);
  } catch (error) {
    console.error(`Error executing generate_poster_collage.py: ${error}`);
  }
}

function scheduleTasks() {
  schedule.scheduleJob('*/5 * * * *', () => {
    runGenerateList().catch(console.error);
  });

  schedule.scheduleJob('0 0 3,6,9,12,15,18,21,24,27,30 * *', () => {
    runGeneratePosterCollage().catch(console.error);
  });
}

async function initialize() {
  // Ensure cache directory exists
  await ensureCacheDir();

  //app.use(compression())

  // Start the server
  const port = 3000;
  app.listen(port, () => {
	  scheduleTasks();
	  console.log(`Server running on port ${port}`)
  });
}

// Initialize the application
initialize().catch(console.error);
