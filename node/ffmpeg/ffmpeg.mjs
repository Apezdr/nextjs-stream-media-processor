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

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        logger.info(`FFmpeg process completed successfully.`);
        resolve();
      } else {
        logger.error(`FFmpeg exited with code ${code}.`);
        reject(new Error(`FFmpeg exited with code ${code}: ${stderrData}`));
      }
    });
  });
}
