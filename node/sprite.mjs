import { exec, spawn } from 'child_process';
import { join } from 'path';
import { promises as fs } from 'fs';
import { fileExists, convertToAvif, fileInfo, shouldUseAvif } from './utils/utils.mjs';
import sharp from 'sharp';
import { createCategoryLogger } from './lib/logger.mjs';
import PQueue from 'p-queue';
import { getVideoDuration, isVideoHDR } from './ffmpeg/ffprobe.mjs';
import { getInfo } from './infoManager.mjs';

const logger = createCategoryLogger('sprite');

// Sprite Sheet Generation Version Control (for cache invalidation)
const SPRITE_VERSION = 1.0001;

/**
 * Sanitizes a name for safe filename usage
 * @param {string} name - The name to sanitize
 * @returns {string} - Sanitized name
 */
function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Generates a sprite sheet filename with UUID versioning
 * @param {string} type - 'movies' or 'tv'
 * @param {string} name - Movie name or show name
 * @param {string} season - Season number (for TV)
 * @param {string} episode - Episode identifier (for TV)
 * @param {string} videoUUID - Video UUID (first 8 chars)
 * @param {string} extension - File extension (.avif, .png, .vtt)
 * @returns {string} - Generated filename
 */
function generateSpriteFilename(type, name, season, episode, videoUUID, extension) {
  const sanitizedName = sanitizeName(name);
  const shortUUID = videoUUID.substring(0, 8);
  const version = Math.floor(SPRITE_VERSION * 10000).toString().padStart(4, '0');
  
  if (type === 'movies') {
    return `movie_${sanitizedName}_spritesheet_${shortUUID}_v${version}${extension}`;
  } else {
    const sanitizedSeason = sanitizeName(season);
    const sanitizedEpisode = sanitizeName(episode);
    return `tv_${sanitizedName}_${sanitizedSeason}_${sanitizedEpisode}_spritesheet_${shortUUID}_v${version}${extension}`;
  }
}

/**
 * Finds existing sprite sheet files with different UUIDs for cleanup
 * @param {string} cacheDir - Cache directory
 * @param {string} type - 'movies' or 'tv'
 * @param {string} name - Movie name or show name
 * @param {string} season - Season number (for TV)
 * @param {string} episode - Episode identifier (for TV)
 * @param {string} currentUUID - Current video UUID to exclude
 * @returns {Promise<string[]>} - Array of old files to clean up
 */
async function findOldSpriteFiles(cacheDir, type, name, season, episode, currentUUID) {
  try {
    const files = await fs.readdir(cacheDir);
    const sanitizedName = sanitizeName(name);
    const currentShortUUID = currentUUID.substring(0, 8);
    
    let pattern;
    if (type === 'movies') {
      pattern = new RegExp(`^movie_${sanitizedName}_spritesheet_([a-f0-9]{8})_v\\d{4}\\.(avif|png|vtt)$`);
    } else {
      const sanitizedSeason = sanitizeName(season);
      const sanitizedEpisode = sanitizeName(episode);
      pattern = new RegExp(`^tv_${sanitizedName}_${sanitizedSeason}_${sanitizedEpisode}_spritesheet_([a-f0-9]{8})_v\\d{4}\\.(avif|png|vtt)$`);
    }
    
    return files.filter(file => {
      const match = file.match(pattern);
      return match && match[1] !== currentShortUUID;
    });
  } catch (error) {
    logger.warn(`Error reading cache directory for cleanup: ${error.message}`);
    return [];
  }
}

const FFMPEG_CONCURRENCY = parseInt(process.env.FFMPEG_CONCURRENCY) || 2;

const ffmpegQueue = new PQueue({concurrency: FFMPEG_CONCURRENCY});

/**
 * Optimizes a PNG spritesheet using Sharp with configurable options
 * @param {string} inputPath - Path to the input PNG file
 * @param {string} outputPath - Path for the optimized output PNG
 * @param {Object} options - Optimization options
 * @returns {Promise<void>}
 */
