const fs = require('fs');
const util = require('util');
/* const logFile = fs.createWriteStream('worker.log', { flags: 'a' });
console.log = function(message) {
  logFile.write(util.format(message) + '\n');
  process.stdout.write(util.format(message) + '\n');
}; */

const path = require('path');
const { exec } = require('child_process');
const { generateFrame, fileExists } = require('./utils');

process.on('message', async (data) => {
  try {
    const { videoPath, type, name, season, episode, cacheDir, timestamps } = data;
    console.log(`Worker ${process.pid} started processing ${timestamps.length} timestamps.`);
    const frames = [];

    for (const timestamp of timestamps) {
      let frameFileName;
      if (type === 'movies') {
        frameFileName = `movie_${name}_${timestamp}.jpg`;
      } else if (type === 'tv') {
        frameFileName = `${type}_${name}_${season}_${episode}_${timestamp}.jpg`;
      }

      let framePath = path.join(cacheDir, frameFileName);
      console.log(framePath);

      if (await fileExists(framePath)) {
        console.log(`Worker ${process.pid} using cached frame: ${frameFileName}`);
        // Get the dimensions of the cached frame using ffprobe
        const ffprobeCommand = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${framePath}"`;
        const ffprobePromise = new Promise((resolve, reject) => {
          exec(ffprobeCommand, (error, stdout, stderr) => {
            if (error) {
              console.error(`Worker ${process.pid} error getting frame dimensions: ${error.message}`);
              reject(error);
            } else {
              const [width, height] = stdout.trim().split('x');
              resolve({ framePath, width: parseInt(width), height: parseInt(height) });
            }
          });
        });
        frames.push(await ffprobePromise);
      } else {
        console.log(`Worker ${process.pid} generating new frame: ${frameFileName}`);
        const frameData = await generateFrame(videoPath, timestamp, framePath);
        frames.push(frameData);
      }
    }

    console.log(`Worker ${process.pid} completed processing. Generated ${frames.length} frames.`);
    process.send({ frames });
  } catch (error) {
    console.error(`Worker ${process.pid} encountered an error:`, error);
  }
});