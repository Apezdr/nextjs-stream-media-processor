import { exec, spawn } from "child_process";
import { join, extname } from "path";
import { promises as fs } from "fs";
import { readFileSync, createReadStream } from "fs";
import { fileExists, ongoingCacheGenerations, fileInfo } from "./utils/utils.mjs";
import { resolveMovieVideo, resolveEpisodeVideo, findEpisodeEntry } from "./utils/mediaResolution.mjs";
import { getTVShowByName, getMovieByName } from "./sqliteDatabase.mjs";
//const execAsync = promisify(exec);
import { getCachedClipPath } from "./utils/utils.mjs";
import { getHardwareAccelerationInfo } from './hardwareAcceleration.mjs';
import { libx264, vp9_vaapi, hevc_vaapi, hevc_nvenc } from "./ffmpeg/encoderConfig.mjs";
import { createCategoryLogger } from "./lib/logger.mjs";
//import { extractHDRInfo } from "./mediaInfo/mediaInfo.mjs";
import { generateAndCacheClip } from "./ffmpeg/transcode.mjs";
import { doviReshapeRequired, libplaceboAvailable } from "./ffmpeg/dolbyVision.mjs";
import { getInfo } from "./infoManager.mjs";

const logger = createCategoryLogger('videoHandler');
// Video Clip Generation Version Control (for cache invalidation)
const VIDEO_CLIP_VERSION = 1.0002;

let hardwareInfo;
async function initHardwareInfo() {
  if (!hardwareInfo) {
    hardwareInfo = await getHardwareAccelerationInfo();
  }
  return hardwareInfo;
}

/**
 * Serves a specific time segment from the original video using FFmpeg stream copy
 * This extracts the exact time segment without re-encoding, preserving original quality
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {string} videoPath - Path to the video file
 * @param {number} start - Start time in seconds
 * @param {number} end - End time in seconds
 * @param {string} title - Video title for logging
 */