async function optimizePNGSpritesheet(inputPath, outputPath, options = {}) {
  const {
    quality = 65,          // Balanced quality
    compressionLevel = 9,  // Maximum compression
    colors = 256,         // Maximum allowed colors in palette
    dither = 0.9,         // Dithering amount for color reduction
    enableBlur = false,   // Optional blur
    blur = 0.3,          // Minimum valid blur value
    usePalette = true    // Whether to use palette-based optimization
  } = options;

  try {
    logger.info('Starting PNG optimization...');
    logger.info('Input path:' + inputPath);
    logger.info('Output path:' + outputPath);

    const originalStats = await fs.stat(inputPath);
    logger.info(`Original file size: ${(originalStats.size / 1024 / 1024).toFixed(2)}MB`);

    // Create optimization temp path (distinct from input)
    const optimizationTempPath = outputPath.replace('.png', '_optimization.png');

    // Ensure colors is within valid range for palette mode
    const validColors = usePalette ? Math.min(Math.max(2, colors), 256) : undefined;
    
    // Step 1: Initial optimization
    logger.info('Step 1: Initial optimization...');
    let sharpInstance = sharp(inputPath, {
      limitInputPixels: false,
      sequentialRead: true,
    });

    if (enableBlur) {
      sharpInstance = sharpInstance.blur(blur);
    }

    const pngOptions = {
      quality,
      compressionLevel,
      effort: 10,
      adaptiveFiltering: true,
    };

    if (usePalette) {
      pngOptions.palette = true;
      pngOptions.colors = validColors;
      pngOptions.dither = dither;
      logger.info(`Using palette mode with ${validColors} colors and ${dither} dither`);
    } else {
      logger.info('Using standard PNG compression without palette');
    }

    // Single optimization pass to temp file
    await sharpInstance
      .png(pngOptions)
      .toFile(optimizationTempPath);

    // Move optimized file to final destination
    await fs.rename(optimizationTempPath, outputPath);

    // Get final results
    const optimizedStats = await fileInfo(outputPath);
    const savings = ((originalStats.size - optimizedStats.size) / originalStats.size * 100).toFixed(2);

    const metadata = await sharp(outputPath).metadata();

    logger.info(`
PNG optimization results:
------------------------
Original size: ${(originalStats.size / 1024 / 1024).toFixed(2)}MB
Optimized size: ${(optimizedStats.size / 1024 / 1024).toFixed(2)}MB
Size reduction: ${savings}%
Dimensions: ${metadata.width}x${metadata.height}
Color depth: ${metadata.bitDepth}
Channels: ${metadata.channels}
Palette mode: ${usePalette ? 'enabled' : 'disabled'}
Colors: ${usePalette ? validColors : 'full'}
Dither: ${usePalette ? dither : 'n/a'}
Quality: ${quality}
Blur: ${enableBlur ? blur : 'disabled'}
`);

    return {
      originalSize: originalStats.size,
      optimizedSize: optimizedStats.size,
      savings: parseFloat(savings),
      width: metadata.width,
      height: metadata.height,
      usedPalette: usePalette,
      usedColors: validColors
    };

  } catch (error) {
    logger.error('PNG optimization error:' + error);
    if (error.stack) {
      logger.error('Error stack:' + error.stack);
    }
    throw error;
  }
}

