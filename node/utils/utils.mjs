import { promisify } from 'util';
import { exec, spawn } from 'child_process';
export const execAsync = promisify(exec);
import { promises as fs, stat } from 'fs'; // Use the promise-based version of fs
import { resolve as _resolve, join, relative, sep, dirname } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const scriptsDir = dirname(__filename) + '/../../scripts/utils';
const blurhashCli = join(scriptsDir, 'blurhash_cli.py');
import { createHash } from 'crypto';
import { createCategoryLogger } from '../lib/logger.mjs';
const logger = createCategoryLogger('utility');
//const LOG_FILE = process.env.LOG_PATH ? join(process.env.LOG_PATH, 'blurhash.log') : '/var/log/blurhash.log';

/**
 * Promisified version of the `fs.stat` function, which retrieves information about a file.
 * This exported constant can be used to asynchronously get file metadata, such as size, creation/modification times, and file type.
 */
export const fileInfo = promisify(stat);

// Define the main cache directory
export const mainCacheDir = join(dirname(dirname(__filename)), 'cache');

// Define subdirectories for different cache types
export const generalCacheDir = join(mainCacheDir, 'general');
export const spritesheetCacheDir = join(mainCacheDir, 'spritesheet');
export const framesCacheDir = join(mainCacheDir, 'frames');
export const videoClipsCacheDir = join(mainCacheDir, 'video_clips');
export const videoTranscodeCacheDir = join(mainCacheDir, 'video_transcode');

// Map to track ongoing conversions: key = pngPath, value = Promise
const conversionQueue = new Map();

// PREFIX_PATH is used to prefix the URL path for the server. Useful for reverse proxies.
const PREFIX_PATH = process.env.PREFIX_PATH || '';

let limit;

async function loadPLimit() {
  const pLimit = (await import('p-limit')).default;
  limit = pLimit(10);
}

async function _generateFrame(videoPath, timestamp, framePath) {
  // Ensure the limit function is loaded before using it
  if (!limit) {
    await loadPLimit();
  }

  return limit(() => new Promise((resolve, reject) => {
    // Replace colons in timestamp to make it Windows-friendly
    const sanitizedTimestamp = timestamp.replace(/:/g, '-');

    // Update framePath with sanitized timestamp and .avif extension
    const avifPath = framePath.replace(/\.[^/.]+$/, `.avif`);

    // Determine if the video is HDR by probing color_transfer
    const ffprobeCommand = `ffprobe -v error -select_streams v:0 -show_entries stream=color_transfer -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;

    exec(ffprobeCommand, (error, stdout, stderr) => {
      if (error) {
        logger.error(`Worker ${process.pid} error detecting HDR: ${error.message}`);
        return reject(error);
      }

      const colorTransfer = stdout.trim();
      logger.info(`Worker ${process.pid} color_transfer: ${colorTransfer}`);
      const isHDR = (colorTransfer === 'smpte2084' || colorTransfer === 'arib-std-b67');

      // Build the FFmpeg command for AVIF encoding
      let ffmpegCommand;
      if (isHDR) {
        logger.info(`Worker ${process.pid} detected HDR video, preserving HDR in AVIF`);

        // For HDR:
        // - Ensure even width with scale=-2:140
        // - Use yuv420p10le pixel format
        // - Set HDR metadata: BT.2020 primaries, SMPTE2084 transfer, BT.2020 non-constant colorspace
        // - Use libaom-av1 encoder with high quality settings
        ffmpegCommand = [
          'ffmpeg',
          `-ss ${timestamp}`,
          `-i "${videoPath}"`,
          '-frames:v 1',
          '-vf "scale=-2:140:flags=lanczos,format=yuv420p10le"',
          '-color_primaries bt2020',
          '-color_trc smpte2084',
          '-colorspace bt2020nc',
          '-c:v libaom-av1',
          '-crf 10',
          '-b:v 0',
          '-preset slower',
          `"${avifPath}"`,
          '-y'
        ].join(' ');
      } else {
        logger.info(`Worker ${process.pid} detected SDR video, encoding AVIF in SDR`);

        // For SDR:
        // - Ensure even width with scale=-2:140
        // - Use yuv420p pixel format
        // - No HDR metadata needed
        ffmpegCommand = [
          'ffmpeg',
          `-ss ${timestamp}`,
          `-i "${videoPath}"`,
          '-frames:v 1',
          '-vf "scale=-2:140:flags=lanczos,format=yuv420p"',
          '-c:v libaom-av1',
          '-crf 10',
          '-b:v 0',
          '-preset slower',
          `"${avifPath}"`,
          '-y'
        ].join(' ');
      }

      // Execute the FFmpeg command to produce the AVIF
      exec(ffmpegCommand, (error, stdout, stderr) => {
        if (error) {
          logger.error(`Worker ${process.pid} error generating AVIF at ${timestamp}: ${error.message}`);
          logger.debug(`FFmpeg stderr: ${stderr}`);
          return reject(error);
        }

        logger.info(`Worker ${process.pid} AVIF frame generated successfully: ${avifPath}`);

        // Get the dimensions of the generated AVIF using ffprobe
        const ffprobeDimCommand = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${avifPath}"`;

        exec(ffprobeDimCommand, (error, stdout, stderr) => {
          if (error) {
            logger.error(`Worker ${process.pid} error getting AVIF frame dimensions: ${error.message}`);
            logger.debug(`FFprobe stderr: ${stderr}`);
            return reject(error);
          }

          const [width, height] = stdout.trim().split('x');
          resolve({ framePath: avifPath, width: parseInt(width), height: parseInt(height) });
        });
      });
    });
  }));
}

