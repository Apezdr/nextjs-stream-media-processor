const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { getVideoDuration, fileExists, convertToAvif } = require('./utils');
const sharp = require('sharp');

async function generateSpriteSheet({ videoPath, type, name, season = null, episode = null, cacheDir }) {
  try {
    const duration = await getVideoDuration(videoPath);
    const floorDuration = Math.floor(duration);
    console.log(`Total Duration: ${floorDuration} seconds`);

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
    let outputFormat = 'avif'; // Default to AVIF
    if (duration > 3600) { // If video is longer than 1 hour
      outputFormat = 'png';
    }

    const spriteSheetExtension = outputFormat === 'avif' ? '.avif' : '.png';
    const spriteSheetFileName = spriteSheetFileNameBase + spriteSheetExtension;
    const spriteSheetPath = path.join(cacheDir, spriteSheetFileName);
    const vttFilePath = path.join(cacheDir, vttFileName);

    // Check if sprite sheet and VTT already exist
    if (await fileExists(spriteSheetPath) && await fileExists(vttFilePath)) {
      console.log(`Serving existing sprite sheet and VTT files.`);
      return { spriteSheetPath, vttFilePath };
    }

    if (!await fileExists(spriteSheetPath)) {
      // Use FFmpeg to generate the sprite sheet
      await generateSpriteSheetWithFFmpeg(videoPath, spriteSheetPath, interval, columns, rows, outputFormat);
    }
    if (!await fileExists(vttFilePath)) {
      // Generate the VTT file
      await generateVttFileFFmpeg(spriteSheetPath, vttFilePath, floorDuration, interval, columns, rows, type, name, season, episode);
    }

    console.log('Sprite sheet and VTT file generated successfully.');
    return { spriteSheetPath, vttFilePath };
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
    // Step 1: Detect if the video is HDR
    const hdr = await isVideoHDR(videoPath);
    console.log(`Video HDR: ${hdr}`);

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
      vfFilters = `fps=1/${interval},scale=320:-1,tile=${columns}x${rows}`;
    }

    // Step 4: Determine output options based on format
    const pixFmtOption = '-pix_fmt rgb24';
    const ffmpegOutputPath = tempSpriteSheetPath;

    // Step 5: Construct the FFmpeg command
    const ffmpegCommand = `ffmpeg -y -i "${videoPath}" -vf "${vfFilters}" ${pixFmtOption} "${ffmpegOutputPath}"`;
    console.log(`Executing FFmpeg command: ${ffmpegCommand}`);

    // Step 6: Execute FFmpeg command
    await new Promise((resolve, reject) => {
      exec(ffmpegCommand, (error, stdout, stderr) => {
        if (error) {
          console.error(`FFmpeg error: ${stderr}`);
          return reject(error);
        }
        console.log(`Sprite sheet created at ${ffmpegOutputPath}`);
        resolve();
      });
    });

    // Step 7: Start the conversion if necessary
    if (outputFormat === 'png') {
      const avifPath = spriteSheetPath;
      try {
        await convertToAvif(ffmpegOutputPath, avifPath, 60, 4);
        console.log(`Converted sprite sheet to AVIF at ${avifPath}`);
      } catch (conversionError) {
        console.error(`Error converting PNG to AVIF: ${conversionError}`);
        // Optionally implement retry mechanisms
      }
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
  const metadata = await sharp(imagePath).metadata();
  return { width: metadata.width, height: metadata.height };
}

module.exports = {
  generateSpriteSheet,
};
