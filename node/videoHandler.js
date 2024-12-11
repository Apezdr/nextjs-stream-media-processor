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
} = require("./utils");
const { getHardwareAccelerationInfo } = require('./hardwareAcceleration'); // Adjust the path as needed
const encoderConfigs = require("./encoderConfig");
const { extractHDRInfo } = require("./infoManager");

let hardwareInfoPromise = null;

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
 * @param {Object} db - Database connection or reference.
 */
async function handleVideoClipRequest(req, res, type, basePath, db) {
  let cacheKey;
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

      const _episode = _season.fileNames.find((e) => {
        const episodeNumber = String(episode).padStart(2, "0");
        const seasonNumber = String(season).padStart(2, "0");

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

        return false;
      });

      if (!_episode) {
        throw new Error(`Episode not found: ${showName} - Season ${season} Episode ${episode}`);
      }

      const directoryPath = path.join(`${basePath}/tv`, showName, `Season ${season}`);
      videoPath = await findMp4File(directoryPath, _episode);
    }

    // Parse and validate start and end parameters
    const start = parseFloat(req.query.start);
    const end = parseFloat(req.query.end);
    const MAX_CLIP_DURATION = 600; // 10 minutes

    if (isNaN(start) || isNaN(end) || start < 0 || end <= start) {
      return res.status(400).send('Invalid start or end parameters.');
    }

    if ((end - start) > MAX_CLIP_DURATION) {
      return res.status(400).send(`Clip duration exceeds maximum allowed duration of ${MAX_CLIP_DURATION} seconds.`);
    }

    // Get source video codec and HDR information
    const probeCmd = `ffprobe -v quiet -print_format json -show_streams -show_format "${videoPath.replace(/"/g, '\\"')}"`;
    const videoMetadata = await new Promise((resolve, reject) => {
      exec(probeCmd, (error, stdout) => {
        if (error) reject(error);
        else resolve(JSON.parse(stdout));
      });
    });

    const videoStream = videoMetadata.streams.find(s => s.codec_type === 'video');
    const sourceCodec = videoStream.codec_name.toLowerCase();
    const isHDR = videoStream.color_transfer?.includes('smpte2084') || 
                  videoStream.color_space?.includes('bt2020');
    
    // Determine best encoder based on source and capabilities
    let selectedEncoderConfig;
    
    // For clips, prefer VP9 when possible
    if (encoderConfigs.vp9_vaapi) {
      selectedEncoderConfig = encoderConfigs.vp9_vaapi;
      console.log('Using VP9 VAAPI encoder for clip generation');
    
      // Create a copy of the config
      selectedEncoderConfig = { ...selectedEncoderConfig };
    
      // If HDR content, use HDR video filter chain
      if (isHDR) {
        console.log('Using HDR conversion filter chain');
        selectedEncoderConfig.vf = selectedEncoderConfig.hdr_vf;
      }
    } 
    // Fallback to HEVC for HDR content if VP9 is not available
    else if ((isHDR || sourceCodec === 'hevc') && encoderConfigs.hevc_vaapi) {
      selectedEncoderConfig = encoderConfigs.hevc_vaapi;
      console.log('Falling back to HEVC VAAPI encoder');
    }
    // Final fallback to H.264
    else {
      selectedEncoderConfig = encoderConfigs.libx264;
      console.log('Falling back to H.264 encoder');
    }

    // Verify VAAPI device availability
    if (selectedEncoderConfig.vaapi_device) {
      try {
        await fs.access(selectedEncoderConfig.vaapi_device);
      } catch (error) {
        console.warn('VAAPI device not available, falling back to software encoding');
        selectedEncoderConfig = encoderConfigs.libx264;
      }
    }

    // Generate cache key
    cacheKey = generateCacheKey(videoPath, start, end);
    const cachedClipPath = getCachedClipPath(cacheKey, selectedEncoderConfig.extension);

    // Check if cached clip exists and is valid
    if (await fileExists(cachedClipPath)) {
      console.log(`Serving existing cached clip: ${cachedClipPath}`);
      return serveCachedClip(res, cachedClipPath, type, req);
    }

    // Check if video file exists
    if (!await fileExists(videoPath)) {
      return res.status(404).send('Video not found.');
    }

    // Get video duration to validate end time
    const videoDuration = parseFloat(videoMetadata.format.duration);
    if (end > videoDuration) {
      return res.status(400).send('End time exceeds video duration.');
    }

    // Check if another request is already generating this clip
    if (ongoingCacheGenerations.has(cacheKey)) {
      console.log(`Waiting for ongoing generation of cache key: ${cacheKey}`);
      try {
        await waitForCache(cachedClipPath, 500, 45000);
        return serveCachedClip(res, cachedClipPath, type, req);
      } catch (error) {
        throw new Error('Cache generation timeout');
      }
    }

    // Add to ongoing generations
    ongoingCacheGenerations.add(cacheKey);

    try {
      // Generate the clip
      console.log(`Generating new clip for caching: ${cacheKey}`);
      await generateAndCacheClip(videoPath, start, end, cachedClipPath, selectedEncoderConfig, isHDR);
      
      // Serve the newly cached clip
      return serveCachedClip(res, cachedClipPath, type, req);
    } finally {
      // Ensure the cacheKey is removed regardless of success or failure
      ongoingCacheGenerations.delete(cacheKey);
    }

  } catch (error) {
    console.error('Error in clip generation:', error);
    if (cacheKey) {
      ongoingCacheGenerations.delete(cacheKey);
    }
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    } else {
      res.end();
    }
  }
}

