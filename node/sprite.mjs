import { spawn } from 'child_process';
import { join, dirname, basename } from 'path';
import { promises as fs } from 'fs';
import { fileExists, convertToAvif, fileInfo, shouldUseAvif } from './utils/utils.mjs';
import sharp from 'sharp';
import { createCategoryLogger } from './lib/logger.mjs';
import PQueue from 'p-queue';
import { getVideoDuration, isVideoHDR, estimateKeyframeInterval } from './ffmpeg/ffprobe.mjs';
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
      pattern = new RegExp(`^movie_${sanitizedName}_spritesheet_([a-f0-9]{8})_v\\d+\\.(avif|png|vtt)$`);
    } else {
      const sanitizedSeason = sanitizeName(season);
      const sanitizedEpisode = sanitizeName(episode);
      pattern = new RegExp(`^tv_${sanitizedName}_${sanitizedSeason}_${sanitizedEpisode}_spritesheet_([a-f0-9]{8})_v\\d+\\.(avif|png|vtt)$`);
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

// Per-sprite-job frame extraction parallelism. Each extraction is a short-lived
// ffmpeg that seeks and decodes a single GOP, so this multiplies against
// FFMPEG_CONCURRENCY for total concurrent ffmpeg processes.
const SPRITE_FRAME_CONCURRENCY = Math.max(1, parseInt(process.env.SPRITE_FRAME_CONCURRENCY, 10) || 2);
// Optional hardware-accelerated decode for frame extraction, e.g. 'qsv', 'vaapi', 'auto'.
// Falls back to software decode automatically if the first hwaccel attempt fails.
const SPRITE_HWACCEL = (process.env.SPRITE_HWACCEL || '').trim().toLowerCase();
const SPRITE_HWACCEL_DEVICE = (process.env.SPRITE_HWACCEL_DEVICE || '').trim();
// Extraction strategy:
//   auto     - probe the keyframe interval; seek per timestamp when GOPs are
//              short (typical remuxes), fall back to a single linear decode
//              when GOPs are longer than the thumbnail interval (seeking would
//              re-decode overlapping GOPs and cost MORE than one linear pass).
//   accurate - always seek per timestamp, decode to the exact frame.
//   fast     - seek per timestamp with -noaccurate_seek: emits the nearest
//              keyframe at/before each timestamp. Cheapest possible I/O, but
//              thumbnails can land up to a GOP early (and repeat on long-GOP files).
//   linear   - legacy single-pass fps+tile pipeline.
const SPRITE_SEEK_MODE = (process.env.SPRITE_SEEK_MODE || 'auto').trim().toLowerCase();
// In auto mode, seeking pays off when decoding keyframe->timestamp (~half a
// GOP per tile) beats decoding the full interval between tiles linearly.
const AUTO_SEEK_MAX_GOP_FACTOR = 1.5;

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

// Concurrent generations of one title share a run. The VTT and sprite-sheet
// routes dedupe their own requests separately, so a request to each can arrive
// while the other's generation is in flight; two runs would write and consume
// the same temp PNG, and the loser fails at its final rename with ENOENT.
const inFlightGenerations = new Map();

export function generateSpriteSheet(options) {
  const { type, name, season, episode, cacheDir } = options;
  const key = [cacheDir, type, name, season ?? '', episode ?? ''].join('|');
  const inFlight = inFlightGenerations.get(key);
  if (inFlight) {
    logger.info(`Sprite sheet generation already in flight for ${type} ${name}${season ? ` S${season}E${episode}` : ''}; joining it`);
    return inFlight;
  }
  const run = generateSpriteSheetUncoalesced(options).finally(() => {
    inFlightGenerations.delete(key);
  });
  inFlightGenerations.set(key, run);
  return run;
}

/**
 * Last resort after PNG optimization failed: keep ffmpeg's unoptimized output
 * as the final sprite sheet. If that output is already gone, the optimization
 * failure is the real story; a rename would only bury it under ENOENT.
 */
export async function keepUnoptimizedPng(tempPath, finalPath, optimizationError) {
  if (!await fileExists(tempPath)) {
    throw new Error(`Sprite sheet ${basename(tempPath)} is missing after optimization failed: ${optimizationError.message}`);
  }
  await fs.rename(tempPath, finalPath);
}

async function generateSpriteSheetUncoalesced({ videoPath, type, name, season, episode, cacheDir, onProgress = async () => {} }) {
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
            await keepUnoptimizedPng(ffmpegOutputPath, pngFallbackPath, pngError);
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
          await keepUnoptimizedPng(ffmpegOutputPath, finalSpriteSheetPath, optimizeError);
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
 * Plans the frame timestamps for a sprite sheet: one frame every `interval`
 * seconds from 0 through floor(duration), matching the frame count the old
 * fps=1/interval filter produced. Timestamps at/past the true end of the video
 * are pulled back slightly so the seek still lands on a decodable frame.
 * @param {number} duration - Video duration in seconds (float).
 * @param {number} interval - Seconds between frames.
 * @returns {number[]} - Timestamps in seconds, in ascending order.
 */
export function planFrameTimestamps(duration, interval) {
  const floorDuration = Math.floor(duration);
  const timestamps = [];
  for (let t = 0; t <= floorDuration; t += interval) {
    timestamps.push(t >= duration - 0.25 ? Math.max(0, duration - 0.5) : t);
  }
  return timestamps;
}

/**
 * Builds the per-frame video filter chain (no fps/tile — each ffmpeg call
 * extracts exactly one frame and tiling happens in sharp).
 * @param {boolean} hdr - Whether the source is HDR (adds tone mapping).
 * @returns {string} - ffmpeg -vf filter string.
 */
function buildFrameFilters(hdr) {
  if (hdr) {
    return (
      `zscale=transfer=smpte2084:primaries=bt2020:matrix=bt2020nc:rangein=limited,` +
      `zscale=transfer=linear:npl=100,` +
      `tonemap=hable,` +
      `zscale=transfer=bt709:primaries=bt709:matrix=bt709:range=limited,` +
      `scale=320:-1`
    );
  }
  return `scale=320:-1`;
}

/**
 * Runs an ffmpeg process and resolves on exit code 0, rejecting with the
 * captured stderr tail otherwise.
 * @param {string[]} args - ffmpeg arguments.
 * @returns {Promise<void>}
 */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = spawn('ffmpeg', args);
    let stderr = '';

    ffmpegProcess.stderr.on('data', (data) => {
      stderr += data;
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.trim()}`));
      }
    });

    ffmpegProcess.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Builds the ffmpeg args for extracting a single frame at a timestamp using
 * input seeking (-ss before -i), so ffmpeg jumps via the container index and
 * only decodes from the preceding keyframe instead of reading the whole file.
 * @param {string} videoPath - Path to the input video.
 * @param {number} timestamp - Seek target in seconds.
 * @param {string} vfFilters - Per-frame filter chain.
 * @param {string} outputPath - Output PNG path.
 * @param {string|null} hwaccel - Hardware decode method or null for software.
 * @param {boolean} fastSeek - Snap to nearest keyframe (-noaccurate_seek) instead of the exact frame.
 * @param {boolean} hdr - Whether the source is HDR (drives the qsv download pixel format).
 * @returns {string[]} - ffmpeg arguments.
 */
export function buildExtractArgs(videoPath, timestamp, vfFilters, outputPath, hwaccel, fastSeek, hdr) {
  const args = ['-y', '-loglevel', 'error'];
  if (fastSeek) {
    args.push('-noaccurate_seek');
  }
  args.push('-ss', timestamp.toFixed(3));
  if (hwaccel) {
    args.push('-hwaccel', hwaccel);
    if (SPRITE_HWACCEL_DEVICE) {
      args.push('-hwaccel_device', SPRITE_HWACCEL_DEVICE);
    }
    if (hwaccel === 'qsv') {
      // Bare -hwaccel qsv leaves decoded frames in GPU memory (a legacy
      // compat default), which the software scale/zscale filters cannot
      // consume. Request a system-memory download format: 10-bit for HDR so
      // the tonemap chain keeps full depth. Rare SDR 10-bit sources may
      // refuse the nv12 download; the per-frame software fallback covers them.
      args.push('-hwaccel_output_format', hdr ? 'p010le' : 'nv12');
    }
  }
  args.push(
    '-i', videoPath,
    '-an', '-sn', '-dn',
    '-frames:v', '1',
    '-vf', vfFilters,
    outputPath,
  );
  return args;
}

/**
 * Extracts one frame per timestamp via seek-based ffmpeg calls with bounded
 * concurrency. Individual frame failures are tolerated (their tile stays
 * black); hwaccel failures fall back to software decode for the rest of the job.
 * @param {string} videoPath - Path to the input video.
 * @param {number[]} timestamps - Seek targets in seconds.
 * @param {string} vfFilters - Per-frame filter chain.
 * @param {string} framesDir - Directory to write frame PNGs into.
 * @param {boolean} fastSeek - Snap to nearest keyframe instead of decoding to the exact frame.
 * @param {boolean} hdr - Whether the source is HDR.
 * @returns {Promise<(string|null)[]>} - Frame paths by index; null where extraction failed.
 */
async function extractFramesAtTimestamps(videoPath, timestamps, vfFilters, framesDir, fastSeek, hdr) {
  const frameQueue = new PQueue({ concurrency: SPRITE_FRAME_CONCURRENCY });
  let hwaccel = SPRITE_HWACCEL && SPRITE_HWACCEL !== 'none' ? SPRITE_HWACCEL : null;
  let hwaccelWarned = false;
  const framePaths = new Array(timestamps.length).fill(null);
  let completed = 0;
  let failedCount = 0;

  await frameQueue.addAll(timestamps.map((timestamp, index) => async () => {
    const outputPath = join(framesDir, `frame_${String(index).padStart(6, '0')}.png`);
    try {
      try {
        await runFfmpeg(buildExtractArgs(videoPath, timestamp, vfFilters, outputPath, hwaccel, fastSeek, hdr));
      } catch (error) {
        if (hwaccel) {
          if (!hwaccelWarned) {
            hwaccelWarned = true;
            logger.warn(`Hardware decode (${hwaccel}) failed, falling back to software for remaining frames: ${error.message}`);
          }
          hwaccel = null;
          await runFfmpeg(buildExtractArgs(videoPath, timestamp, vfFilters, outputPath, null, fastSeek, hdr));
        } else {
          throw error;
        }
      }
      // ffmpeg can exit 0 without producing a frame when seeking past the last packet
      if (await fileExists(outputPath)) {
        framePaths[index] = outputPath;
      } else {
        failedCount++;
        logger.warn(`No frame produced at ${timestamp}s (index ${index})`);
      }
    } catch (error) {
      failedCount++;
      logger.warn(`Frame extraction failed at ${timestamp}s (index ${index}): ${error.message}`);
    }
    completed++;
    if (completed % 100 === 0 || completed === timestamps.length) {
      logger.info(`Sprite frames extracted: ${completed}/${timestamps.length}${failedCount ? ` (${failedCount} failed)` : ''}`);
    }
  }));

  return framePaths;
}

/**
 * Composites individually extracted frames into a single sprite sheet grid.
 * Missing frames leave their tile black, matching the old tile filter's padding.
 * @param {(string|null)[]} framePaths - Frame PNGs by grid index (null = skip).
 * @param {number} columns - Grid columns.
 * @param {number} rows - Grid rows.
 * @param {string} outputPath - Output PNG path.
 * @returns {Promise<void>}
 */
async function composeSpriteSheet(framePaths, columns, rows, outputPath) {
  const firstFrame = framePaths.find(Boolean);
  if (!firstFrame) {
    throw new Error('All sprite frame extractions failed; cannot compose sprite sheet');
  }

  const { width: thumbWidth, height: thumbHeight } = await sharp(firstFrame).metadata();
  const sheetWidth = columns * thumbWidth;
  const sheetHeight = rows * thumbHeight;
  const rowStride = sheetWidth * 3;
  const canvas = Buffer.alloc(sheetWidth * sheetHeight * 3); // zero-filled = black padding

  for (let index = 0; index < framePaths.length; index++) {
    if (!framePaths[index]) continue;
    let data, info;
    try {
      ({ data, info } = await sharp(framePaths[index])
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }));
    } catch (error) {
      logger.warn(`Skipping unreadable frame ${index}: ${error.message}`);
      continue;
    }

    if (info.width !== thumbWidth || info.height !== thumbHeight || info.channels !== 3) {
      logger.warn(`Skipping frame ${index}: unexpected dimensions ${info.width}x${info.height}x${info.channels}`);
      continue;
    }

    const col = index % columns;
    const row = Math.floor(index / columns);
    for (let y = 0; y < thumbHeight; y++) {
      const src = y * thumbWidth * 3;
      const dst = (row * thumbHeight + y) * rowStride + col * thumbWidth * 3;
      data.copy(canvas, dst, src, src + thumbWidth * 3);
    }
  }

  await sharp(canvas, {
    raw: { width: sheetWidth, height: sheetHeight, channels: 3 },
    limitInputPixels: false,
  })
    .png()
    .toFile(outputPath);

  logger.info(`Composed sprite sheet ${sheetWidth}x${sheetHeight} (${framePaths.length} tiles) at ${outputPath}`);
}

/**
 * Runs the legacy single-pass extraction: one linear decode of the whole file
 * with fps + tile filters. Optimal when GOPs are long relative to the
 * thumbnail interval (seeking would re-decode overlapping GOPs).
 * @param {string} videoPath - Path to the input video.
 * @param {string} outputPath - Output PNG path.
 * @param {number} interval - Seconds between frames.
 * @param {number} columns - Grid columns.
 * @param {number} rows - Grid rows.
 * @param {boolean} hdr - Whether the source is HDR.
 * @returns {Promise<void>}
 */
async function runLinearSpriteExtraction(videoPath, outputPath, interval, columns, rows, hdr) {
  const vfFilters = `fps=1/${interval},${buildFrameFilters(hdr)},tile=${columns}x${rows}`;
  const ffmpegArgs = [
    '-y',
    '-loglevel', 'error',
    '-i', videoPath,
    '-an', '-sn', '-dn',
    '-vf', vfFilters,
    '-pix_fmt', 'rgb24',
    outputPath,
  ];
  logger.info(`Executing linear sprite extraction: ffmpeg ${ffmpegArgs.join(' ')}`);
  await runFfmpeg(ffmpegArgs);
}

/**
 * Resolves which extraction strategy to use based on SPRITE_SEEK_MODE and,
 * in auto mode, the video's estimated keyframe interval.
 * @param {string} videoPath - Path to the input video.
 * @param {number} interval - Seconds between thumbnail frames.
 * @param {number} duration - Video duration in seconds.
 * @returns {Promise<{seek: boolean, fastSeek: boolean, reason: string}>}
 */
async function resolveExtractionStrategy(videoPath, interval, duration) {
  switch (SPRITE_SEEK_MODE) {
    case 'linear':
      return { seek: false, fastSeek: false, reason: 'SPRITE_SEEK_MODE=linear' };
    case 'accurate':
      return { seek: true, fastSeek: false, reason: 'SPRITE_SEEK_MODE=accurate' };
    case 'fast':
      return { seek: true, fastSeek: true, reason: 'SPRITE_SEEK_MODE=fast' };
    default: {
      const threshold = interval * AUTO_SEEK_MAX_GOP_FACTOR;
      const gop = await estimateKeyframeInterval(videoPath, {
        sampleAt: Math.max(0, Math.min(60, Math.floor(duration / 2))),
        windowSeconds: Math.ceil(threshold * 2),
      });
      if (gop === null) {
        return { seek: true, fastSeek: false, reason: 'auto (keyframe interval unknown, assuming short GOPs)' };
      }
      const seek = gop <= threshold;
      return {
        seek,
        fastSeek: false,
        reason: `auto (keyframe interval ~${Number.isFinite(gop) ? gop.toFixed(2) : '>' + Math.ceil(threshold * 2)}s vs ${interval}s tile interval)`,
      };
    }
  }
}

/**
 * Generates a sprite sheet from a video, handling HDR frames appropriately.
 * Instead of decoding the entire video linearly (fps + tile filters), this
 * seeks to each thumbnail timestamp and decodes a single frame — on large
 * remuxes that turns a full-file sequential read into a few hundred small
 * reads around each keyframe. Long-GOP sources automatically fall back to the
 * linear pipeline, where a single pass is cheaper than overlapping seeks.
 * @param {string} videoPath - Path to the input video.
 * @param {string} spriteSheetPath - Path where the sprite sheet will be saved.
 * @param {number} interval - Time interval between frames in seconds.
 * @param {number} columns - Number of columns in the sprite sheet.
 * @param {number} rows - Number of rows in the sprite sheet.
 * @param {string} outputFormat - 'avif' or 'png'
 * @returns {Promise<void>}
 */
export async function generateSpriteSheetWithFFmpeg(
  videoPath,
  spriteSheetPath,
  interval,
  columns,
  rows,
  outputFormat
) {
  try {
    if (!await fileExists(videoPath)) {
      // Returning quietly here left the caller to fail later on a PNG that
      // was never written, with an error naming the wrong step.
      throw new Error(`Video file not found in Spritesheet step: ${videoPath}`);
    }

    const hdr = await isVideoHDR(videoPath);
    logger.info(`Video HDR: ${hdr}`);

    const duration = await getVideoDuration(videoPath);
    const strategy = await resolveExtractionStrategy(videoPath, interval, duration);
    const tempSpriteSheetPath = spriteSheetPath.replace(/\.[^/.]+$/, '.png');

    logger.info(`Sprite extraction strategy: ${strategy.seek ? (strategy.fastSeek ? 'fast-seek' : 'seek') : 'linear'} — ${strategy.reason}${SPRITE_HWACCEL ? ` (hwaccel: ${SPRITE_HWACCEL})` : ''}`);

    // The whole job occupies one ffmpegQueue slot so the global cap on
    // concurrent sprite work still holds; frame-level parallelism inside the
    // job is governed by SPRITE_FRAME_CONCURRENCY.
    await ffmpegQueue.add(async () => {
      if (!strategy.seek) {
        await runLinearSpriteExtraction(videoPath, tempSpriteSheetPath, interval, columns, rows, hdr);
        return;
      }
      const timestamps = planFrameTimestamps(duration, interval);
      const vfFilters = buildFrameFilters(hdr);
      const framesDir = await fs.mkdtemp(join(dirname(spriteSheetPath), 'sprite_frames_'));
      try {
        const framePaths = await extractFramesAtTimestamps(videoPath, timestamps, vfFilters, framesDir, strategy.fastSeek, hdr);
        await composeSpriteSheet(framePaths, columns, rows, tempSpriteSheetPath);
      } finally {
        await fs.rm(framesDir, { recursive: true, force: true }).catch((error) => {
          logger.warn(`Failed to clean up sprite frames dir ${framesDir}: ${error.message}`);
        });
      }
    });

    if (!await fileExists(tempSpriteSheetPath)) {
      throw new Error(`Sprite extraction produced no output at ${tempSpriteSheetPath}`);
    }

    if (outputFormat === 'avif') {
      try {
        await convertToAvif(tempSpriteSheetPath, spriteSheetPath, 60, 4);
        logger.info(`Converted sprite sheet to AVIF at ${spriteSheetPath}`);
      } catch (conversionError) {
        logger.error(`Error converting PNG to AVIF: ${conversionError}`);
        throw conversionError;
      }
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
