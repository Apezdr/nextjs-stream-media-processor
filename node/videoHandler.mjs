import { exec, spawn } from "child_process";
import { join, extname, basename, dirname } from "path";
import { promises as fs } from "fs";
import { readFileSync, createReadStream, existsSync, unlinkSync, stat } from "fs";
import { tmpdir } from "os";
import { findMp4File, fileExists, ongoingCacheGenerations } from "./utils.mjs";
import { promisify } from 'util';
import { getTVShowByName, getMovieByName } from "./sqliteDatabase.mjs";
const execAsync = promisify(exec);
import { ensureCacheDirs, generateCacheKey, getCachedClipPath, getCachedTranscodedPath } from "./utils.mjs";
import { getHardwareAccelerationInfo } from './hardwareAcceleration.mjs'; // Adjust the path as needed
import { libx264, vp9_vaapi, hevc_vaapi, hevc_nvenc } from "./encoderConfig.mjs";
import { extractHDRInfo } from "./infoManager.mjs";
import { createCategoryLogger } from "./lib/logger.mjs";
import { isVideoHDR } from "./sprite.mjs";
const fileInfo = promisify(stat);

const logger = createCategoryLogger('videoHandler');
// Video Clip Generation Version Control (for cache invalidation)
const VIDEO_CLIP_VERSION = 1.0001;
const FULL_TRANSCODE_VERSION = 1.0001; // Increment if encoder settings change

let hardwareInfo;
async function initHardwareInfo() {
  if (!hardwareInfo) {
    hardwareInfo = await getHardwareAccelerationInfo();
  }
  return hardwareInfo;
}

async function getVideoCodec(videoPath) {
  const probeCmd = `ffprobe -v quiet -print_format json -show_streams "${videoPath.replace(/"/g, '\\"')}"`;
  try {
    const { stdout } = await execAsync(probeCmd);
    const metadata = JSON.parse(stdout);
    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
    return videoStream.codec_name.toLowerCase(); // e.g., 'h264'
  } catch (error) {
    logger.warn(`Failed to get video codec: ${error.message}`);
    return false; // Treat as no codec found
  }
}

function getExtensionFromCodec(codec) {
  // Map codecs to file extensions
  const codecToExtension = {
    'libx264': '.mp4',
    'vp9_vaapi': '.webm',
    'hevc_vaapi': '.mp4',
    'hevc_nvenc': '.mp4',
    // Add more mappings as needed
  };

  return codecToExtension[codec] || '.mp4'; // Default to .mp4
}