/**
 * Generates a video clip and caches it using FFmpeg.
 * @param {string} videoPath - Path to the input video.
 * @param {number} start - Start time in seconds.
 * @param {number} end - End time in seconds.
 * @param {string} cachedClipPath - Full path to save the cached clip (with extension).
 * @param {Object} selectedEncoderConfig - Configuration for the selected encoder.
 * @param {boolean} isHDR - Flag indicating whether the video is HDR.
 * @returns {Promise<void>}
 */
async function generateAndCacheClip(videoPath, start, end, cachedClipPath, selectedEncoderConfig, isHDR) {
  const tmpDir = os.tmpdir();
  const tempPrefix = path.join(tmpDir, `ffmpeg-${Date.now()}`);
  const rawVideoFile = `${tempPrefix}-raw.mkv`;

  try {
    // Step 1: Extract the segment
    const extractArgs = [
      '-y',
      '-ss', start.toString(),
      '-t', (end - start).toString(),
      '-i', videoPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c', 'copy',
      '-f', 'matroska',
      rawVideoFile
    ];

    // Log the ffmpeg extract command
    console.log(`Executing FFmpeg extract command: ffmpeg ${extractArgs.join(' ')}`);

    // Extract segment
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', extractArgs);
      ffmpeg.stderr.on('data', (data) => console.error(`FFmpeg extract stderr: ${data}`));
      ffmpeg.on('error', reject);
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg extract exited with code ${code}`)));
    });

    // Step 2: Encode with appropriate filter chain
    const encodeArgs = [
      '-y'
    ];

    if (selectedEncoderConfig.vaapi_device) {
      encodeArgs.push('-vaapi_device', selectedEncoderConfig.vaapi_device);
    }

    encodeArgs.push(
      '-i', rawVideoFile,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-fps_mode', 'cfr',
      '-avoid_negative_ts', 'make_zero',
      '-max_muxing_queue_size', '9999'
    );

    // Add codec
    if (selectedEncoderConfig.codec) {
      encodeArgs.push('-c:v', selectedEncoderConfig.codec);
    }

    // Add video filter based on HDR status
    if (isHDR && selectedEncoderConfig.hdr_vf) {
      encodeArgs.push('-vf', selectedEncoderConfig.hdr_vf);
    } else if (selectedEncoderConfig.vf) {
      encodeArgs.push('-vf', selectedEncoderConfig.vf);
    }

    // **Handle 'additional_args' correctly**
    if (typeof selectedEncoderConfig.additional_args === 'function') {
      // If 'additional_args' is a function, call it with 'isHDR' and spread the resulting array
      const argsFromFunction = selectedEncoderConfig.additional_args(isHDR);
      if (Array.isArray(argsFromFunction)) {
        encodeArgs.push(...argsFromFunction);
      } else {
        throw new TypeError('additional_args function must return an array');
      }
    } else if (Array.isArray(selectedEncoderConfig.additional_args)) {
      // If 'additional_args' is an array, spread it directly
      encodeArgs.push(...selectedEncoderConfig.additional_args);
    } else if (selectedEncoderConfig.additional_args !== undefined) {
      // If 'additional_args' exists but is neither a function nor an array, throw an error
      throw new TypeError('additional_args must be a function or an array if defined');
    }
    // If 'additional_args' is undefined, do nothing (it's optional)

    // Add audio codec and output path
    encodeArgs.push(
      '-c:a', selectedEncoderConfig.audio_codec,
      cachedClipPath
    );

    // Log the ffmpeg encode command
    console.log(`Executing FFmpeg encode command: ffmpeg ${encodeArgs.join(' ')}`);

    // Execute encoding
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', encodeArgs);
      ffmpeg.stderr.on('data', (data) => console.error(`FFmpeg encode stderr: ${data}`));
      ffmpeg.on('error', reject);
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg encode exited with code ${code}`)));
    });

    // Verify the output
    const stats = await fs.stat(cachedClipPath);
    if (stats.size === 0) {
      throw new Error('Generated file is empty');
    }

    console.log(`Successfully generated clip at: ${cachedClipPath}`);

  } catch (error) {
    console.error('Error during clip generation:', error);
    // Cleanup
    for (const file of [rawVideoFile, cachedClipPath]) {
      if (_fs.existsSync(file)) {
        _fs.unlinkSync(file);
      }
    }
    throw error;
  } finally {
    // Clean up temporary files
    if (_fs.existsSync(rawVideoFile)) {
      _fs.unlinkSync(rawVideoFile);
    }
  }
}

