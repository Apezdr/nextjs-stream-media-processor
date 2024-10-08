const { exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs").promises;
const _fs = require("fs");
const os = require("os");
const { findMp4File, fileExists, ongoingCacheGenerations } = require("./utils");
const util = require('util');
const { getTVShowByName } = require("./sqliteDatabase");
const execAsync = util.promisify(exec);
const {
  ensureCacheDirs,
  generateCacheKey,
  getCachedClipPath,
  isCacheValid
} = require("./utils");

async function handleVideoRequest(req, res, type, BASE_PATH) {
  const { movieName, showName, season, episode } = req.params;
  const audioTrackParam = req.query.audio || "stereo"; // Default to "stereo" if no audio track specified

  try {
    let videoPath;
    if (type === "movies") {
      const directoryPath = path.join(`${BASE_PATH}/movies`, movieName);
      videoPath = await findMp4File(directoryPath);
    } else if (type === "tv") {
      const showsDataRaw = _fs.readFileSync(`${BASE_PATH}/tv_list.json`, "utf8");
      const showsData = JSON.parse(showsDataRaw);
      const showData = showsData[showName];

      if (!showData) {
        throw new Error(`Show not found: ${showName}`);
      }

      const _season = showData.seasons[`Season ${season}`];
      if (!_season) {
        throw new Error(`Season not found: ${showName} - Season ${season}`);
      }

      // Filter out transcoded audio channel files
      const originalEpisodeFiles = _season.fileNames.filter(
        (fileName) => !fileName.includes("_") && !fileName.includes("ch.mp4")
      );

      const _episode = originalEpisodeFiles.find((e) =>
        e.includes(`S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`)
      );

      if (!_episode) {
        throw new Error(`Episode not found: ${showName} - Season ${season} Episode ${episode}`);
      }

      const directoryPath = path.join(`${BASE_PATH}/tv`, showName, `Season ${season}`);
      videoPath = await findMp4File(directoryPath, _episode);
    }

    // Get the available audio tracks
    const audioTracks = await getAudioTracks(videoPath);

    // Determine the selected audio track
    let selectedAudioTrack;
    if (audioTrackParam === "max") {
      selectedAudioTrack = getHighestChannelTrack(audioTracks);
    } else if (audioTrackParam === "stereo") {
      selectedAudioTrack = audioTracks.findIndex(track => track.channels === 2);
      if (selectedAudioTrack === -1) {
        throw new Error("Stereo track not found");
      }
    } else {
      selectedAudioTrack = parseInt(audioTrackParam);
      if (isNaN(selectedAudioTrack) || selectedAudioTrack < 0 || selectedAudioTrack >= audioTracks.length) {
        throw new Error("Invalid audio track specified");
      }
    }

    // Get the channel count of the selected audio track
    const channelCount = audioTracks[selectedAudioTrack].channels;

    let modifiedVideoPath;

    if (audioTrackParam === "max" && channelCount === 2) {
      // Use the original video file if audio is set to "max" and channel count is 2
      modifiedVideoPath = videoPath;
      console.log("Using the original video file");
    } else {
      // Generate the modified MP4 file
      modifiedVideoPath = await generateModifiedMp4(videoPath, selectedAudioTrack, channelCount);
    }

    // Serve the video file (either modified or original) with support for range requests
    const stat = await fs.stat(modifiedVideoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (end - start) + 1;
      const fileStream = _fs.createReadStream(modifiedVideoPath, { start, end });

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4",
      });
      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
      });
      _fs.createReadStream(modifiedVideoPath).pipe(res);
    }
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal server error");
  }
}

async function getAudioTracks(videoPath) {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v quiet -print_format json -show_streams "${videoPath}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error getting audio tracks: ${error.message}`);
        reject(error);
      } else {
        const output = JSON.parse(stdout);
        const videoStreams = output.streams.filter((stream) => stream.codec_type === "video");
        const audioStreams = output.streams.filter((stream) => stream.codec_type === "audio");

        const videoTrackCount = videoStreams.length;

        const audioTracks = audioStreams.map((stream) => ({
          index: stream.index - videoTrackCount,
          codec: stream.codec_name,
          channels: stream.channels,
        }));

        resolve(audioTracks);
      }
    });
  });
}

function getHighestChannelTrack(audioTracks) {
  let highestChannelTrack = audioTracks[0];
  for (const track of audioTracks) {
    if (track.channels > highestChannelTrack.channels) {
      highestChannelTrack = track;
    }
  }
  return highestChannelTrack.index;
}

