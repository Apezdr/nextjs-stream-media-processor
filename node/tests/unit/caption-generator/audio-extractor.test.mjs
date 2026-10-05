/**
 * extractAudio names the audio track it extracts. Without `-map` ffmpeg takes
 * the file's default track (else the one with the most channels), whatever
 * its language.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import { join } from 'path';
import os from 'os';

const executeFFmpeg = jest.fn(async () => {});
jest.unstable_mockModule('../../../ffmpeg/ffmpeg.mjs', () => ({ executeFFmpeg }));

const { extractAudio } = await import(
  '../../../components/caption-generator/domain/audio-extractor.mjs'
);

const tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'caption-audio-'));
const wavPath = join(tmpRoot, 'out', 'audio.wav');

describe('extractAudio', () => {
  beforeEach(() => {
    executeFFmpeg.mockClear();
  });

  it('maps the given stream and writes 16 kHz mono PCM', async () => {
    await extractAudio('/media/film.mkv', wavPath, 2);

    expect(executeFFmpeg).toHaveBeenCalledTimes(1);
    expect(executeFFmpeg.mock.calls[0][0]).toEqual([
      '-y',
      '-i', '/media/film.mkv',
      '-map', '0:2',
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      wavPath
    ]);
  });

  it.each([undefined, null, -1, 1.5, '2'])('does not run ffmpeg without a stream index (%p)', async (streamIndex) => {
    await expect(extractAudio('/media/film.mkv', wavPath, streamIndex)).rejects.toThrow(/stream index/);
    expect(executeFFmpeg).not.toHaveBeenCalled();
  });
});
