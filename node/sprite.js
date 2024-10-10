const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { getVideoDuration, fileExists, convertToAvif } = require('./utils');
const sharp = require('sharp');

let ffmpegQueue;

(async () => {
  const PQueue = (await import('p-queue')).default;
  ffmpegQueue = new PQueue({ concurrency: 3 });
})();

async function handlePNGSpriteSheetConversion(pngSpriteSheetPath, avifSpriteSheetPath) {
  try {
    // If PNG sprite sheet exists, convert it to AVIF
    if (await fileExists(pngSpriteSheetPath)) {
      await convertToAvif(pngSpriteSheetPath, avifSpriteSheetPath, 60, 4);
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  } catch (error) {
    return Promise.reject(error);
  }
}

async function checkSpriteSheetTypeAvailablePath(avifSpriteSheetPath, pngSpriteSheetPath, spriteSheetPath = false) {
  if (avifSpriteSheetPath && await fileExists(avifSpriteSheetPath)) {
    return avifSpriteSheetPath;
  } else if (pngSpriteSheetPath && await fileExists(pngSpriteSheetPath)) {
    return pngSpriteSheetPath;
  } else if (spriteSheetPath && await fileExists(spriteSheetPath)) {
    // Shouldn't normally need this, but just in case
    return spriteSheetPath;
  }
  return false;
}

async function generateSpriteSheet({ videoPath, type, name, season = null, episode = null, cacheDir }) {
  try {
    const duration = await getVideoDuration(videoPath);
    const floorDuration = Math.floor(duration);
    const hours = Math.floor(floorDuration / 3600);
    const minutes = Math.floor((floorDuration % 3600) / 60);
    const seconds = floorDuration % 60;
    console.log(`Total Duration: ${hours}h ${minutes}m ${seconds}s`);

    const interval = 5; // Adjust if needed

    // Calculate the total number of frames
    const totalFrames = Math.floor(floorDuration / interval) + 1; // Add 1 to include the last frame
    const columns = 10; // Number of columns in the sprite sheet
    const rows = Math.ceil(totalFrames / columns); // Calculate the number of rows

    // Define base file name (without extension)
    let spriteSheetFileNameBase, vttFileName;
    if (type === 'movies') {
      spriteSheetFileNameBase = `movie_${name}_spritesheet`;
      vttFileName = `movie_${name}_spritesheet.vtt`;
    } else if (type === 'tv') {
      spriteSheetFileNameBase = `tv_${name}_${season}_${episode}_spritesheet`;
      vttFileName = `tv_${name}_${season}_${episode}_spritesheet.vtt`;
    }

    // Determine output format based on duration
    let outputFormat = 'png'; // Default to png
    // if (duration > 3600) { // If video is longer than 1 hour
    //   outputFormat = 'png';
    // }

    const spriteSheetExtension = outputFormat === 'avif' ? '.avif' : '.png';
    const spriteSheetFileName = spriteSheetFileNameBase + spriteSheetExtension;
    const spriteSheetPath = path.join(cacheDir, spriteSheetFileName);
    const vttFilePath = path.join(cacheDir, vttFileName);

    const avifSpriteSheetPath = path.join(cacheDir, spriteSheetFileNameBase + '.avif')
    const pngSpriteSheetPath = path.join(cacheDir, spriteSheetFileNameBase + '.png')

    let spriteSheetTypeAvailablePath = false;
    spriteSheetTypeAvailablePath = await checkSpriteSheetTypeAvailablePath(avifSpriteSheetPath, pngSpriteSheetPath, spriteSheetPath);

    // Check if sprite sheet and VTT already exist
    if (spriteSheetTypeAvailablePath && await fileExists(vttFilePath)) {
      console.log(`Serving existing sprite sheet and VTT files.`);
      return { spriteSheetTypeAvailablePath, vttFilePath };
    }

    await handlePNGSpriteSheetConversion(pngSpriteSheetPath, avifSpriteSheetPath);
    // If sprite sheet doesn't exist, generate it according to the output format available
    // (ffmpeg can't handle long videos for AVIF spritesheets)
    // So we convert create it as either an AVIF or PNG spritesheet
    // and then convert the AVIF sprite sheet to AVIF if needed
    if (!spriteSheetTypeAvailablePath) {
      // Use FFmpeg to generate the sprite sheet
      await generateSpriteSheetWithFFmpeg(videoPath, spriteSheetPath, interval, columns, rows, outputFormat);
      await handlePNGSpriteSheetConversion(pngSpriteSheetPath, avifSpriteSheetPath);
    }
    spriteSheetTypeAvailablePath = await checkSpriteSheetTypeAvailablePath(avifSpriteSheetPath, pngSpriteSheetPath);
    // Check if VTT file exists
    if (!await fileExists(vttFilePath) && spriteSheetTypeAvailablePath) {
      // Generate the VTT file
      await generateVttFileFFmpeg(spriteSheetTypeAvailablePath, vttFilePath, floorDuration, interval, columns, rows, type, name, season, episode);
    } else if (!spriteSheetTypeAvailablePath) {
      console.error(`Sprite sheet not found at: ${spriteSheetPath}`);
      return {}
    }


    console.log('Sprite sheet and VTT file generated successfully.');
    return { spriteSheetTypeAvailablePath, vttFilePath };
  } catch (error) {
    console.error(`Error in generateSpriteSheet: ${error}`);
    throw error; // Re-throw the error to be handled by the caller
  }
}

/**
 * Checks if the given video file is HDR.
 * @param {string} videoPath - Path to the video file.
 * @returns {Promise<boolean>} - Resolves to true if HDR, else false.
 */
async function isVideoHDR(videoPath) {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v error -select_streams v:0 -show_entries stream=color_space,color_transfer,color_primaries -of default=noprint_wrappers=1 "${videoPath}"`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`ffprobe error: ${stderr}`);
        return reject(error);
      }

      const output = stdout.toLowerCase();
      // Common HDR transfer characteristics
      const hdrTransferCharacteristics = ['smpte2084', 'arib-std-b67'];
      const transferCharacteristic = output.match(/color_transfer=([^\n]+)/);
      const isTransferHDR =
        transferCharacteristic &&
        hdrTransferCharacteristics.includes(transferCharacteristic[1]);

      resolve(Boolean(isTransferHDR));
    });
  });
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
    console.log(`Video HDR: ${hdr}`);
    const videoExists = await fileExists(videoPath);

    if (!videoExists) {
      console.log(`Video file not found in Spritesheet step: ${videoPath}`);
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

    console.log(`Queuing FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

    // Step 6: Add the FFmpeg execution to the queue
    await ffmpegQueue.add(async () => {
      console.log(`Executing FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

      await new Promise((resolve, reject) => {
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        ffmpegProcess.stdout.on('data', (data) => {
          console.log(`stdout: ${data}`);
        });

        ffmpegProcess.stderr.on('data', (data) => {
          console.error(`stderr: ${data}`);
        });

        ffmpegProcess.on('close', (code) => {
          if (code === 0) {
            console.log(`Sprite sheet execution completed, stored at ${ffmpegOutputPath}`);
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
        console.log(`Converted sprite sheet to AVIF at ${spriteSheetPath}`);
      } catch (conversionError) {
        console.error(`Error converting PNG to AVIF: ${conversionError}`);
        // Optionally implement retry mechanisms or handle the error as needed
        throw conversionError;
      }
    }

    // Optionally, send the response if needed
    if (res) {
      res.sendFile(spriteSheetPath, (err) => {
        if (err) {
          console.error(`Error sending file: ${err}`);
        }
      });
    }

    console.log('Sprite sheet generation process completed.');
  } catch (err) {
    console.error(`Error generating sprite sheet: ${err}`);
    throw err;
  }
}

async function generateVttFileFFmpeg(spriteSheetPath, vttFilePath, duration, interval, columns, rows, type, name, season = null, episode = null) {
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

module.exports = {
  generateSpriteSheet,
};
