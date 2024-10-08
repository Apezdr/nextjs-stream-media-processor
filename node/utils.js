const util = require('util');
const { exec } = require('child_process');
const execAsync = util.promisify(exec);
const fs = require('fs').promises; // Use the promise-based version of fs
const path = require('path');
const scriptsDir = path.resolve(__dirname, '../scripts/utils');
const blurhashCli = path.join(scriptsDir, 'blurhash_cli.py');
const crypto = require('crypto');
const LOG_FILE = '/var/log/blurhash.log';

// Define the main cache directory
const mainCacheDir = path.join(__dirname, 'cache');

// Define subdirectories for different cache types
const generalCacheDir = path.join(mainCacheDir, 'general');
const spritesheetCacheDir = path.join(mainCacheDir, 'spritesheet');
const framesCacheDir = path.join(mainCacheDir, 'frames');
const videoClipsCacheDir = path.join(mainCacheDir, 'video_clips');

// PREFIX_PATH is used to prefix the URL path for the server. Useful for reverse proxies.
const PREFIX_PATH = process.env.PREFIX_PATH || '';

let limit;

async function loadPLimit() {
  const pLimit = (await import('p-limit')).default;
  limit = pLimit(10);
}

async function generateFrame(videoPath, timestamp, framePath) {
  // Ensure the limit function is loaded before using it
  if (!limit) {
    await loadPLimit();
  }

  // Use the limit to control concurrency
  return limit(() => new Promise((resolve, reject) => {
    // First, detect if the video is HDR
    const ffprobeCommand = `ffprobe -v error -select_streams v:0 -show_entries stream=color_transfer -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
    exec(ffprobeCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`Worker ${process.pid} error detecting HDR: ${error.message}`);
        reject(error);
      } else {
        const colorTransfer = stdout.trim();
        console.log(`Worker ${process.pid} color_transfer: ${colorTransfer}`);
        // Determine if the video is HDR
        const isHDR = (colorTransfer === 'smpte2084' || colorTransfer === 'arib-std-b67');
        // Ensure the framePath has a .avif extension
        framePath = framePath.replace(/\.[^/.]+$/, '.avif');
        // Build the ffmpeg command accordingly
        let ffmpegCommand;
        if (isHDR) {
          console.log(`Worker ${process.pid} detected HDR video`);
          // For HDR video, output 16-bit PNG with appropriate pixel format
          ffmpegCommand = `ffmpeg -ss ${timestamp} -i "${videoPath}" -frames:v 1 -vf "scale=-1:140" -pix_fmt rgb48le "${framePath}" -y`;
        } else {
          console.log(`Worker ${process.pid} detected SDR video`);
          // For SDR video, output standard 8-bit PNG
          ffmpegCommand = `ffmpeg -ss ${timestamp} -i "${videoPath}" -frames:v 1 -vf "scale=-1:140" -pix_fmt rgb24 "${framePath}" -y`;
        }
        // Now execute the ffmpeg command
        exec(ffmpegCommand, (error) => {
          if (error) {
            console.error(`Worker ${process.pid} error generating frame at ${timestamp}: ${error.message}`);
            reject(error);
          } else {
            console.log(`Worker ${process.pid} frame generated successfully: ${framePath}`);
            // Get the dimensions of the generated frame using ffprobe
            const ffprobeCommand = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${framePath}"`;
            exec(ffprobeCommand, (error, stdout, stderr) => {
              if (error) {
                console.error(`Worker ${process.pid} error getting frame dimensions: ${error.message}`);
                reject(error);
              } else {
                const [width, height] = stdout.trim().split('x');
                resolve({ framePath, width: parseInt(width), height: parseInt(height) });
              }
            });
          }
        });
      }
    });
  }));
}

function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const ffprobeCommand = `ffprobe -v error -select_streams v:0 -show_entries stream=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
    exec(ffprobeCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error getting video duration: ${error.message}`);
        reject(error);
      } else {
        const duration = parseFloat(stdout.trim());
        if (!isNaN(duration)) {
          resolve(duration);
        } else {
          reject(new Error('Failed to parse video duration.'));
        }
      }
    });
  });
}

