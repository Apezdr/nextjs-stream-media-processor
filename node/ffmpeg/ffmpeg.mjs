// ffmpeg/ffmpeg.mjs
// This module provides a function to execute FFmpeg commands using Node.js.
import { spawn } from 'child_process';
import { createCategoryLogger } from '../lib/logger.mjs';

const logger = createCategoryLogger('ffmpeg');

export async function executeFFmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, options);

    let stderrData = '';
    ffmpeg.stderr.on('data', (data) => {
      const message = data.toString();
      stderrData += message;
      logger.debug(`FFmpeg stderr: ${message}`);
    });

    ffmpeg.on('error', (error) => {
      logger.error(`FFmpeg process error: ${error.message}`);
      reject(error);
    });

    ffmpeg.on('close', (code, signal) => {
      if (code === 0) {
        logger.info(`FFmpeg process completed successfully.`);
        resolve();
      } else if (signal) {
        // No exit code: the process was killed, e.g. by the spawn `timeout` option.
        logger.error(`FFmpeg was killed by ${signal}.`);
        reject(new Error(`FFmpeg was killed by ${signal}: ${stderrData}`));
      } else {
        logger.error(`FFmpeg exited with code ${code}.`);
        reject(new Error(`FFmpeg exited with code ${code}: ${stderrData}`));
      }
    });
  });
}
