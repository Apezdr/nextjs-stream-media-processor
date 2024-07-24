const { exec } = require('child_process');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs').promises; // Use the promise-based version of fs
const { generateFrame, getVideoDuration, fileExists } = require('./utils');

async function generateSpriteSheet({videoPath, type, name, season = null, episode = null, cacheDir}) {
  try {
    const duration = await getVideoDuration(videoPath);
    const floorDuration = Math.floor(duration);
    console.log(`Total Duration: ${floorDuration} seconds`);

    const interval = 5; // Adjust if needed
    const frames = [];
    const timestamps = [];

    for (let currentTime = 0; currentTime <= floorDuration; currentTime += interval) {
      let timestamp = new Date(currentTime * 1000).toISOString().substr(11, 8);
      timestamps.push(timestamp);
    }

    try {
      // Parallelize the snapshot generation using child processes
      const numWorkers = 13; // Adjust the number of worker processes based on your system's capabilities
      const workerPromises = [];

      console.log(`Creating ${numWorkers} worker processes...`);

      for (let i = 0; i < numWorkers; i++) {
        const worker = fork(path.join(__dirname, 'snapshotWorker.js'));
        const workerPromise = new Promise((resolve, reject) => {
          worker.on('message', (result) => {
            frames.push(...result.frames);
            console.log(`Worker ${worker.pid} completed. Received ${result.frames.length} frames.`);
            resolve();
          });
          worker.on('error', (error) => {
            console.log('Worker Error', error);
            reject(error);
          });
        });

        const startIndex = i * Math.ceil(timestamps.length / numWorkers);
        const endIndex = Math.min((i + 1) * Math.ceil(timestamps.length / numWorkers), timestamps.length);
        const workerTimestamps = timestamps.slice(startIndex, endIndex);

        if (type === 'movies') {
          worker.send({ videoPath, type, name, cacheDir, timestamps: workerTimestamps });
        } else if (type === 'tv') {
          worker.send({ videoPath, type, name, season, episode, cacheDir, timestamps: workerTimestamps });
        }
        workerPromises.push(workerPromise);
      }

      await Promise.all(workerPromises);
      console.log('All workers completed.');
	  // Sort the frames array based on timestamps or file names
	  frames.sort((a, b) => {
		// Extract the timestamp from the frame file names
		const timestampRegex = /_(\d{2}:\d{2}:\d{2})/;
		const timestampA = a.framePath.match(timestampRegex)[1];
		const timestampB = b.framePath.match(timestampRegex)[1];

		// Compare the timestamps
		return timestampA.localeCompare(timestampB);
	  });
	} catch (error) {
      console.error(`Error in generateSpriteSheet: ${error}`);
    }

    // Generate the sprite sheet
    let spriteSheetFileName;
    if (type === 'movies') {
      spriteSheetFileName = `movie_${name}_spritesheet.jpg`;
    } else if (type === 'tv') {
      spriteSheetFileName = `tv_${name}_${season}_${episode}_spritesheet.jpg`;
    }
    const spriteSheetPath = path.join(cacheDir, spriteSheetFileName);
    await generateSpriteSheetImage(frames, spriteSheetPath);

    // Generate the VTT file
    let vttFileName;
    if (type === 'movies') {
      vttFileName = `movie_${name}_spritesheet.vtt`;
    } else if (type === 'tv') {
      vttFileName = `tv_${name}_${season}_${episode}_spritesheet.vtt`;
    }
    const vttFilePath = path.join(cacheDir, vttFileName);
    await generateVttFile(frames, vttFilePath, interval, type, name, season, episode);
  } catch (error) {
    console.error(`Error in generateSpriteSheet: ${error}`);
  }
}

async function generateSpriteSheetImage(frames, spriteSheetPath) {
  const sharp = require('sharp');
  const columns = 10;

  console.log(`Sprite sheet generating...: ${spriteSheetPath}`);

  const maxWidth = Math.max(...frames.map(frame => frame.width));
  const maxHeight = Math.max(...frames.map(frame => frame.height));

  const spriteSheetWidth = maxWidth * columns;
  const spriteSheetHeight = Math.ceil(frames.length / columns) * maxHeight;

  console.time('Prepare composite array');
  const compositeArray = await Promise.all(frames.map(async (frame, i) => {
    const left = (i % columns) * maxWidth;
    const top = Math.floor(i / columns) * maxHeight;

    if (await fileExists(frame.framePath)) {
      return { input: frame.framePath, left, top };
    }
    console.warn(`Frame not found: ${frame.framePath}`);
    return null;
  }));
  console.timeEnd('Prepare composite array');

  const validCompositeArray = compositeArray.filter(item => item !== null);

  try {
    console.time('Sharp composite operation');
    await sharp({
      create: {
        width: spriteSheetWidth,
        height: spriteSheetHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      }
    })
    .composite(validCompositeArray)
    .toFile(spriteSheetPath);
    console.timeEnd('Sharp composite operation');

    console.log(`Sprite sheet generated: ${spriteSheetPath}`);
  } catch (error) {
    console.error(`Error generating sprite sheet: ${error}`);
    throw error;
  }
}

async function generateVttFile(frames, vttFilePath, interval, type, name, season = null, episode = null) {
  let vttContent = 'WEBVTT\n\n';

  const baseUrl = process.env.FILE_SERVER_NODE_URL;
  let spriteSheetUrl;

  if (type === 'movies') {
    spriteSheetUrl = `${baseUrl}/spritesheet/movie/${encodeURIComponent(name)}`;
  } else if (type === 'tv') {
    spriteSheetUrl = `${baseUrl}/spritesheet/tv/${encodeURIComponent(name)}/${season}/${episode}`;
  }

  const frameWidth = frames[0].width; // Use the width of the first frame
  const frameHeight = frames[0].height; // Use the height of the first frame
  const columns = 10; // Adjust the number of columns as needed

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const startTime = formatTime(i * interval);
    const endTime = formatTime((i + 1) * interval);
    const left = (i % columns) * frame.width;
    const top = Math.floor(i / columns) * frame.height;

    vttContent += `${startTime} --> ${endTime}\n`;
    vttContent += `${spriteSheetUrl}#xywh=${left},${top},${frame.width},${frame.height}\n\n`;
  }

  await fs.writeFile(vttFilePath, vttContent);
}

function formatTime(seconds) {
  const date = new Date(seconds * 1000);
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const secs = date.getUTCSeconds().toString().padStart(2, '0');
  const ms = date.getUTCMilliseconds().toString().padStart(3, '0');
  return `${hours}:${minutes}:${secs}.${ms}`;
}

module.exports = {
  generateSpriteSheet,
};