export async function generateSpriteSheet({ videoPath, type, name, season, episode, cacheDir, onProgress = async () => {} }) {
  try {
    // Step 1: Get video UUID for filename versioning
    await onProgress(1, "Analyzing video file for versioning");
    const videoInfo = await getInfo(videoPath);
    const videoUUID = videoInfo.uuid;
    
    // Step 2: FFmpeg (generating the raw spritesheet)
    await onProgress(1, "Running FFmpeg to create raw sprite sheet");

    const duration = await getVideoDuration(videoPath);
    const floorDuration = Math.floor(duration);
    const interval = 5; // Interval between frames

    // Calculate dimensions
    const totalFrames = Math.floor(floorDuration / interval) + 1;
    const columns = 10;
    const rows = Math.ceil(totalFrames / columns);
    const thumbHeight = 180; // Each thumbnail is 320x180
    const totalHeight = rows * thumbHeight;
    
    // Determine format based on AVIF configuration and height
    const useAvif = shouldUseAvif(totalHeight);
    logger.info(`Sprite sheet dimensions: ${columns} columns x ${rows} rows = ${totalHeight}px height`);
    logger.info(`Using ${useAvif ? 'AVIF' : 'PNG'} format (AVIF ${shouldUseAvif() ? 'enabled' : 'disabled'} globally)`);

    // Generate UUID-based filenames
    const spriteExtension = useAvif ? '.avif' : '.png';
    const spriteSheetFileName = generateSpriteFilename(type, name, season, episode, videoUUID, spriteExtension);
    const vttFileName = generateSpriteFilename(type, name, season, episode, videoUUID, '.vtt');

    let finalSpriteSheetPath = join(cacheDir, spriteSheetFileName);
    const vttFilePath = join(cacheDir, vttFileName);
    let actualFormat = useAvif ? 'avif' : 'png'; // Track the actual format used

    // Clean up old sprite sheet files with different UUIDs
    const oldFiles = await findOldSpriteFiles(cacheDir, type, name, season, episode, videoUUID);
    for (const oldFile of oldFiles) {
      try {
        await fs.unlink(join(cacheDir, oldFile));
        logger.info(`Cleaned up old sprite file: ${oldFile}`);
      } catch (error) {
        logger.warn(`Failed to clean up old sprite file ${oldFile}: ${error.message}`);
      }
    }

    // Check if we need to generate the spritesheet (UUID-based filename)
    if (!await fileExists(finalSpriteSheetPath)) {
      logger.info(`Generating new sprite sheet with UUID versioning: ${spriteSheetFileName}`);
      
      // Generate initial PNG with FFmpeg (using temporary filename based on UUID)
      const tempFileName = `temp_${generateSpriteFilename(type, name, season, episode, videoUUID, '.png')}`;
      const ffmpegOutputPath = join(cacheDir, tempFileName);
      
      await generateSpriteSheetWithFFmpeg(
        videoPath,
        ffmpegOutputPath,
        interval,
        columns,
        rows,
        'png'
      );

      // Step 2: AVIF conversion or PNG optimization based on configuration
      await onProgress(2, useAvif
        ? "Converting PNG to AVIF"
        : "Optimizing PNG"
      );

      if (useAvif) {
        // Convert to AVIF with queue management
        try {
          await convertToAvif(ffmpegOutputPath, finalSpriteSheetPath, 90, 6, true);
          logger.info(`AVIF conversion completed: ${finalSpriteSheetPath}`);
          actualFormat = 'avif';
        } catch (avifError) {
          logger.error(`AVIF conversion failed, falling back to PNG optimization: ${avifError.message}`);
          // Fallback to PNG optimization - use correct PNG filename with UUID
          const pngFallbackPath = join(cacheDir, generateSpriteFilename(type, name, season, episode, videoUUID, '.png'));
          try {
            await optimizePNGSpritesheet(
              ffmpegOutputPath,
              pngFallbackPath,
              {
                quality: 65,
                compressionLevel: 9,
                colors: 256,
                dither: 0.9,
                usePalette: true
              }
            );
            finalSpriteSheetPath = pngFallbackPath;
            actualFormat = 'png';
            await fs.unlink(ffmpegOutputPath).catch(logger.error);
          } catch (pngError) {
            logger.error('PNG optimization also failed, using unoptimized PNG:' + pngError.message);
            await fs.rename(ffmpegOutputPath, pngFallbackPath);
            finalSpriteSheetPath = pngFallbackPath;
            actualFormat = 'png';
          }
        }
      } else {
        // Optimize PNG when AVIF is disabled or not suitable
        logger.info('Using PNG optimization (AVIF disabled or unsuitable)...');
        try {
          await optimizePNGSpritesheet(
            ffmpegOutputPath,  // Input is FFmpeg output
            finalSpriteSheetPath,  // Output is final destination (UUID-based)
            {
              quality: 65,
              compressionLevel: 9,
              colors: 256,
              dither: 0.9,
              usePalette: true
            }
          );
          // Clean up FFmpeg output after successful optimization
          await fs.unlink(ffmpegOutputPath).catch(logger.error);
          actualFormat = 'png';
        } catch (optimizeError) {
          logger.error('PNG optimization failed, using unoptimized PNG:' + optimizeError.message);
          // If optimization fails, just move the FFmpeg output to final destination
          await fs.rename(ffmpegOutputPath, finalSpriteSheetPath);
          actualFormat = 'png';
        }
      }
    } else {
      logger.info(`Using existing sprite sheet: ${spriteSheetFileName}`);
      // Determine actual format from existing file
      actualFormat = finalSpriteSheetPath.endsWith('.avif') ? 'avif' : 'png';
    }

    // Generate VTT if needed
    if (!await fileExists(vttFilePath)) {
      await onProgress(3, "Generating VTT file");
      await generateVttFileFFmpeg(
        finalSpriteSheetPath,
        vttFilePath,
        floorDuration,
        interval,
        columns,
        rows,
        type,
        name,
        season,
        episode,
      );
    }

    return {
      spriteSheetPath: finalSpriteSheetPath,
      vttFilePath,
      format: actualFormat
    };
  } catch (error) {
    logger.error(`Error in generateSpriteSheet: ${error}`);
    throw error;
  }
}