// Function to check file existence asynchronously
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true; // The file exists
  } catch (error) {
    return false; // The file does not exist
  }
}

// Ensure cache directory exists
async function ensureCacheDirs() {
  try {
    await fs.mkdir(mainCacheDir, { recursive: true });
    await fs.mkdir(generalCacheDir, { recursive: true });
    await fs.mkdir(videoClipsCacheDir, { recursive: true });
    await fs.mkdir(spritesheetCacheDir, { recursive: true });
    await fs.mkdir(framesCacheDir, { recursive: true });
    console.log(`Cache directories are ready.`);
  } catch (error) {
    console.error(`Error creating cache directories: ${error.message}`);
    throw error;
  }
}

// Generate a unique cache key based on input parameters
function generateCacheKey(...args) {
  const hash = crypto.createHash('sha1');
  hash.update(args.join('-'));
  return hash.digest('hex');
}

// Get the cached clip path based on the cache key
function getCachedClipPath(cacheKey) {
  return path.join(videoClipsCacheDir, `${cacheKey}.mp4`);
}

// Check if a cached clip exists and is still valid (within 5 minutes)
async function isCacheValid(cachedClipPath) {
  try {
    const stats = await fs.stat(cachedClipPath);
    const now = Date.now();
    const fileAge = (now - stats.mtimeMs) / 1000; // Age in seconds
    return fileAge < 300; // 300 seconds = 5 minutes
  } catch (error) {
    return false;
  }
}

// Set to track ongoing cache generations
const ongoingCacheGenerations = new Set();

// Cleanup cache files based on their cache type
/**
 * Clears expired files from the General Cache.
 * Max Age: 30 days
 */
async function clearGeneralCache() {
  const now = Date.now();
  const cacheType = 'general';
  const maxAge = 30 * 24 * 60 * 60; // 30 days in seconds
  const dir = generalCacheDir;

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stats = await fs.stat(filePath);
        const age = (now - stats.mtimeMs) / 1000; // Age in seconds
        if (age > maxAge) {
          await fs.unlink(filePath);
          console.log(`Deleted expired cache file (${cacheType}): ${file}`);
        }
      } catch (err) {
        console.error(`Error processing file ${file} in ${cacheType} cache:`, err);
      }
    }
  } catch (err) {
    console.error(`Error reading ${cacheType} cache directory:`, err);
  }
}

/**
 * Clears expired files from the Video Clips Cache.
 * Max Age: 5 minutes
 */
async function clearVideoClipsCache() {
  const now = Date.now();
  const cacheType = 'video_clips';
  const maxAge = 5 * 60; // 5 minutes in seconds
  const dir = videoClipsCacheDir;

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stats = await fs.stat(filePath);
        const age = (now - stats.mtimeMs) / 1000; // Age in seconds
        if (age > maxAge) {
          await fs.unlink(filePath);
          console.log(`Deleted expired cache file (${cacheType}): ${file}`);
        }
      } catch (err) {
        console.error(`Error processing file ${file} in ${cacheType} cache:`, err);
      }
    }
  } catch (err) {
    console.error(`Error reading ${cacheType} cache directory:`, err);
  }
}

/**
 * Clears expired files from the Spritesheet Cache.
 * Adjust the maxAge as per your requirement.
 */
async function clearSpritesheetCache() {
  const now = Date.now();
  const cacheType = 'spritesheet';
  const maxAge = 7 * 24 * 60 * 60; // Example: 7 days in seconds
  const dir = spritesheetCacheDir;

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stats = await fs.stat(filePath);
        const age = (now - stats.mtimeMs) / 1000; // Age in seconds
        if (age > maxAge) {
          await fs.unlink(filePath);
          console.log(`Deleted expired cache file (${cacheType}): ${file}`);
        }
      } catch (err) {
        console.error(`Error processing file ${file} in ${cacheType} cache:`, err);
      }
    }
  } catch (err) {
    console.error(`Error reading ${cacheType} cache directory:`, err);
  }
}

/**
 * Clears expired files from the Frames Cache.
 * Adjust the maxAge as per your requirement.
 */