export async function handleVideoRequest(req, res, type, BASE_PATH) {
  const { movieName, showName, season, episode } = req.params;
  const audioTrackParam = req.query.audio || "stereo"; // Default to "stereo" if no audio track specified
  const videoCodecParam = req.query.video || false; // No default, use original codec if not specified

  try {
    let videoPath;
    if (type === "movies") {
      const directoryPath = join(`${BASE_PATH}/movies`, movieName);
      videoPath = await findMp4File(directoryPath);
    } else if (type === "tv") {
      const showsDataRaw = readFileSync(`${BASE_PATH}/tv_list.json`, "utf8");
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

      const directoryPath = join(`${BASE_PATH}/tv`, showName, `Season ${season}`);
      videoPath = await findMp4File(directoryPath, _episode);
    }

    // If no video path found:
    if (!videoPath) {
      throw new Error("Video file not found");
    }

    // 1) Collect audio track data
    const audioTracks = await getAudioTracks(videoPath);
    // 2) Figure out which track to use
    const { selectedAudioTrack, channelCount } = determineSelectedAudioTrack(audioTracks, audioTrackParam);

    // 3) Determine the original video codec using ffprobe
    const originalCodec = await getVideoCodec(videoPath);

    // 4) Decide if we need to transcode based on videoCodecParam and audio parameters
    let needsTranscode = false;
    let targetCodec = originalCodec; // Default to original codec

    if (videoCodecParam) {
      if (videoCodecParam !== originalCodec) {
        needsTranscode = true;
        targetCodec = videoCodecParam;
      }
    }

    if (audioTrackParam !== "max" && channelCount !== 2) {
      needsTranscode = true;
      // Note: If targetCodec is already set by videoCodecParam, retain it
    }

    // 5) Generate cache key based on video parameters and target codec
    const videoBaseName = basename(videoPath, extname(videoPath)); // Extracts only the filename without extension
    const cacheKeyComponents = [
      videoBaseName,
      selectedAudioTrack,
      channelCount,
      targetCodec,
      `v${FULL_TRANSCODE_VERSION}`
    ];
    const cacheKey = cacheKeyComponents.join('-'); // e.g., "videoName-0-2-libx264-v1.0001"

    // Generate a hashed cache key to ensure it's directory-safe
    const hashedCacheKey = generateCacheKey(cacheKey); // Assuming this hashes the string without adding slashes

    // Define cache path
    const transcodedFilePath = getCachedTranscodedPath(hashedCacheKey, getExtensionFromCodec(targetCodec))

    let finalVideoPath;

    if (!needsTranscode) {
      // No transcoding needed, serve original file
      finalVideoPath = videoPath;
      logger.info("No transcoding needed, serving original video file.");
    } else {
      // Check if transcoded file already exists
      if (await fileExists(transcodedFilePath) && !ongoingCacheGenerations.has(cacheKey)) {
        logger.info(`Serving existing transcoded video: ${transcodedFilePath}`);
        finalVideoPath = transcodedFilePath;
      } else {
        // Check if another request is already transcoding this file
        if (ongoingCacheGenerations.has(cacheKey)) {
          logger.info(`Waiting for ongoing transcoding of cache key: ${cacheKey}`);
          try {
            await waitForCache(transcodedFilePath, 500, 120000); // Wait up to 2 minutes
            if (await fileExists(transcodedFilePath)) {
              finalVideoPath = transcodedFilePath;
            } else {
              throw new Error('Transcoding failed or timed out.');
            }
          } catch (error) {
            throw new Error('Transcoding timed out.');
          }
        } else {
          // Initiate transcoding
          ongoingCacheGenerations.add(cacheKey);
          try {
            logger.info(`Initiating transcoding for cache key: ${cacheKey}`);
            await generateFullTranscode(videoPath, selectedAudioTrack, channelCount, transcodedFilePath, targetCodec, { width: 1920 });
            finalVideoPath = transcodedFilePath;
          } finally {
            ongoingCacheGenerations.delete(cacheKey);
          }
        }
      }
    }

    // Serve the final video file with range support
    //return serveCachedClip(res, finalVideoPath, type, req);
    return serveVideoWithRange(req, res, finalVideoPath);
  } catch (error) {
    logger.error(`Error in handleVideoRequest: ${error.message}`);
    res.status(500).send("Internal server error");
  }
}

function determineSelectedAudioTrack(audioTracks, audioTrackParam) {
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

  const channelCount = audioTracks[selectedAudioTrack]?.channels || 2;
  return { selectedAudioTrack, channelCount };
}