/**
 * Generates a sprite sheet from a video, handling HDR frames appropriately.
 * @param {string} videoPath - Path to the input video.
 * @param {string} spriteSheetPath - Path where the sprite sheet will be saved.
 * @param {number} interval - Time interval between frames in seconds.
 * @param {number} columns - Number of columns in the sprite sheet.
 * @param {number} rows - Number of rows in the sprite sheet.
 * @param {string} outputFormat - 'avif' or 'png'
 * @param {Object} res - Express response object to serve the PNG immediately.
 * @returns {Promise<void>}
 */
async function generateSpriteSheetWithFFmpeg(
  videoPath,
  spriteSheetPath,
  interval,
  columns,
  rows,
  outputFormat,
  res
) {
  try {
    // Wait until ffmpegQueue is initialized
    while (!ffmpegQueue) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Step 1: Detect if the video is HDR
    const hdr = await isVideoHDR(videoPath);
    logger.info(`Video HDR: ${hdr}`);
    const videoExists = await fileExists(videoPath);

    if (!videoExists) {
      logger.info(`Video file not found in Spritesheet step: ${videoPath}`);
      return;
    }

    // Step 2: Prepare temporary file path for PNG if needed
    let tempSpriteSheetPath = spriteSheetPath.replace(/\.[^/.]+$/, '.png');

    // Step 3: Configure FFmpeg command based on HDR and output format
    let vfFilters;
    if (hdr) {
      // HDR processing with color space conversion and tone mapping
      vfFilters =
        `fps=1/${interval},` +
        `zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc:rangein=limited,` +
        `zscale=transfer=linear:npl=100,` +
        `tonemap=hable,` +
        `zscale=transfer=bt709:primaries=bt709:matrix=bt709:range=limited,` +
        `scale=320:-1,` +
        `tile=${columns}x${rows}`;
    } else {
      // Non-HDR processing
      vfFilters = `fps=1/${interval},` + `scale=320:-1,` + `tile=${columns}x${rows}`;
    }

    // Step 4: Determine output options based on format
    const pixFmtOption = 'rgb24';
    const ffmpegOutputPath = tempSpriteSheetPath;

    // Step 5: Construct the FFmpeg command as an array
    const ffmpegArgs = [
      '-y', // Overwrite output files without asking
      '-loglevel',
      'error',
      '-i',
      videoPath,
      '-vf',
      vfFilters,
      '-pix_fmt',
      pixFmtOption,
      ffmpegOutputPath,
    ];

    logger.info(`Queuing FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

    // Step 6: Add the FFmpeg execution to the queue
    await ffmpegQueue.add(async () => {
      logger.info(`Executing FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

      await new Promise((resolve, reject) => {
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        ffmpegProcess.stdout.on('data', (data) => {
          logger.info(`stdout: ${data}`);
        });

        ffmpegProcess.stderr.on('data', (data) => {
          logger.error(`stderr: ${data}`);
        });

        ffmpegProcess.on('close', (code) => {
          if (code === 0) {
            logger.info(`Sprite sheet execution completed, stored at ${ffmpegOutputPath}`);
            resolve();
          } else {
            reject(new Error(`FFmpeg process exited with code ${code}`));
          }
        });

        ffmpegProcess.on('error', (error) => {
          reject(error);
        });
      });
    });

    // Step 7: Handle post-processing (e.g., conversion to AVIF)
    if (outputFormat === 'avif') {
      try {
        await convertToAvif(ffmpegOutputPath, spriteSheetPath, 60, 4);
        logger.info(`Converted sprite sheet to AVIF at ${spriteSheetPath}`);
      } catch (conversionError) {
        logger.error(`Error converting PNG to AVIF: ${conversionError}`);
        // Optionally implement retry mechanisms or handle the error as needed
        throw conversionError;
      }
    }

    // Optionally, send the response if needed
    if (res) {
      res.sendFile(spriteSheetPath, (err) => {
        if (err) {
          logger.error(`Error sending file: ${err}`);
        }
      });
    }

    logger.info('Sprite sheet generation process completed.');
  } catch (err) {
    logger.error(`Error generating sprite sheet: ${err}`);
    throw err;
  }
}

