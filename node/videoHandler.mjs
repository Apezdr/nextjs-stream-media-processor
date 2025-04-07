import { exec } from "child_process";
import { join, extname, basename } from "path";
import { promises as fs } from "fs";
import { readFileSync, createReadStream } from "fs";
import { findMp4File, fileExists, ongoingCacheGenerations, fileInfo } from "./utils/utils.mjs";
import { getTVShowByName, getMovieByName } from "./sqliteDatabase.mjs";
//const execAsync = promisify(exec);
import { generateCacheKey, getCachedClipPath, getCachedTranscodedPath } from "./utils/utils.mjs";
import { getHardwareAccelerationInfo } from './hardwareAcceleration.mjs';
import { libx264, vp9_vaapi, hevc_vaapi, hevc_nvenc } from "./ffmpeg/encoderConfig.mjs";
import { createCategoryLogger } from "./lib/logger.mjs";
//import { extractHDRInfo } from "./mediaInfo/mediaInfo.mjs";
import { generateAndCacheClip, generateFullTranscode } from "./ffmpeg/transcode.mjs";
import { getAudioTracks, getVideoCodec } from "./ffmpeg/ffprobe.mjs";
import { getInfo } from "./infoManager.mjs";

const logger = createCategoryLogger('videoHandler');
// Video Clip Generation Version Control (for cache invalidation)
const VIDEO_CLIP_VERSION = 1.0002;
const FULL_TRANSCODE_VERSION = 1.0001; // Increment if encoder settings change

let hardwareInfo;
async function initHardwareInfo() {
  if (!hardwareInfo) {
    hardwareInfo = await getHardwareAccelerationInfo();
  }
  return hardwareInfo;
}

/**
 * Determines the file extension based on the provided video codec.
 * @param {string} codec - The video codec to map to a file extension.
 * @returns {string} The file extension corresponding to the input codec, or '.mp4' if the codec is not found in the mapping.
 */
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

/**
 * Handles video clip requests by streaming a specific segment of the video.
 * This function is responsible for determining the appropriate audio track, video codec, and whether transcoding is required. It also manages the caching of transcoded video files.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {string} type - Type of media ('movies' or 'tv').
 * @param {string} BASE_PATH - Base path to media files.
 * @param {Object} db - Database connection.
 * @returns {Promise<void>} - Resolves when the video has been served.
 */
export async function handleVideoRequest(req, res, type, BASE_PATH, db) {
  const { movieName, showName, season, episode } = req.params;
  const audioTrackParam = req.query.audio || "stereo"; // Default to "stereo" if no audio track specified
  const videoCodecParam = req.query.video || false; // No default, use original codec if not specified

  try {
    let videoPath;
    if (type === "movies") {
      const directoryPath = join(`${BASE_PATH}/movies`, movieName);
      videoPath = await findMp4File(directoryPath);
    } else if (type === "tv") {
      // Get TV show data from SQLite database
      const showData = await getTVShowByName(db, showName);
      
      if (!showData) {
        throw new Error(`Show not found: ${showName}`);
      }

      const _season = showData.seasons[`Season ${season}`];
      if (!_season) {
        throw new Error(`Season not found: ${showName} - Season ${season}`);
      }

      // Get episode keys from the season data
      const episodeKeys = Object.keys(_season.episodes);
      
      // Find the matching episode using S01E01 format pattern
      const episodeNumber = String(episode).padStart(2, "0");
      const seasonNumber = String(season).padStart(2, "0");
      const episodeKey = episodeKeys.find((e) => {
        // Match S01E01 format
        const standardMatch = e.match(/S(\d{2})E(\d{2})/i);
        if (standardMatch) {
          const matchedSeason = standardMatch[1];
          const matchedEpisode = standardMatch[2];
          return matchedSeason === seasonNumber && matchedEpisode === episodeNumber;
        }

        // Match "01 - Episode Name.mp4" format or variations
        const alternateMatch = e.match(/^(\d{2})\s*-/);
        if (alternateMatch) {
          const matchedEpisode = alternateMatch[1];
          return matchedEpisode === episodeNumber;
        }

        return false;
      });

      if (!episodeKey) {
        throw new Error(`Episode not found: ${showName} - Season ${season} Episode ${episode}`);
      }

      const episodePath = _season.episodes[episodeKey].filename;
      const directoryPath = join(`${BASE_PATH}/tv`, showName, `Season ${season}`);
      videoPath = await findMp4File(directoryPath, episodePath);
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
              ongoingCacheGenerations.delete(cacheKey);
              throw new Error('Transcoding failed or timed out.');
            }
          } catch (error) {
            ongoingCacheGenerations.delete(cacheKey);
            throw new Error('Transcoding timed out.');
          }
        } else {
          // Initiate transcoding
          ongoingCacheGenerations.add(cacheKey);
          try {
            logger.info(`Initiating transcoding for cache key: ${cacheKey}`);
            await generateFullTranscode(videoPath, selectedAudioTrack, channelCount, transcodedFilePath, targetCodec, 'full');
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

/**
 * Determines the selected audio track based on the provided audio track parameter.
 * @param {Object[]} audioTracks - An array of audio track objects, each with a 'channels' property.
 * @param {string|number} audioTrackParam - The parameter specifying the desired audio track. Can be 'max', 'stereo', or a numeric index.
 * @returns {Object} An object containing the selected audio track index and the channel count of the selected track.
 * @throws {Error} If the 'stereo' track is not found or the specified audio track index is invalid.
 */
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

/**
 * Finds the audio track with the highest number of channels from the provided list of audio tracks.
 * @param {Object[]} audioTracks - An array of audio track objects, each with a 'channels' property.
 * @returns {number} The index of the audio track with the highest number of channels.
 */
function getHighestChannelTrack(audioTracks) {
  let highestChannelTrack = audioTracks[0];
  for (const track of audioTracks) {
    if (track.channels > highestChannelTrack.channels) {
      highestChannelTrack = track;
    }
  }
  return highestChannelTrack.index;
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
    let title;
    let videoID = null;

    if (type === "movies") {
      const { movieName } = req.params;
      const movieData = await getMovieByName(db, movieName);
      title = movieData.name;
      if (!movieData) {
        throw new Error(`Movie not found: ${movieName}`);
      }
      videoID = movieData._id;
      const directoryPath = join(`${basePath}/movies`, movieName);
      videoPath = await findMp4File(directoryPath);
    } else if (type === "tv") {
      const { showName, season, episode } = req.params;
      const showData = await getTVShowByName(db, showName);
      title = showData.name;

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
    let videoKey = videoID;
    // Bypassing the TMDB id
    if (await fileExists(videoPath)) {
      const info = await getInfo(videoPath);
      videoKey = info.uuid;
    }
    cacheKey = `${title}-key_${videoKey}-start_${start}-end_${end}-v${VIDEO_CLIP_VERSION}-${selectedEncoder}`;
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
      await generateAndCacheClip(videoPath, start, end, cachedClipPath, selectedEncoderConfig, isHDR, 'clip');
      
      // Serve the newly cached clip
      return serveCachedClip(res, cachedClipPath, type, req);
    } finally {
      // Ensure the cacheKey is removed regardless of success or failure
      ongoingCacheGenerations.delete(cacheKey);
    }

  } catch (error) {
    logger.error('Error in clip generation:'+ error.message);
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