async function clearFramesCache() {
  const now = Date.now();
  const cacheType = 'frames';
  const maxAge = 7 * 24 * 60 * 60; // Example: 7 days in seconds
  const dir = framesCacheDir;

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stats = await fs.stat(filePath);
        const age = (now - stats.mtimeMs) / 1000; // Age in seconds
        if (age > maxAge) {
          await fs.unlink(filePath);
          console.log(`Deleted expired cache file (${cacheType}): ${file}`);
        }
      } catch (err) {
        console.error(`Error processing file ${file} in ${cacheType} cache:`, err);
      }
    }
  } catch (err) {
    console.error(`Error reading ${cacheType} cache directory:`, err);
  }
}

//
// Function to find an MP4 file in a directory, optionally looking for a specific file
async function findMp4File(directory, specificFileName = null) {
  try {
    const files = await fs.readdir(directory);
    let targetFile;

    // If specificFileName is provided, try to find it
    if (specificFileName) {
      targetFile = files.find((file) => file === specificFileName);
      if (targetFile) {
        return path.join(directory, targetFile);
      }
      // If the specific file is not found, you can either throw an error or fall back to finding any MP4 file
      console.log(
        `Specific file ${specificFileName} not found, looking for any .mp4 file.`
      );
    }

    // If specificFileName is not provided or specific file not found, find the first .mp4 file
    const mp4Files = files.filter((file) => file.endsWith(".mp4"));
    if (mp4Files.length === 0) {
      throw new Error("No MP4 file found in the directory");
    }
    return path.join(directory, mp4Files[0]);
  } catch (error) {
    console.error(error.message);
    throw error; // Rethrow the error to be handled by the caller
  }
}

async function getStoredBlurhash(imagePath, basePath) {
  const blurhashFile = `${imagePath}.blurhash`;
  const relativePath = path.relative(basePath, blurhashFile);
  const encodedRelativePath = relativePath.split(path.sep).map(encodeURIComponent).join(path.sep);
  const relativeUrl = `${PREFIX_PATH}/${encodedRelativePath}`;

  if (await fileExists(blurhashFile)) {
    return relativeUrl;
  }

  // Determine if debug mode is enabled
  const isDebugMode = process.env.DEBUG && process.env.DEBUG.toLowerCase() === 'true';
  const debugMessage = isDebugMode ? ' [Debugging Enabled]' : '';
  console.log(`Running blurhash_cli.py job${debugMessage}`);

  // Construct the command based on debug mode
  const command = `sudo bash -c "python3 ${blurhashCli} \\"${imagePath.replace(/"/g, '\\"')}\\""`;

  try {
    // Execute the command
    const blurhashOutput = await execAsync(command);
    const exitStatus = blurhashOutput.stderr ? blurhashOutput.stderr : null;

    if (exitStatus) {
      console.error(`Error generating blurhash: ${blurhashOutput.stderr}`);
      return null;
    }

    // Write the generated blurhash to a file
    await fs.writeFile(blurhashFile, blurhashOutput.stdout.trim());
    return relativeUrl;
  } catch (error) {
    console.error(`Error executing blurhash_cli.py: ${error}`);
    return null;
  }
}

async function calculateDirectoryHash(dirPath, maxDepth = 5) {
  const hash = crypto.createHash('sha256');

  async function processDirectory(currentPath, currentDepth) {
    if (currentDepth > maxDepth) return;

    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
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

async function getLastModifiedTime(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtime; // Modification time
  } catch {
    return null;
  }
}

module.exports = {
  generateFrame: async (videoPath, timestamp, framePath) => {
    await loadPLimit();
    return generateFrame(videoPath, timestamp, framePath);
  },
  getVideoDuration,
  fileExists,
  ensureCacheDirs,
  clearGeneralCache,
  clearVideoClipsCache,
  clearSpritesheetCache,
  clearFramesCache,
  mainCacheDir,
  generalCacheDir,
  spritesheetCacheDir,
  framesCacheDir,
  generateCacheKey,
  getCachedClipPath,
  isCacheValid,
  ongoingCacheGenerations,
  findMp4File,
  getStoredBlurhash,
  calculateDirectoryHash,
  getLastModifiedTime,
};
