const path = require('path');
const { exec } = require('child_process');
const { createCategoryLogger } = require('./lib/logger.mjs');
const { generateFrame, fileExists } = require('./utils/utils.mjs').default;
const logger = createCategoryLogger('snapshotWorker');

process.on('message', async (data) => {
  try {
    const { videoPath, type, name, season, episode, cacheDir, timestamps } = data;
    logger.info(`Worker ${process.pid} started processing ${timestamps.length} timestamps.`);
    const frames = [];

    for (const timestamp of timestamps) {
      let baseFileName;
      if (type === 'movies') {
        baseFileName = `movie_${name}_${timestamp}`;
      } else if (type === 'tv') {
        baseFileName = `${type}_${name}_${season}_${episode}_${timestamp}`;
      }

      // Ensure the frame file name ends with .png
      let frameFileName = `${baseFileName}.png`;
      let framePath = path.join(cacheDir, frameFileName);

      // Check if the frame already exists
      if (await fileExists(framePath)) {
        logger.info(`Worker ${process.pid} using cached frame: ${frameFileName}`);
      } else {
        logger.info(`Worker ${process.pid} generating new frame: ${frameFileName}`);
        // Generate the frame
        await generateFrame(videoPath, timestamp, framePath);
      }

      // Get the dimensions of the frame using ffprobe
      const ffprobeCommand = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${framePath}"`;
      const ffprobePromise = new Promise((resolve, reject) => {
        exec(ffprobeCommand, (error, stdout, stderr) => {
          if (error) {
            logger.error(`Worker ${process.pid} error getting frame dimensions: ${error.message}`);
            reject(error);
          } else {
            const [width, height] = stdout.trim().split('x');
            resolve({ framePath, width: parseInt(width), height: parseInt(height) });
          }
        });
      });
      frames.push(await ffprobePromise);
    }

    logger.info(`Worker ${process.pid} completed processing. Generated ${frames.length} frames.`);
    process.send({ frames });
  } catch (error) {
    logger.error(`Worker ${process.pid} encountered an error:`, error);
  }
});