// Function to serve the cached clip with enhanced headers and robust range support
async function serveCachedClip(res, cachedClipPath, type, req) {
  try {
    const stat = await fs.stat(cachedClipPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Generate ETag and Last-Modified
    const etag = `${stat.size}-${stat.mtime.getTime()}`;
    const lastModified = stat.mtime.toUTCString();

    // Set caching headers
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', lastModified);
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year

    // Handle conditional requests
    if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304);
      return res.end();
    }

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const startByte = parseInt(parts[0], 10);
      const endByte = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      // Validate range
      if (isNaN(startByte) || isNaN(endByte) || startByte > endByte || endByte >= fileSize) {
        res.writeHead(416, {
          "Content-Range": `bytes */${fileSize}`,
          "Content-Type": "video/mp4",
        });
        return res.end();
      }

      const chunkSize = (endByte - startByte) + 1;
      const fileStream = _fs.createReadStream(cachedClipPath, { start: startByte, end: endByte });

      // Handle stream errors
      fileStream.on('error', (streamErr) => {
        console.error(`Stream error: ${streamErr.message}`);
        res.status(500).send('Error streaming video.');
      });

      res.writeHead(206, {
        "Content-Range": `bytes ${startByte}-${endByte}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4",
      });
      fileStream.pipe(res);
    } else {
      const fileStream = _fs.createReadStream(cachedClipPath);

      // Handle stream errors
      fileStream.on('error', (streamErr) => {
        console.error(`Stream error: ${streamErr.message}`);
        res.status(500).send('Error streaming video.');
      });

      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": "video/mp4",
      });
      fileStream.pipe(res);
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
      if (await fileExists(cachedClipPath)) {
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
