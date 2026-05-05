import { promises as fs } from 'fs';
import { dirname } from 'path';
import { executeFFmpeg } from '../../../ffmpeg/ffmpeg.mjs';

/**
 * Extract a 16 kHz mono PCM WAV from a video file.
 * This is whisper.cpp's required input format.
 *
 * @param {string} videoPath - Source media file
 * @param {string} wavPath   - Destination WAV file
 */
export async function extractAudio(videoPath, wavPath) {
  await fs.mkdir(dirname(wavPath), { recursive: true });

  await executeFFmpeg([
    '-y',
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    wavPath
  ]);
}
