/**
 * Sprite generation hazards behind the "ENOENT ... rename temp_*.png" error
 * recorded in production. Two generations of the same title could run at
 * once (the VTT and sprite-sheet routes dedupe their own requests only), both
 * using one temp PNG; and the fallback rename after a failed optimization
 * reported ENOENT instead of the failure that actually emptied the pipeline.
 *
 * getInfo is the first await inside a generation, so holding it open is
 * enough to observe whether a second call joins the first run or starts its
 * own. Nothing here reaches ffmpeg.
 */

import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const getInfo = jest.fn();
jest.unstable_mockModule('../../../infoManager.mjs', () => ({ getInfo }));

const quiet = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../lib/logger.mjs', () => ({
  createCategoryLogger: () => quiet,
}));

const { generateSpriteSheet, generateSpriteSheetWithFFmpeg, keepUnoptimizedPng } = await import('../../../sprite.mjs');

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-coalesce-'));
afterAll(() => fs.rm(tmpRoot, { recursive: true, force: true }));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// A run awaits its progress callback before it probes, so call counts are
// only meaningful once the microtask queue has drained.
const settle = () => new Promise((resolve) => setImmediate(resolve));

const episode = (overrides = {}) => ({
  videoPath: '/lib/tv/Show/Season 1/Show - S01E01.mkv',
  type: 'tv',
  name: 'Show',
  season: '1',
  episode: '1',
  cacheDir: tmpRoot,
  ...overrides,
});

describe('generateSpriteSheet coalescing', () => {
  beforeEach(() => getInfo.mockReset());

  it('a second call for the same title joins the in-flight run instead of starting another', async () => {
    const probing = deferred();
    getInfo.mockReturnValue(probing.promise);

    const first = generateSpriteSheet(episode());
    const second = generateSpriteSheet(episode());

    expect(second).toBe(first);
    await settle();
    expect(getInfo).toHaveBeenCalledTimes(1);

    const failure = new Error('probe failed');
    probing.reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
  });

  it('different titles do not share a run', async () => {
    getInfo.mockReturnValue(new Promise(() => {}));

    const one = generateSpriteSheet(episode());
    const other = generateSpriteSheet(episode({ episode: '2' }));

    expect(other).not.toBe(one);
    await settle();
    expect(getInfo).toHaveBeenCalledTimes(2);
  });

  it('once a run has settled, the next call starts fresh', async () => {
    getInfo.mockRejectedValueOnce(new Error('first run failed'));
    await expect(generateSpriteSheet(episode({ name: 'Other Show' }))).rejects.toThrow('first run failed');

    getInfo.mockReturnValue(new Promise(() => {}));
    generateSpriteSheet(episode({ name: 'Other Show' }));
    await settle();
    expect(getInfo).toHaveBeenCalledTimes(2);
  });
});

describe('failures name the step that failed', () => {
  it('a missing video rejects the extraction step instead of returning quietly', async () => {
    const missing = path.join(tmpRoot, 'missing.mkv');
    await expect(
      generateSpriteSheetWithFFmpeg(missing, path.join(tmpRoot, 'out.png'), 5, 10, 1, 'png')
    ).rejects.toThrow(`Video file not found in Spritesheet step: ${missing}`);
  });

  it('keepUnoptimizedPng moves ffmpeg output into place when it exists', async () => {
    const temp = path.join(tmpRoot, 'temp_sheet.png');
    const final = path.join(tmpRoot, 'sheet.png');
    await fs.writeFile(temp, 'png bytes');

    await keepUnoptimizedPng(temp, final, new Error('optimizer crashed'));

    await expect(fs.readFile(final, 'utf8')).resolves.toBe('png bytes');
    await expect(fs.access(temp)).rejects.toThrow();
  });

  it('keepUnoptimizedPng reports the optimization failure when the output is already gone', async () => {
    const temp = path.join(tmpRoot, 'temp_gone.png');
    await expect(
      keepUnoptimizedPng(temp, path.join(tmpRoot, 'gone.png'), new Error('Input file is missing'))
    ).rejects.toThrow('Sprite sheet temp_gone.png is missing after optimization failed: Input file is missing');
  });
});
