import { promises as fs } from 'fs';
import { dirname } from 'path';
import { executeFFmpeg } from '../../../ffmpeg/ffmpeg.mjs';

/**
 * Extract a 16 kHz mono PCM WAV from one audio track of a video file.
 * This is whisper.cpp's required input format.
 *
 * The track is named, never left to ffmpeg, which would take the file's default
 * track whatever its language (see audio-track.mjs).
 *
 * @param {string} videoPath   - Source media file
 * @param {string} wavPath     - Destination WAV file
 * @param {number} streamIndex - The audio track's stream index in the file
 */
export async function extractAudio(videoPath, wavPath, streamIndex) {
  if (!Number.isInteger(streamIndex) || streamIndex < 0) {
    throw new Error(`extractAudio needs the audio track's stream index, got ${streamIndex}`);
  }

  await fs.mkdir(dirname(wavPath), { recursive: true });

  await executeFFmpeg([
    '-y',
    '-i', videoPath,
    '-map', `0:${streamIndex}`,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    wavPath
  ]);
}