async function serveOriginalVideoWithRanges(req, res, videoPath, start, end, title, videoID) {
  try {
    const duration = end - start;
    
    // Get video UUID for cache invalidation (same approach as handleVideoClipRequest)
    let videoKey = videoID;
    if (await fileExists(videoPath)) {
      const info = await getInfo(videoPath);
      videoKey = info.uuid;
    }
    
    // Check if this is a range request from the browser
    const range = req.headers.range;
    if (range) {
      // For range requests, we need to serve the pre-generated segment file
      // Instead of trying to stream FFmpeg output with ranges
      logger.info(`Range request detected for original video: ${range}`);
      
      // Generate cache key including video UUID for cache invalidation (same pattern as handleVideoClipRequest)
      const originalCacheKey = `${title}-key_${videoKey}-start_${start}-end_${end}-v${VIDEO_CLIP_VERSION}-original`;
      // The segment below is remuxed with `-c copy` into the SOURCE's container
      // (getOutputFormat), so the cached file must carry that container's
      // extension. Hardcoding '.mp4' wrote matroska bytes into a .mp4 name and
      // then served them as video/mp4. Paired with the eviction predicate in
      // clearOriginalSegmentsCache — change one, change the other.
      const cachedOriginalPath = getCachedClipPath(
        originalCacheKey,
        extensionForFormat(getOutputFormat(videoPath))
      );
      
      // Check if cached original segment already exists
      const cacheExists = await fileExists(cachedOriginalPath);
      
      if (!cacheExists) {
        // Check if another request is already generating this original segment
        if (ongoingCacheGenerations.has(originalCacheKey)) {
          logger.info(`Waiting for ongoing generation of original cache key: ${originalCacheKey}`);
          try {
            await waitForCache(cachedOriginalPath, 500, 45000);
            return serveVideoWithRange(req, res, cachedOriginalPath);
          } catch (error) {
            throw new Error('Original segment cache generation timeout');
          }
        }
        
        // Add to ongoing generations
        ongoingCacheGenerations.add(originalCacheKey);
        
        try {
          // Generate the segment file using existing cache system
          const mimeType = getMimeType(videoPath);
          const outputFormat = getOutputFormat(videoPath);
          
          const ffmpegArgs = [
            '-ss', start.toString(),
            '-i', videoPath,
            '-t', duration.toString(),
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            '-f', outputFormat
          ];
          
          if (outputFormat === 'mp4') {
            ffmpegArgs.push('-movflags', 'faststart'); // Better for range requests
          }
          
          ffmpegArgs.push(cachedOriginalPath);
          
          logger.info(`Generating original segment for cache: ${originalCacheKey}`);
          logger.debug(`FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);
          
          return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
              stdio: ['ignore', 'pipe', 'pipe']
            });
            
            let stderrData = '';
            ffmpeg.stderr.on('data', (data) => {
              stderrData += data.toString();
            });
            
            ffmpeg.on('exit', (code) => {
              ongoingCacheGenerations.delete(originalCacheKey);
              
              if (code === 0) {
                logger.info(`Original segment cached successfully: ${cachedOriginalPath}`);
                // Now serve the file with range support
                serveVideoWithRange(req, res, cachedOriginalPath).then(resolve).catch(reject);
              } else {
                logger.error(`FFmpeg failed to generate original segment: ${stderrData}`);
                reject(new Error('Failed to generate original video segment'));
              }
            });
            
            ffmpeg.on('error', (error) => {
              ongoingCacheGenerations.delete(originalCacheKey);
              logger.error(`FFmpeg spawn error: ${error.message}`);
              reject(error);
            });
          });
        } catch (error) {
          ongoingCacheGenerations.delete(originalCacheKey);
          throw error;
        }
      } else {
        // Serve existing cached original segment with range support
        logger.info(`Serving existing cached original segment: ${cachedOriginalPath}`);
        return serveVideoWithRange(req, res, cachedOriginalPath);
      }
    }
    
    // For non-range requests, stream directly from FFmpeg
    const mimeType = getMimeType(videoPath);
    const outputFormat = getOutputFormat(videoPath);
    
    const ffmpegArgs = [
      '-ss', start.toString(),
      '-i', videoPath,
      '-t', duration.toString(),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-f', outputFormat
    ];
    
    if (outputFormat === 'mp4') {
      ffmpegArgs.push('-movflags', 'frag_keyframe+empty_moov');
    }
    
    ffmpegArgs.push('pipe:1');
    
    logger.info(`Starting FFmpeg direct stream for ${title}: ${start}s-${end}s (duration: ${duration}s)`);
    logger.debug(`FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);
    
    // Set response headers
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${title}_${start}-${end}.${outputFormat}"`);
    
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let hasStarted = false;
    let stderrData = '';
    
    ffmpeg.stderr.on('data', (data) => {
      stderrData += data.toString();
    });
    
    ffmpeg.stdout.on('data', (chunk) => {
      if (!hasStarted) {
        hasStarted = true;
        if (!res.headersSent) {
          res.writeHead(200);
        }
      }
      if (!res.finished) {
        res.write(chunk);
      }
    });
    
    ffmpeg.on('exit', (code, signal) => {
      if (code === 0) {
        logger.info(`Successfully served original video segment via direct stream: ${title} ${start}s-${end}s`);
      } else if (signal !== 'SIGTERM') {
        logger.error(`FFmpeg exited with code ${code}, signal ${signal}`);
        logger.error(`FFmpeg stderr: ${stderrData}`);
      }
      
      if (!res.finished) {
        res.end();
      }
    });
    
    ffmpeg.on('error', (error) => {
      logger.error(`FFmpeg spawn error: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error processing video segment');
      } else if (!res.finished) {
        res.end();
      }
    });
    
    // Handle client disconnect
    req.on('close', () => {
      if (!ffmpeg.killed && ffmpeg.exitCode === null) {
        try {
          ffmpeg.kill('SIGTERM');
        } catch (error) {
          // Ignore errors
        }
      }
    });
    
    // Timeout after 15 seconds
    const timeout = setTimeout(() => {
      if (!hasStarted && !ffmpeg.killed) {
        logger.error(`FFmpeg timeout for ${title} ${start}s-${end}s`);
        try {
          ffmpeg.kill('SIGTERM');
        } catch (error) {
          // Ignore errors
        }
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Video processing timeout');
        }
      }
    }, 15000);
    
    ffmpeg.on('exit', () => {
      clearTimeout(timeout);
    });
    
  } catch (error) {
    logger.error(`Error in serveOriginalVideoWithRanges: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  }
}

/**
 * Determines the output format based on the input video file extension
 * @param {string} videoPath - Path to the video file
 * @returns {string} Output format for FFmpeg
 */
function getOutputFormat(videoPath) {
  const ext = extname(videoPath).toLowerCase();
  switch (ext) {
    case '.mp4':
    case '.m4v':
      return 'mp4';
    case '.mov':
      return 'mov';
    case '.mkv':
      return 'matroska';
    case '.webm':
      return 'webm';
    case '.avi':
      return 'avi';
    default:
      return 'mp4'; // Default to MP4
  }
}

/**
 * The file extension a muxer produces, i.e. the inverse of getOutputFormat.
 * Used so a cached segment's extension matches the bytes actually written to
 * it — remuxing an .mkv source and naming the result .mp4 produces a file no
 * player can read and a Content-Type that lies about it.
 *
 * @param {string} format - An ffmpeg muxer name from getOutputFormat
 * @returns {string} Extension including the leading dot
 */
function extensionForFormat(format) {
  switch (format) {
    case 'matroska':
      return '.mkv';
    case 'mov':
      return '.mov';
    case 'webm':
      return '.webm';
    case 'avi':
      return '.avi';
    case 'mp4':
    default:
      return '.mp4';
  }
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
      const movieData = await getMovieByName(movieName);
      title = movieData.name;
      if (!movieData) {
        throw new Error(`Movie not found: ${movieName}`);
      }
      videoID = movieData._id;
      const videoRef = await resolveMovieVideo({ basePath, movieName });
      videoPath = videoRef?.path;
    } else if (type === "tv") {
      const { showName, season, episode } = req.params;
      const showData = await getTVShowByName(showName);
      title = showData.name;

      if (!showData) {
        throw new Error(`Show not found: ${showName}`);
      }

      const entry = findEpisodeEntry(showData, season, episode);
      if (!entry) {
        throw new Error(`Episode not found: ${showName} - Season ${season} Episode ${episode}`);
      }

      videoID = entry.episode._id;
      const videoRef = await resolveEpisodeVideo({
        basePath,
        showName,
        season,
        episode,
        preferFilename: entry.episode.filename,
      });
      videoPath = videoRef?.path;
    }

    // Parse and validate start and end parameters
    const start = parseFloat(req.query.start);
    const end = parseFloat(req.query.end);
    const useOriginalVideo = req.query.useOriginalVideo === 'true';
    const MAX_CLIP_DURATION = 600; // 10 minutes

    if (isNaN(start) || isNaN(end) || start < 0 || end <= start) {
      return res.status(400).send('Invalid start or end parameters.');
    }

    if ((end - start) > MAX_CLIP_DURATION) {
      return res.status(400).send(`Clip duration exceeds maximum allowed duration of ${MAX_CLIP_DURATION} seconds.`);
    }

    // Check if video file exists
    if (!await fileExists(videoPath)) {
      return res.status(404).send('Video not found.');
    }

    // If useOriginalVideo is true, serve byte ranges directly from original file
    if (useOriginalVideo) {
      logger.info(`Serving original video with range support for ${title}: ${start}s-${end}s`);
      try {
        return await serveOriginalVideoWithRanges(req, res, videoPath, start, end, title, videoID);
      } catch (error) {
        logger.error(`Error serving original video with ranges: ${error.message}`);
        return res.status(500).send('Error serving original video with ranges.');
      }
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
    const inputPixFmt = videoStream.pix_fmt;
    const isHDR = videoStream.color_transfer?.includes('smpte2084') || 
                  videoStream.color_space?.includes('bt2020');
    // Dolby Vision whose RPU must be applied (Profile 5) reads as neither, and
    // every filter chain renders its base layer green; libplacebo reshapes it
    // (see ffmpeg/dolbyVision.mjs). -show_streams carries the side data.
    const dovi = doviReshapeRequired(videoStream) && await libplaceboAvailable();

    logger.info(`Video analysis: Codec=${sourceCodec}, PixFmt=${inputPixFmt}, HDR=${isHDR}, ` +
               `Profile=${videoStream.profile}, ColorSpace=${videoStream.color_space}, DolbyVisionReshape=${dovi}`);
    
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
          selectedEncoderConfig = libx264;
          selectedEncoder = 'libx264';
          logger.info('Falling back to H.264 encoder (no suitable hardware encoder found)');
      }
    }

    // Create copy and pass pixel format to filter functions
    selectedEncoderConfig = { ...selectedEncoderConfig };
    
    // Update vf function to include inputPixFmt
    const originalVf = selectedEncoderConfig.vf;
    selectedEncoderConfig.vf = (isHDRParam) => originalVf(isHDRParam, inputPixFmt);
    
    if (selectedEncoderConfig.hdr_vf) {
      const originalHdrVf = selectedEncoderConfig.hdr_vf;
      selectedEncoderConfig.hdr_vf = (isHDRParam) => originalHdrVf(isHDRParam, inputPixFmt);
    }

    // Apply HDR processing if needed
    if (isHDR && selectedEncoderConfig.hdr_vf) {
      logger.info('Applying HDR processing');
      selectedEncoderConfig.vf = selectedEncoderConfig.hdr_vf;
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
      await generateAndCacheClip(videoPath, start, end, cachedClipPath, selectedEncoderConfig, isHDR, 'clip', {}, { dovi });
      
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
      // Provide helpful error responses based on error type
      // Use 4xx status codes to avoid Apache error page interception
      let statusCode = 422; // Unprocessable Entity - for processing failures
      let errorMessage = "Failed to generate video clip";
      let details = {};
      
      if (error.message.includes("not found")) {
        statusCode = 404;
        errorMessage = error.message;
        details = {
          suggestion: "Verify the media exists in the library"
        };
      } else if (error.message.includes("Cache generation timeout")) {
        statusCode = 429; // Too Many Requests - server is busy
        errorMessage = "Video clip generation timed out";
        details = {
          suggestion: "The server may be processing other clips. Try again in a few moments",
          clipParameters: { start: req.query.start, end: req.query.end },
          retryAfter: "30 seconds"
        };
      } else if (error.message.includes("FFmpeg")) {
        statusCode = 422; // Unprocessable Entity - can't process this video
        errorMessage = "Video encoding error";
        details = {
          suggestion: "The video file may have encoding issues or unsupported format",
          hint: "Try using ?useOriginalVideo=true to serve without re-encoding"
        };
      }
      
      // Ensure proper Content-Type to prevent Apache interception
      res.setHeader('Content-Type', 'application/json');
      if (statusCode === 429) {
        res.setHeader('Retry-After', '30');
      }
      res.status(statusCode).json({
        error: errorMessage,
        statusCode,
        timestamp: new Date().toISOString(),
        type: type,
        ...(Object.keys(details).length > 0 && { details })
      });
    } else {
      res.end();
    }
  }
}

// One entry per VIDEO_EXTENSIONS member. A missing entry falls through to
// application/octet-stream, which browsers refuse to play — so this table has
// to stay in step with the container list, not lag behind it.
const mimeTypes = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
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