async function generateModifiedMp4(videoPath, audioTrack, channelCount) {
  const fileExtension = path.extname(videoPath);
  const fileNameWithoutExtension = path.basename(videoPath, fileExtension);
  const outputFileName = `${fileNameWithoutExtension}_${channelCount}ch${fileExtension}`;
  const outputPath = path.join(path.dirname(videoPath), outputFileName);

  // Check if the output file already exists
  try {
    await fs.access(outputPath);
    console.log(`Modified MP4 file already exists: ${outputPath}`);
    return outputPath;
  } catch (error) {
    // File doesn't exist, proceed with generating it
  }

  return new Promise((resolve, reject) => {
    const ffmpegCommand = `ffmpeg -i "${videoPath}" -map 0:v -map 0:a:${audioTrack} -c copy "${outputPath}"`;

    const ffmpegProcess = exec(ffmpegCommand);

    ffmpegProcess.on("close", (code) => {
      if (code === 0) {
        console.log(`Modified MP4 saved: ${outputPath}`);
        resolve(outputPath);
      } else {
        console.error(`FFmpeg process exited with code ${code}`);
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });

    ffmpegProcess.on("error", (error) => {
      console.error(`Error generating modified MP4: ${error.message}`);
      reject(error);
    });
  });
}

/**
 * Handles video clip requests by streaming a specific segment of the video.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {string} type - Type of media ('movies' or 'tv').
 * @param {string} basePath - Base path to media files.
 */
async function handleVideoClipRequest(req, res, type, basePath, db) {
  try {
    let videoPath;

    if (type === "movies") {
      const { movieName } = req.params;
      const directoryPath = path.join(`${basePath}/movies`, movieName);
      videoPath = await findMp4File(directoryPath);
    } else if (type === "tv") {
      const { showName, season, episode } = req.params;
      const showData = await getTVShowByName(db, showName);

      if (!showData) {
        throw new Error(`Show not found: ${showName}`);
      }

      const _season = showData.metadata.seasons[`Season ${season}`];
      if (!_season) {
        throw new Error(`Season not found: ${showName} - Season ${season}`);
      }

      const _episode = _season.fileNames.find((e) =>
        e.includes(`S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`)
      );

      if (!_episode) {
        throw new Error(`Episode not found: ${showName} - Season ${season} Episode ${episode}`);
      }

      const directoryPath = path.join(`${basePath}/tv`, showName, `Season ${season}`);
      videoPath = await findMp4File(directoryPath, _episode);
    }

    // Parse and validate start and end parameters
    const start = parseFloat(req.query.start);
    const end = parseFloat(req.query.end);
    const MAX_CLIP_DURATION = 300; // 5 minutes

    if (isNaN(start) || isNaN(end) || start < 0 || end <= start) {
      return res.status(400).send('Invalid start or end parameters.');
    }

    if ((end - start) > MAX_CLIP_DURATION) {
      return res.status(400).send(`Clip duration exceeds maximum allowed duration of ${MAX_CLIP_DURATION} seconds.`);
    }

    // Check if the video file exists
    if (!await fileExists(videoPath)) {
      return res.status(404).send('Video not found.');
    }

    // Get video duration to validate end time
    let videoDuration = 0;
    try {
      const { stdout: durationStdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`);
      videoDuration = parseFloat(durationStdout);
    } catch (err) {
      console.error('Error getting video duration:', err);
      return res.status(500).send('Error processing video.');
    }

    if (end > videoDuration) {
      return res.status(400).send('End time exceeds video duration.');
    }

    // Generate cache key and cached clip path
    const cacheKey = generateCacheKey(videoPath, start, end);
    const cachedClipPath = getCachedClipPath(cacheKey);

    // Check if cached clip exists and is valid
    if (await fileExists(cachedClipPath)) {
      console.log(`Serving cached clip: ${cachedClipPath}`);
      return serveCachedClip(res, cachedClipPath, type, req, start, end);
    }

    // Check if another request is already generating this clip
    if (ongoingCacheGenerations.has(cacheKey)) {
      console.log(`Waiting for ongoing generation of cache key: ${cacheKey}`);

      // Poll until the cached clip becomes available
      await waitForCache(cachedClipPath, 500, 10000); // Poll every 500ms, timeout after 10 seconds

      console.log(`Serving cached clip after waiting: ${cachedClipPath}`);
      return serveCachedClip(res, cachedClipPath, type, req, start, end);
    }

    // Add to ongoing generations
    ongoingCacheGenerations.add(cacheKey);

    // If not cached, generate the clip and cache it
    console.log(`Generating new clip for caching: ${cacheKey}`);

    await generateAndCacheClip(videoPath, start, end, cachedClipPath);

    // Serve the newly cached clip
    return serveCachedClip(res, cachedClipPath, type, req, start, end);

  } catch (error) {
    console.error(error);
    // Ensure the cache key is removed from ongoing generations in case of error
    ongoingCacheGenerations.delete(cacheKey);
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    } else {
      res.end();
    }
  }
}

// Function to generate the clip and save it to the cache
async function generateAndCacheClip(videoPath, start, end, cachedClipPath) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-ss', start.toString(),
      '-to', end.toString(),
      '-i', videoPath,
      '-c', 'copy',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'mp4',
      cachedClipPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stderr.on('data', (data) => {
      console.error(`FFmpeg stderr: ${data}`);
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg error:', err);
      reject(err);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(`Cached clip generated at: ${cachedClipPath}`);
        resolve();
      } else {
        console.error(`FFmpeg exited with code ${code}`);
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });
  });
}

// Function to serve the cached clip with appropriate headers and range support
async function serveCachedClip(res, cachedClipPath, type, req, start, end) {
  try {
    const stat = await fs.stat(cachedClipPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const startByte = parseInt(parts[0], 10);
      const endByte = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = (endByte - startByte) + 1;
      const fileStream = _fs.createReadStream(cachedClipPath, { start: startByte, end: endByte });

      res.writeHead(206, {
        "Content-Range": `bytes ${startByte}-${endByte}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4",
      });
      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
      });
      _fs.createReadStream(cachedClipPath).pipe(res);
    }
  } catch (error) {
    console.error(`Error serving cached clip: ${error.message}`);
    res.status(500).send('Error serving cached video.');
  }
}

// Utility function to wait for cache to be generated
async function waitForCache(cachedClipPath, intervalMs, timeoutMs) {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      if (await isCacheValid(cachedClipPath)) {
        clearInterval(interval);
        resolve();
      } else if ((Date.now() - startTime) > timeoutMs) {
        clearInterval(interval);
        reject(new Error('Cache generation timed out.'));
      }
    }, intervalMs);
  });
}

module.exports = {
  handleVideoRequest,
  handleVideoClipRequest,
};
