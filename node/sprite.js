const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { getVideoDuration, fileExists } = require('./utils');
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

    // Define output file names
    let spriteSheetFileName, vttFileName;
    if (type === 'movies') {
      spriteSheetFileName = `movie_${name}_spritesheet.avif`;
      vttFileName = `movie_${name}_spritesheet.vtt`;
    } else if (type === 'tv') {
      spriteSheetFileName = `tv_${name}_${season}_${episode}_spritesheet.avif`;
      vttFileName = `tv_${name}_${season}_${episode}_spritesheet.vtt`;
    }

    const spriteSheetPath = path.join(cacheDir, spriteSheetFileName);
    const vttFilePath = path.join(cacheDir, vttFileName);

    // Check if sprite sheet and VTT already exist
    if (await fileExists(spriteSheetPath) && await fileExists(vttFilePath)) {
      console.log(`Serving existing sprite sheet and VTT files.`);
      return { spriteSheetPath, vttFilePath };
    }

    if (!await fileExists(spriteSheetPath)) {
      // Use FFmpeg to generate the sprite sheet
      await generateSpriteSheetWithFFmpeg(videoPath, spriteSheetPath, interval, columns, rows);
    }
    if (!await fileExists(vttFilePath)) {
      // Generate the VTT file
      await generateVttFileFFmpeg(spriteSheetPath, vttFilePath, floorDuration, interval, columns, rows, type, name, season, episode);
    }

    console.log('Sprite sheet and VTT file generated successfully.');
    return { spriteSheetPath, vttFilePath };
  } catch (error) {
    console.error(`Error in generateSpriteSheet: ${error}`);
  }
}

async function generateSpriteSheetWithFFmpeg(videoPath, spriteSheetPath, interval, columns, rows) {
  // Generate a temporary PNG spritesheet
  const tempSpriteSheetPath = spriteSheetPath.replace(/\.[^/.]+$/, '.png');

  const command = `ffmpeg -y -i "${videoPath}" -frames:v 1 -vf "fps=1/${interval},scale=320:-1,tile=${columns}x${rows}" "${tempSpriteSheetPath}"`;
  console.log(`Executing FFmpeg command: ${command}`);

  return new Promise((resolve, reject) => {
    exec(command, async (error, stdout, stderr) => {
      if (error) {
        console.error(`FFmpeg error: ${stderr}`);
        reject(error);
      } else {
        console.log(`Sprite sheet created at ${tempSpriteSheetPath}`);

        try {
          // Convert the PNG spritesheet to AVIF using sharp
          await sharp(tempSpriteSheetPath)
            .avif({ quality: 60 }) // Adjust quality as needed
            .toFile(spriteSheetPath);

          console.log(`Converted spritesheet to AVIF at ${spriteSheetPath}`);

          // Optionally delete the temporary PNG file
          fs.unlink(tempSpriteSheetPath, (err) => {
            if (err) {
              console.error(`Error deleting temporary PNG file: ${err}`);
            } else {
              console.log(`Deleted temporary PNG file: ${tempSpriteSheetPath}`);
            }
          });

          resolve();
        } catch (conversionError) {
          console.error(`Error converting spritesheet to AVIF: ${conversionError}`);
          reject(conversionError);
        }
      }
    });
  });
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