async function getAudioTracks(videoPath) {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v quiet -print_format json -show_streams "${videoPath}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        logger.error(`Error getting audio tracks: ${error.message}`);
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

async function generateFullTranscode(inputPath, audioTrackIndex, channelCount, outputPath, targetCodec, scaleOverride = null) {
  // 1) Select encoder config based on targetCodec
  let selectedEncoderConfig = libx264; // Default to libx264
  if (targetCodec === 'vp9_vaapi') {
    selectedEncoderConfig = vp9_vaapi;
  } else if (targetCodec === 'hevc_vaapi') {
    selectedEncoderConfig = hevc_vaapi;
  } else if (targetCodec === 'hevc_nvenc') {
    selectedEncoderConfig = hevc_nvenc;
  } else if (targetCodec === 'libx264') {
    selectedEncoderConfig = libx264;
  } else {
    logger.warn(`Unsupported codec "${targetCodec}". Falling back to libx264.`);
    selectedEncoderConfig = libx264;
  }

  // 2) Detect HDR
  const isHDR = await isVideoHDR(inputPath);

  // 3) Pick and optionally override the filter chain
  let videoFilter;
  const baseFilter = isHDR && selectedEncoderConfig.hdr_vf
    ? selectedEncoderConfig.hdr_vf
    : typeof selectedEncoderConfig.vf === 'function'
    ? selectedEncoderConfig.vf(isHDR)
    : selectedEncoderConfig.vf;

  if (scaleOverride && baseFilter) {
    // Dynamically replace `scale` in the filter chain
    videoFilter = baseFilter.replace(/scale=\d+:-?\d+/g, `scale=${scaleOverride.width}:${scaleOverride.height || -2}`);
    logger.info(`Overriding scale parameter in filter chain: ${videoFilter}`);
  } else {
    videoFilter = baseFilter; // Use the default filter
  }

  // 4) Gather additional_args (often a function)
  let additionalArgs = [];
  if (typeof selectedEncoderConfig.additional_args === 'function') {
    additionalArgs = selectedEncoderConfig.additional_args(isHDR);
  } else if (Array.isArray(selectedEncoderConfig.additional_args)) {
    additionalArgs = selectedEncoderConfig.additional_args;
  }

  // 5) Construct FFmpeg arguments
  const ffmpegArgs = ['-y'];

  // 6) Conditionally add VAAPI device for hardware acceleration
  if (selectedEncoderConfig.vaapi_device) {
    ffmpegArgs.push('-vaapi_device', selectedEncoderConfig.vaapi_device);
  }

  // 7) Input file
  ffmpegArgs.push('-i', inputPath);

  // 8) Map the chosen tracks
  ffmpegArgs.push('-map', '0:v:0', '-map', `0:a:${audioTrackIndex}?`);

  // 9) Set video and audio codecs
  ffmpegArgs.push('-c:v', selectedEncoderConfig.codec, '-c:a', selectedEncoderConfig.audio_codec || 'aac');

  // 10) Add common options
  ffmpegArgs.push(
    '-fps_mode', 'cfr',
    '-avoid_negative_ts', 'make_zero',
    '-max_muxing_queue_size', '9999'
  );

  // **Add container-specific flags**
  const containerExtension = extname(outputPath).toLowerCase();
  if (containerExtension === '.mp4') {
    ffmpegArgs.push('-movflags', '+faststart');
  } else if (containerExtension === '.webm') {
    // Fragmented WebM flags
    //ffmpegArgs.push('-g', '30'); // GOP size (30 frames)
    ffmpegArgs.push('-frag_duration', '1000000'); // Fragment duration in microseconds (1 second)
  }

  // 11) Add video filter if applicable
  if (videoFilter && !stringArrayContainsArg(additionalArgs, '-vf')) {
    ffmpegArgs.push('-vf', videoFilter);
  }

  // 12) Add channel count if not already in additional_args
  if (!stringArrayContainsArg(additionalArgs, '-ac')) {
    ffmpegArgs.push('-ac', channelCount.toString());
  }

  // 13) Spread additional_args from the config
  ffmpegArgs.push(...additionalArgs);

  // 14) Output path
  ffmpegArgs.push(outputPath);

  // For logging/diagnostics
  logger.info(`Executing FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

  // 15) Spawn the FFmpeg process
  return new Promise(async (resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stderr.on('data', (data) => logger.error(`FFmpeg stderr: ${data}`));
    ffmpeg.on('error', (error) => {
      logger.error(`Error during FFmpeg process: ${error.message}`);
      reject(error);
    });
    ffmpeg.on('close', async (code) => {
      if (code === 0) {
        // Verify the output file
        if (await fileExists(outputPath)) {
          logger.info(`Successfully transcoded video: ${outputPath}`);
          resolve();
        } else {
          logger.error(`Transcoded file not found: ${outputPath}`);
          reject(new Error('Transcoded file not found.'));
        }
      } else {
        logger.error(`FFmpeg exited with code ${code}`);
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
  });
}

/**
 * Helper to see if an array of arguments includes a certain argument key (e.g. "-vf").
 * Simple utility so we don’t double-add the same flag.
 */
function stringArrayContainsArg(argsArray, argKey) {
  // e.g. argKey = "-vf" or "-ac"
  return argsArray.some((item) => item.trim().toLowerCase() === argKey);
}

async function generateModifiedMp4(videoPath, audioTrack, channelCount) {
  const fileExtension = extname(videoPath);
  const fileNameWithoutExtension = basename(videoPath, fileExtension);
  const outputFileName = `${fileNameWithoutExtension}_${channelCount}ch${fileExtension}`;
  const outputPath = join(dirname(videoPath), outputFileName);

  // Check if the output file already exists
  try {
    await fs.access(outputPath);
    logger.info(`Modified MP4 file already exists: ${outputPath}`);
    return outputPath;
  } catch (error) {
    // File doesn't exist, proceed with generating it
  }

  return new Promise((resolve, reject) => {
    const ffmpegCommand = `ffmpeg -i "${videoPath}" -map 0:v -map 0:a:${audioTrack} -c copy "${outputPath}"`;

    const ffmpegProcess = exec(ffmpegCommand);

    ffmpegProcess.on("close", (code) => {
      if (code === 0) {
        logger.info(`Modified MP4 saved: ${outputPath}`);
        resolve(outputPath);
      } else {
        logger.error(`FFmpeg process exited with code ${code}`);
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });

    ffmpegProcess.on("error", (error) => {
      logger.error(`Error generating modified MP4: ${error.message}`);
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
export async function handleVideoClipRequest(req, res, type, basePath, db) {
  let cacheKey;
  try {
    let videoPath;
    let videoID = null;

    if (type === "movies") {
      const { movieName } = req.params;
      const movieData = await getMovieByName(db, movieName);
      if (!movieData) {
        throw new Error(`Movie not found: ${movieName}`);
      }
      videoID = movieData._id;
      const directoryPath = join(`${basePath}/movies`, movieName);
      videoPath = await findMp4File(directoryPath);
    } else if (type === "tv") {
      const { showName, season, episode } = req.params;
      const showData = await getTVShowByName(db, showName);

      if (!showData) {
        throw new Error(`Show not found: ${showName}`);
      }

      const _season = showData.seasons[`Season ${season}`];
      if (!_season) {
        throw new Error(`Season not found: ${showName} - Season ${season}`);
      }

      const arrayOfEpisodes = Object.keys(_season.episodes);

      const _episode = arrayOfEpisodes.find((e) => {
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

      const directoryPath = join(`${basePath}/tv`, showName, `Season ${season}`);
      const episodePath = _season.episodes[_episode].filename;
      videoID = _season.episodes[_episode]._id;
      videoPath = await findMp4File(directoryPath, episodePath);
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

    const hardwareInfo = await initHardwareInfo();
    let selectedEncoder = null;

    if (!hardwareInfo || !hardwareInfo.encoder) {
      logger.info('No suitable hardware encoder found. Falling back to software encoding.');
      selectedEncoderConfig = libx264;
      selectedEncoder = 'libx264';
    } else {
      const availableEncoder = hardwareInfo.encoder.encoder;
      switch (availableEncoder) {
        case 'vp9_vaapi':
          selectedEncoderConfig = vp9_vaapi;
          selectedEncoder = 'vp9_vaapi';
          logger.info('Using VP9 VAAPI encoder based on hardware info');
          break;
        case 'hevc_vaapi':
          selectedEncoderConfig = hevc_vaapi;
          selectedEncoder = 'hevc_vaapi';
          logger.info('Using HEVC VAAPI encoder based on hardware info');
          break;
        case 'hevc_nvenc':
          selectedEncoderConfig = hevc_nvenc;
          selectedEncoder = 'hevc_nvenc';
          logger.info('Using HEVC NVENC encoder based on hardware info');
          break;
        default:
          // Fallback to software encoding if no suitable hardware encoder is found
          selectedEncoderConfig = libx264;
          selectedEncoder = 'libx264';
          logger.info('Falling back to H.264 encoder (no suitable hardware encoder found)');
      }

      // If HDR content and using vp9_vaapi, use HDR video filter chain
      if (isHDR && selectedEncoderConfig.codec === 'vp9_vaapi') {
        logger.info('Using HDR conversion filter chain');
        selectedEncoderConfig = { ...selectedEncoderConfig }; // Create a copy
        selectedEncoderConfig.vf = selectedEncoderConfig.hdr_vf;
      }
    }

    // Verify VAAPI device availability (if applicable)
    if (selectedEncoderConfig.vaapi_device) {
      try {
        await fs.access(selectedEncoderConfig.vaapi_device);
      } catch (error) {
        logger.warn('VAAPI device not available, falling back to software encoding');
        selectedEncoder = 'libx264';
        selectedEncoderConfig = libx264;
      }
    }

    // Generate cache key
    //cacheKey = generateCacheKey(videoPath, start, end);
    cacheKey = `${videoID}-v${VIDEO_CLIP_VERSION}-s_${start}-e_${end}-${selectedEncoder}`;
    const cachedClipPath = getCachedClipPath(cacheKey, selectedEncoderConfig.extension);

    // Check if cached clip exists and is valid
    if (await fileExists(cachedClipPath)) {
      logger.info(`Serving existing cached clip: ${cachedClipPath}`);
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
      logger.info(`Waiting for ongoing generation of cache key: ${cacheKey}`);
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
      logger.info(`Generating new clip for caching: ${cacheKey}`);
      await generateAndCacheClip(videoPath, start, end, cachedClipPath, selectedEncoderConfig, isHDR);
      
      // Serve the newly cached clip
      return serveCachedClip(res, cachedClipPath, type, req);
    } finally {
      // Ensure the cacheKey is removed regardless of success or failure
      ongoingCacheGenerations.delete(cacheKey);
    }

  } catch (error) {
    logger.error('Error in clip generation:', error);
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
  const tmpDir = tmpdir();
  const tempPrefix = join(tmpDir, `ffmpeg-${Date.now()}`);
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
    logger.info(`Executing FFmpeg extract command: ffmpeg ${extractArgs.join(' ')}`);

    // Extract segment
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', extractArgs);
      ffmpeg.stderr.on('data', (data) => logger.error(`FFmpeg extract stderr: ${data}`));
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

    // **Handle 'vf' correctly: Check if it's a function or a string**
    if (isHDR && selectedEncoderConfig.hdr_vf) {
      encodeArgs.push('-vf', selectedEncoderConfig.hdr_vf);
    } else if (selectedEncoderConfig.vf) {
      const vf = typeof selectedEncoderConfig.vf === 'function' 
        ? selectedEncoderConfig.vf(isHDR) 
        : selectedEncoderConfig.vf;
      encodeArgs.push('-vf', vf);
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
    logger.info(`Executing FFmpeg encode command: ffmpeg ${encodeArgs.join(' ')}`);

    // Execute encoding
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', encodeArgs);
      ffmpeg.stderr.on('data', (data) => logger.error(`FFmpeg encode stderr: ${data}`));
      ffmpeg.on('error', reject);
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg encode exited with code ${code}`)));
    });

    // Verify the output
    const stats = await fs.stat(cachedClipPath);
    if (stats.size === 0) {
      throw new Error('Generated file is empty');
    }

    logger.info(`Successfully generated clip at: ${cachedClipPath}`);

  } catch (error) {
    logger.error('Error during clip generation:', error);
    // Cleanup
    for (const file of [rawVideoFile, cachedClipPath]) {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    }
    throw error;
  } finally {
    // Clean up temporary files
    if (existsSync(rawVideoFile)) {
      unlinkSync(rawVideoFile);
    }
  }
}