// Function to check file existence asynchronously
export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true; // The file exists
  } catch (error) {
    return false; // The file does not exist
  }
}

// Ensure cache directory exists
export async function ensureCacheDirs() {
  try {
    await fs.mkdir(mainCacheDir, { recursive: true });
    await fs.mkdir(generalCacheDir, { recursive: true });
    await fs.mkdir(spritesheetCacheDir, { recursive: true });
    await fs.mkdir(framesCacheDir, { recursive: true });
    await fs.mkdir(videoClipsCacheDir, { recursive: true });
    await fs.mkdir(videoTranscodeCacheDir, { recursive: true });
    //logger.info(`Cache directories are ready.`);
  } catch (error) {
    logger.error(`Error creating cache directories: ${error.message}`);
    throw error;
  }
}

// Generate a unique cache key based on input parameters
export function generateCacheKey(...args) {
  const hash = createHash('sha1');
  hash.update(args.join('-'));
  return hash.digest('hex');
}

/**
 * Generates the cached transcoded file based on the cache key and desired extension.
 * @param {string} cacheKey - Unique key for the cached clip.
 * @param {string} [extension='.mp4'] - Desired file extension (e.g., '.webm', '.mp4').
 * @returns {string} - Full path to the cached clip.
 */
export function getCachedTranscodedPath(cacheKey, extension = '.mp4') {
  return join(videoTranscodeCacheDir, `${cacheKey}${extension}`);
}

/**
 * Generates the cached clip path based on the cache key and desired extension.
 * @param {string} cacheKey - Unique key for the cached clip.
 * @param {string} [extension='.mp4'] - Desired file extension (e.g., '.webm', '.mp4').
 * @returns {string} - Full path to the cached clip.
 */
export function getCachedClipPath(cacheKey, extension = '.mp4') {
  return join(videoClipsCacheDir, `${cacheKey}${extension}`);
}

// Set to track ongoing cache generations
export const ongoingCacheGenerations = new Set();

// Cleanup cache files based on their cache type
/**
 * Clears expired files from the General Cache.
 * Max Age: 30 days
 */
export async function clearGeneralCache() {
  const now = Date.now();
  const cacheType = 'general';
  const maxAge = 30 * 24 * 60 * 60; // 30 days in seconds
  const dir = generalCacheDir;

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const stats = await fs.stat(filePath);
        const age = (now - stats.mtimeMs) / 1000; // Age in seconds
        if (age > maxAge) {
          await fs.unlink(filePath);
          logger.info(`Deleted expired cache file (${cacheType}): ${file}`);
        }
      } catch (err) {
        logger.error(`Error processing file ${file} in ${cacheType} cache:`, err);
      }
    }
  } catch (err) {
    logger.error(`Error reading ${cacheType} cache directory:`, err);
  }
}