export async function generateVttFileFFmpeg(spriteSheetPath, vttFilePath, duration, interval, columns, rows, type, name, season = null, episode = null) {
  const vttContent = ['WEBVTT', ''];

  const baseUrl = process.env.FILE_SERVER_NODE_URL;
  let spriteSheetUrl;

  if (type === 'movies') {
    spriteSheetUrl = `${baseUrl}/spritesheet/movie/${encodeURIComponent(name)}`;
  } else if (type === 'tv') {
    spriteSheetUrl = `${baseUrl}/spritesheet/tv/${encodeURIComponent(name)}/${season}/${episode}`;
  }

  if (!await fileExists(spriteSheetPath)) {
    return Promise.reject(new Error(`Sprite sheet not found at: ${spriteSheetPath}`));
  }

  // Get sprite sheet dimensions
  const { width: spriteWidth, height: spriteHeight } = await getImageDimensions(spriteSheetPath);
  const thumbWidth = spriteWidth / columns;
  const thumbHeight = spriteHeight / rows;

  let timestamp = 0;
  let index = 0;

  while (timestamp <= duration) {
    const startTime = formatTime(timestamp);
    const endTime = formatTime(Math.min(timestamp + interval, duration)); // Ensure endTime doesn't exceed duration

    const x = (index % columns) * thumbWidth;
    const y = Math.floor(index / columns) * thumbHeight;

    vttContent.push(`${startTime} --> ${endTime}`);
    vttContent.push(`${spriteSheetUrl}#xywh=${x},${y},${thumbWidth},${thumbHeight}`, '');

    timestamp += interval;
    index++;
  }

  await fs.writeFile(vttFilePath, vttContent.join('\n'));
}

function formatTime(seconds) {
  const date = new Date(seconds * 1000);
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const secs = date.getUTCSeconds().toString().padStart(2, '0');
  const ms = date.getUTCMilliseconds().toString().padStart(3, '0');
  return `${hours}:${minutes}:${secs}.${ms}`;
}

async function getImageDimensions(imagePath) {
  const metadata = await sharp(imagePath, { limitInputPixels: 0, unlimited: true }).metadata();
  return { width: metadata.width, height: metadata.height };
}