const mimeTypes = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  // Add more mappings as needed
};

function getMimeType(filePath) {
  const ext = extname(filePath).toLowerCase();
  return mimeTypes[ext] || 'application/octet-stream';
}

async function serveVideoWithRange(req, res, videoPath) {
  try {
    const stat = await fileInfo(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Generate ETag and Last-Modified headers
    const etag = `${stat.size}-${stat.mtime.getTime()}`;
    const lastModified = stat.mtime.toUTCString();

    // Set caching headers
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', lastModified);
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year

    // Determine the MIME type of the video
    const mimeType = getMimeType(videoPath) || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);

    // Handle conditional requests (If-None-Match / If-Modified-Since)
    if (
      req.headers['if-none-match'] === etag ||
      req.headers['if-modified-since'] === lastModified
    ) {
      res.writeHead(304);
      return res.end();
    }

    if (range) {
      const rangePattern = /^bytes=(\d*)-(\d*)$/;
      const matches = range.match(rangePattern);

      if (!matches) {
        // Invalid Range header format
        res.writeHead(416, {
          'Content-Range': `bytes */${fileSize}`,
          'Content-Type': mimeType,
        });
        return res.end();
      }

      let start = matches[1];
      let end = matches[2];

      let startByte;
      let endByte;

      if (start === '' && end === '') {
        // Both start and end are missing; invalid range
        res.writeHead(416, {
          'Content-Range': `bytes */${fileSize}`,
          'Content-Type': mimeType,
        });
        return res.end();
      }

      if (start === '') {
        // Suffix byte range: bytes=-500 (last 500 bytes)
        const suffixLength = parseInt(end, 10);
        if (isNaN(suffixLength)) {
          res.writeHead(416, {
            'Content-Range': `bytes */${fileSize}`,
            'Content-Type': mimeType,
          });
          return res.end();
        }
        startByte = fileSize - suffixLength;
        endByte = fileSize - 1;
      } else {
        // Start is specified
        startByte = parseInt(start, 10);
        endByte = end ? parseInt(end, 10) : fileSize - 1;

        // Validate startByte and endByte
        if (
          isNaN(startByte) ||
          isNaN(endByte) ||
          startByte > endByte ||
          startByte < 0 ||
          endByte >= fileSize
        ) {
          res.writeHead(416, {
            'Content-Range': `bytes */${fileSize}`,
            'Content-Type': mimeType,
          });
          return res.end();
        }
      }

      const chunkSize = endByte - startByte + 1;

      // Set response headers for partial content
      res.writeHead(206, {
        'Content-Range': `bytes ${startByte}-${endByte}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      });

      // Create a read stream for the specified range
      const fileStream = createReadStream(videoPath, { start: startByte, end: endByte });

      // Handle stream errors
      fileStream.on('error', (err) => {
        logger.error(`Stream error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end('Error streaming video.');
      });

      // Pipe the stream to the response
      fileStream.pipe(res);
    } else {
      // No Range header; send the entire file
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
      });

      const fileStream = createReadStream(videoPath);

      // Handle stream errors
      fileStream.on('error', (err) => {
        logger.error(`Stream error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end('Error streaming video.');
      });

      // Pipe the stream to the response
      fileStream.pipe(res);
    }
  } catch (error) {
    logger.error(`Error serving video: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
    }
    res.end('Internal server error');
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

    // Set the correct Content-Type based on file extension
    const mimeType = getMimeType(cachedClipPath);
    res.setHeader('Content-Type', mimeType);

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
          "Content-Type": mimeType,
        });
        return res.end();
      }

      const chunkSize = (endByte - startByte) + 1;
      const fileStream = createReadStream(cachedClipPath, { start: startByte, end: endByte });

      // Handle stream errors
      fileStream.on('error', (streamErr) => {
        logger.error(`Stream error: ${streamErr.message}`);
        res.status(500).send('Error streaming video.');
      });

      res.writeHead(206, {
        "Content-Range": `bytes ${startByte}-${endByte}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": mimeType,
      });
      fileStream.pipe(res);
    } else {
      const fileStream = createReadStream(cachedClipPath);

      // Handle stream errors
      fileStream.on('error', (streamErr) => {
        logger.error(`Stream error: ${streamErr.message}`);
        res.status(500).send('Error streaming video.');
      });

      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": mimeType,
      });
      fileStream.pipe(res);
    }
  } catch (error) {
    logger.error(`Error serving cached clip: ${error.message}`);
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