/**
 * Clears expired files from the Video Clips Cache.
 * Max Age: 1 month
 */
export async function clearVideoClipsCache() {
  const now = Date.now();
  const cacheType = 'video_clips';
  const maxAge = 30 * 24 * 60 * 60; // 1 month in seconds
  const dir = videoClipsCacheDir;

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const stats = await fs.stat(filePath);
        const age = (now - stats.mtimeMs) / 1000; // Age in seconds
        if (age > maxAge) {
          await fs.unlink(filePath);
          logger.info(`Deleted expired cache file (${cacheType}): ${file}`);
        }
      } catch (err) {
        logger.error(`Error processing file ${file} in ${cacheType} cache:`, err);
      }
    }
  } catch (err) {
    logger.error(`Error reading ${cacheType} cache directory:`, err);
  }
}
/**
 * Clears expired files from the Spritesheet Cache.
 * Adjust the maxAge as per your requirement.
 */
export async function clearSpritesheetCache() {
  const now = Date.now();
  const cacheType = 'spritesheet';
  const maxAge = 240 * 24 * 60 * 60; // 8 months in seconds
  const dir = spritesheetCacheDir;

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const stats = await fs.stat(filePath);
        const lastAccessTime = stats.atimeMs;
        const timeSinceLastAccess = (now - lastAccessTime) / 1000; // Time since last access in seconds
        if (timeSinceLastAccess > maxAge) {
          await fs.unlink(filePath);
          logger.info(`Deleted expired cache file (${cacheType}): ${file}`);
        }
      } catch (err) {
        logger.error(`Error processing file ${file} in ${cacheType} cache:`, err);
      }
    }
  } catch (err) {
    logger.error(`Error reading ${cacheType} cache directory:`, err);
  }
}
/**
 * Clears expired files from the Frames Cache.
 * Adjust the maxAge as per your requirement.
 */
export async function clearFramesCache() {
  const now = Date.now();
  const cacheType = 'frames';
  const maxAge = 7 * 24 * 60 * 60; // Example: 7 days in seconds
  const dir = framesCacheDir;

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const stats = await fs.stat(filePath);
        const lastAccessTime = stats.atimeMs;
        const timeSinceLastAccess = (now - lastAccessTime) / 1000; // Time since last access in seconds
        if (timeSinceLastAccess > maxAge) {
          await fs.unlink(filePath);
          logger.info(`Deleted expired cache file (${cacheType}): ${file}`);
        }
      } catch (err) {
        logger.error(`Error processing file ${file} in ${cacheType} cache:`, err);
      }
    }
  } catch (err) {
    logger.error(`Error reading ${cacheType} cache directory:`, err);
  }
}

//
// Function to find an MP4 file in a directory, optionally looking for a specific file
export async function findMp4File(directory, specificFileName = null, extraData = false) {
  try {
    const files = await fs.readdir(directory);
    let targetFile;

    // If specificFileName is provided, try to find it
    if (specificFileName) {
      targetFile = files.find((file) => file === specificFileName);
      if (targetFile) {
        return join(directory, targetFile);
      }
      // If the specific file is not found, you can either throw an error or fall back to finding any MP4 file
      logger.info(
        `Specific file ${specificFileName} not found, looking for any .mp4 file.`, directory, extraData
      );
    }

    // If specificFileName is not provided or specific file not found, find the first .mp4 file
    const mp4Files = files.filter((file) => file.endsWith(".mp4"));
    if (mp4Files.length === 0) {
      throw new Error("No MP4 file found in the directory");
    }
    return join(directory, mp4Files[0]);
  } catch (error) {
    logger.error(error.message);
    throw error; // Rethrow the error to be handled by the caller
  }
}

/**
 * Retrieves the filename for a given show, season, and episode.
 * @param {Object} showData - The show data object.
 * @param {string} season - The season number.
 * @param {string} episode - The episode number.
 * @returns {string} - The filename of the episode.
 * @throws Will throw an error if the show, season, or episode is not found.
 */
