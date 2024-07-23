const { exec } = require('child_process');
const fs = require('fs').promises; // Use the promise-based version of fs
const path = require('path');
const cacheDir = path.join(__dirname, 'cache');

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
    const ffmpegCommand = `ffmpeg -ss ${timestamp} -i "${videoPath}" -frames:v 1 -vf scale=-1:140 -q:v 4 "${framePath}" -y`;
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

// Ensure cache directory exists asynchronously
async function ensureCacheDir() {
  try {
    await fs.access(cacheDir);
  } catch (error) {
    await fs.mkdir(cacheDir, { recursive: true });
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

module.exports = {
  generateFrame: async (videoPath, timestamp, framePath) => {
    await loadPLimit();
    return generateFrame(videoPath, timestamp, framePath);
  },
  getVideoDuration,
  fileExists,
  ensureCacheDir,
  cacheDir,
  findMp4File,
};