export function getEpisodeFilename(showData, season, episode) {
  const _season = showData.seasons[`Season ${season}`];
  if (!_season) {
    throw new Error(`Season not found: ${showData.name} - Season ${season}`);
  }

  const seasonNumber = season.toString().padStart(2, "0");
  const episodeNumber = episode.toString().padStart(2, "0");

  const _episodeKey = Object.keys(_season.episodes).find((e) => {
    // Standard S01E01 format
    const standardMatch = e.match(/S(\d{2})E(\d{2})/i);
    if (standardMatch) {
      return (
        standardMatch[1] === seasonNumber &&
        standardMatch[2] === episodeNumber
      );
    }

    // Alternate "01 - Episode Name.mp4" format
    const alternateMatch = e.match(/^(\d{2})\s*-/);
    if (alternateMatch) {
      return alternateMatch[1] === episodeNumber;
    }

    // Legacy formats
    return (
      e.includes(` - `) &&
      (e.startsWith(episodeNumber) || e.includes(` ${episodeNumber} - `))
    );
  });

  if (_episodeKey) {
    return _season.episodes[_episodeKey].filename;
  } else {
    throw new Error(
      `Episode not found: ${showData.name} - Season ${season} Episode ${episode}`
    );
  }
}

export function getEpisodeKey(showData, season, episode) {
  const _season = showData.seasons[`Season ${season}`];
  if (!_season) {
    throw new Error(`Season not found: ${showData.name} - Season ${season}`);
  }

  return Object.keys(_season.episodes).find((e) => {
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
}

export async function getStoredBlurhash(imagePath, basePath) {
  // Ensure imagePath is a string to prevent errors
  if (!imagePath || typeof imagePath !== 'string') {
    logger.error(`Invalid image path: ${imagePath}`);
    return null;
  }

  const blurhashFile = `${imagePath}.blurhash`;
  
  // Calculate relative path and URL for the blurhash file
  const relativePath = relative(basePath, blurhashFile);
  const urlFriendlyPath = relativePath.split(sep).join('/');
  const encodedRelativePath = urlFriendlyPath.split('/').map(encodeURIComponent).join('/');
  const relativeUrl = `${PREFIX_PATH}/${encodedRelativePath}`;

  // If blurhash file already exists, just return the URL
  if (await fileExists(blurhashFile)) {
    return relativeUrl;
  }

  // Determine if debug mode is enabled
  const isDebugMode = process.env.DEBUG && process.env.DEBUG.toLowerCase() === 'true';
  const debugMessage = isDebugMode ? ' [Debugging Enabled]' : '';
  logger.info(`Running blurhash_cli.py job for ${imagePath}${debugMessage}`);

  // Construct the command in a cross-platform way
  const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';
  
  try {
    // Directly use the file path passed to the function without URL manipulations
    // This ensures we're using actual filesystem paths and not URL-encoded paths
    const cleanedPath = imagePath.replace(/"/g, '\\"');
    
    // Execute the command with properly escaped paths
    // We use execFile where possible to avoid shell interpretation of special characters
    logger.debug(`Attempting to generate blurhash for: ${cleanedPath}`);
    const cmd = `${pythonExecutable} ${blurhashCli} "${cleanedPath}"`;
    const blurhashOutput = await execAsync(cmd);
    
    if (blurhashOutput.stderr) {
      logger.error(`Error generating blurhash: ${blurhashOutput.stderr}`);
      return null;
    }

    // Write the generated blurhash to a file
    await fs.writeFile(blurhashFile, blurhashOutput.stdout.trim());
    logger.debug(`Successfully generated blurhash for: ${cleanedPath}`);
    return relativeUrl;
  } catch (error) {
    logger.error(`Error executing blurhash_cli.py for ${imagePath}: ${error}`);
    return null;
  }
}
export async function calculateDirectoryHash(dirPath, maxDepth = 5) {
  const hash = createHash('sha256');

  async function processDirectory(currentPath, currentDepth) {
    if (currentDepth > maxDepth) return;

    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      const stats = await fs.stat(fullPath);

      if (entry.isDirectory()) {
        // Add directory name and stats to the hash
        hash.update(`D:${entry.name}:${stats.size}:${stats.mtimeMs}`);
        // Recursively process subdirectory
        await processDirectory(fullPath, currentDepth + 1);
      } else if (entry.isFile()) {
        // Add file name and stats to the hash
        hash.update(`F:${entry.name}:${stats.size}:${stats.mtimeMs}`);
      }
    }
  }

  await processDirectory(dirPath, 0);
  return hash.digest('hex');
}

export async function getLastModifiedTime(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtime; // Modification time
  } catch {
    return null;
  }
}

/**
 * Converts a PNG file to AVIF using avifenc with a per-file queue to prevent duplicate conversions.
 *
 * @param {string} pngPath - The file path of the input PNG image.
 * @param {string} avifPath - The desired file path for the output AVIF image.
 * @param {number} quality - The quality setting for AVIF encoding (0-100).
 * @param {number} speed - The speed setting for AVIF encoding (0-10).
 * @param {boolean} deleteOriginal - Whether to delete the original PNG after successful conversion.
 * @returns {Promise<void>}
 */
export async function convertToAvif(pngPath, avifPath, quality = 60, speed = 4, deleteOriginal = true) {
  logger.info('Request to convert PNG to AVIF:' + pngPath);

  // If a conversion for this pngPath is already in progress, return the existing Promise
  if (conversionQueue.has(pngPath)) {
    logger.info('Conversion already in progress for:' + pngPath);
    return conversionQueue.get(pngPath);
  }

  // Create a new Promise for the conversion process
  const conversionPromise = new Promise((resolve, reject) => {
    logger.info('Starting new conversion for:' + pngPath);

    const args = [
      '--min', '0',
      '--max', quality,
      '-s', speed,
      pngPath,
      avifPath
    ];

    // Spawn the avifenc process
    const avifencProcess = spawn('avifenc', args, {
      stdio: ['ignore', 'pipe', 'pipe'] // Ignore stdin, capture stdout and stderr
    });

    // Collect stdout data
    avifencProcess.stdout.on('data', (data) => {
      logger.info(`avifenc stdout: ${data}`);
    });

    // Collect stderr data
    avifencProcess.stderr.on('data', (data) => {
      logger.error(`avifenc stderr: ${data}`);
    });

    // Handle process exit
    avifencProcess.on('close', async (code) => {
      if (code === 0) {
        logger.info(`avifenc completed successfully for: ${pngPath}`);
        
        // If deletion is enabled, attempt to delete the original PNG
        if (deleteOriginal) {
          try {
            await fs.unlink(pngPath);
            logger.info(`Deleted original PNG file: ${pngPath}`);
          } catch (unlinkError) {
            logger.error(`Failed to delete original PNG file (${pngPath}): ${unlinkError}`);
            // Depending on requirements, you might choose to reject here
            // For now, we'll resolve even if deletion fails
          }
        }

        resolve();
      } else {
        const errorMsg = `avifenc exited with code ${code} for: ${pngPath}`;
        logger.error(errorMsg);
        reject(new Error(errorMsg));
      }
    });

    // Handle process errors
    avifencProcess.on('error', (err) => {
      const errorMsg = `Failed to start avifenc for: ${pngPath} - ${err.message}`;
      logger.error(errorMsg);
      reject(new Error(errorMsg));
    });
  });

  // Store the Promise in the conversionQueue Map
  conversionQueue.set(pngPath, conversionPromise);

  try {
    // Await the conversion Promise
    await conversionPromise;
  } catch (error) {
    // On error, remove the entry from the Map and propagate the error
    conversionQueue.delete(pngPath);
    throw error;
  }

  // After successful conversion, remove the entry from the Map
  conversionQueue.delete(pngPath);
}

/**
 * Generates a frame from a video file at the specified timestamp and saves it to the given path.
 * 
 * @param {string} videoPath - The path to the video file.
 * @param {number} timestamp - The timestamp (in milliseconds) at which to capture the frame.
 * @param {string} framePath - The path to save the generated frame.
 * @returns {Promise<void>} - A Promise that resolves when the frame has been generated and saved.
 */
export const generateFrame = async (videoPath, timestamp, framePath) => {
  await loadPLimit();
  return _generateFrame(videoPath, timestamp, framePath);
};

/**
 * Helper to see if an array of arguments includes a certain argument key (e.g. "-vf").
 * Simple utility so we don’t double-add the same flag.
 */
export function stringArrayContainsArg(argsArray, argKey) {
  // e.g. argKey = "-vf" or "-ac"
  return argsArray.some((item) => item.trim().toLowerCase() === argKey);
}
