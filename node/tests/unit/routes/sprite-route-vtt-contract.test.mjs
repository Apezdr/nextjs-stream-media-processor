/**
 * The /vtt delivery contract. The route used to hold the response open for
 * the whole generation (minutes for a long film) and answered 500 both for
 * "still generating" and for a real failure. Now the first request starts
 * generation and returns 202 with Retry-After and a progress body; requests
 * while it runs get the current step and fraction; a title that cannot have
 * previews is a 404; a tool failure is a 502 and anything else a 500, each
 * remembered for VTT_FAILURE_HOLD_MS so polling does not restart the job.
 *
 * Runs the real router on an ephemeral port with generation and the data
 * layers mocked. The sprite-sheet route keeps parking concurrent requests;
 * its failure path is covered at the end.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// Short hold so the "retries after the hold" case runs in milliseconds.
process.env.VTT_FAILURE_HOLD_MS = '300';

const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-route-'));
const generateSpriteSheet = jest.fn();
const finalizeProcessQueue = jest.fn(async () => {});
const updateProcessQueue = jest.fn(async () => {});

jest.unstable_mockModule('../../../sprite.mjs', () => ({
  generateSpriteSheet,
  generateVttFileFFmpeg: jest.fn(),
  FAILURE_KIND: { PROBE: 'probe', TOOL: 'tool' },
}));
jest.unstable_mockModule('../../../sqliteDatabase.mjs', () => ({
  initializeDatabase: jest.fn(async () => ({})),
  getTVShowByName: jest.fn(async () => null),
  getMovieByName: jest.fn(async (name) => (name === 'Missing Movie' ? null : { name })),
  releaseDatabase: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../../sqlite/processTracking.mjs', () => ({
  createOrUpdateProcessQueue: jest.fn(async () => {}),
  updateProcessQueue,
  finalizeProcessQueue,
  getProcessTrackingDb: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../../utils/utils.mjs', () => ({
  fileExists: async (p) => fs.access(p).then(() => true, () => false),
  shouldUseAvif: () => false,
  convertToAvif: jest.fn(),
  spritesheetCacheDir: cacheDir,
}));
jest.unstable_mockModule('../../../utils/mediaResolution.mjs', () => ({
  resolveMovieVideo: jest.fn(async ({ movieName }) => ({ path: `/lib/movies/${movieName}/${movieName}.mkv` })),
  resolveEpisodeVideo: jest.fn(async () => null),
  findEpisodeEntry: jest.fn(() => null),
}));
jest.unstable_mockModule('../../../infoManager.mjs', () => ({
  getInfo: jest.fn(async () => ({ uuid: '581bf51c-0000-4000-8000-000000000000' })),
}));
const quiet = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../lib/logger.mjs', () => ({
  createCategoryLogger: () => quiet,
}));

let server;
let baseUrl;

beforeAll(async () => {
  const { createSpriteRoutes } = await import('../../../sprite-route.mjs');
  const express = (await import('express')).default;
  const app = express();
  app.use('/', createSpriteRoutes('/lib'));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(cacheDir, { recursive: true, force: true });
});

beforeEach(() => {
  generateSpriteSheet.mockReset();
  finalizeProcessQueue.mockReset();
  updateProcessQueue.mockReset();
});

// movie_<sanitized name>_spritesheet_<first 8 of uuid>_v<SPRITE_VERSION>.vtt
const vttPathFor = (movieName) =>
  path.join(cacheDir, `movie_${movieName.replace(/[^a-zA-Z0-9\-_]/g, '-')}_spritesheet_581bf51c_v10001.vtt`);

const requestVtt = (movieName) => fetch(`${baseUrl}/vtt/movie/${encodeURIComponent(movieName)}`);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// The runner starts generation after a couple of awaited DB stubs, so the
// captured onProgress callback is only available once the mock was called.
async function untilGenerationStarted(times = 1) {
  for (let i = 0; i < 300 && generateSpriteSheet.mock.calls.length < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(generateSpriteSheet).toHaveBeenCalledTimes(times);
  return generateSpriteSheet.mock.calls[times - 1][0].onProgress;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GET /vtt/movie/:movieName', () => {
  it('serves a cached VTT as text/vtt with no generation', async () => {
    await fs.writeFile(vttPathFor('Cached Movie'), 'WEBVTT\n\n');

    const res = await requestVtt('Cached Movie');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/vtt/);
    expect(await res.text()).toBe('WEBVTT\n\n');
    expect(generateSpriteSheet).not.toHaveBeenCalled();
  });

  it('starts generation and answers 202 with Retry-After and a progress body at once', async () => {
    const generation = deferred();
    generateSpriteSheet.mockReturnValue(generation.promise);

    const res = await requestVtt('Fresh Movie');

    expect(res.status).toBe(202);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      status: 'generating',
      step: 1,
      totalSteps: 3,
      progress: 0,
      message: 'Starting VTT generation',
    });
    await untilGenerationStarted();
    generation.resolve({});
  });

  it('reports the current step and fraction while generating, without a second generation', async () => {
    const generation = deferred();
    generateSpriteSheet.mockReturnValue(generation.promise);

    await requestVtt('Progress Movie');
    const onProgress = await untilGenerationStarted();
    await onProgress(2, 'Extracting frames', 0.42);

    const res = await requestVtt('Progress Movie');
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'generating', step: 2, totalSteps: 3, progress: 0.42, message: 'Extracting frames' });
    expect(generateSpriteSheet).toHaveBeenCalledTimes(1);

    // Progress is mirrored into process_queue with the percentage.
    expect(updateProcessQueue).toHaveBeenCalledWith(expect.anything(), 'movie_Progress Movie_vtt', 2, 'in-progress', 'Extracting frames 42%');

    // Step 3 reports 1 when the generator gives no fraction; long messages are cut to 120 chars.
    await onProgress(3, 'x'.repeat(200));
    const later = await (await requestVtt('Progress Movie')).json();
    expect(later.progress).toBe(1);
    expect(later.message).toHaveLength(120);

    generation.resolve({});
  });

  it('serves the VTT once generation has written it', async () => {
    const generation = deferred();
    generateSpriteSheet.mockReturnValue(generation.promise);

    await requestVtt('Finished Movie');
    await untilGenerationStarted();
    await fs.writeFile(vttPathFor('Finished Movie'), 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nsheet.png#xywh=0,0,320,180\n');
    generation.resolve({});
    await wait(20);

    const res = await requestVtt('Finished Movie');
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^WEBVTT/);
    expect(finalizeProcessQueue).toHaveBeenCalledWith(expect.anything(), 'movie_Finished Movie_vtt', 'completed', expect.any(String));
  });

  it('answers 500 for a failed generation and retries only after the hold', async () => {
    generateSpriteSheet.mockRejectedValueOnce(new Error('sharp ran out of memory'));

    expect((await requestVtt('Broken Movie')).status).toBe(202);
    await untilGenerationStarted();
    await wait(20);

    const failed = await requestVtt('Broken Movie');
    expect(failed.status).toBe(500);
    expect(failed.headers.get('retry-after')).toBe('1');
    expect(await failed.json()).toEqual({ status: 'failed', message: 'sharp ran out of memory' });
    expect(generateSpriteSheet).toHaveBeenCalledTimes(1);
    expect(finalizeProcessQueue).toHaveBeenCalledWith(expect.anything(), 'movie_Broken Movie_vtt', 'error', 'sharp ran out of memory');

    await wait(320);
    generateSpriteSheet.mockReturnValue(new Promise(() => {}));
    const retried = await requestVtt('Broken Movie');
    expect(retried.status).toBe(202);
    await untilGenerationStarted(2);
  });

  it('answers 404 when the probe says the title cannot have previews', async () => {
    generateSpriteSheet.mockRejectedValueOnce(Object.assign(new Error('Failed to parse video duration (stream=N/A, format=N/A).'), { failureKind: 'probe' }));

    await requestVtt('No Stream Movie');
    await untilGenerationStarted();
    await wait(20);

    const res = await requestVtt('No Stream Movie');
    expect(res.status).toBe(404);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toEqual({ status: 'unavailable', message: 'Failed to parse video duration (stream=N/A, format=N/A).' });
  });

  it('answers 502 when ffmpeg itself failed', async () => {
    generateSpriteSheet.mockRejectedValueOnce(Object.assign(new Error('FFmpeg exited with code 1: boom'), { failureKind: 'tool' }));

    await requestVtt('Tool Failure Movie');
    await untilGenerationStarted();
    await wait(20);

    const res = await requestVtt('Tool Failure Movie');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: 'failed', message: 'FFmpeg exited with code 1: boom' });
  });

  it('answers 404 for a title the library does not have', async () => {
    const res = await requestVtt('Missing Movie');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ status: 'unavailable' });
    expect(generateSpriteSheet).not.toHaveBeenCalled();
  });
});

describe('GET /spritesheet/movie/:movieName', () => {
  it('serves an existing sheet from the cache without entering the generator', async () => {
    // The lookup used to require a four-digit version suffix while the files
    // carry five (v10001), so every request re-ran generation and, during a
    // VTT job, waited on it.
    const sheet = path.join(cacheDir, 'movie_Cached-Sheet_spritesheet_581bf51c_v10001.avif');
    await fs.writeFile(sheet, 'avif bytes');

    const res = await fetch(`${baseUrl}/spritesheet/movie/Cached%20Sheet`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/image\/avif/);
    expect(await res.text()).toBe('avif bytes');
    expect(generateSpriteSheet).not.toHaveBeenCalled();
  });
});

describe('GET /spritesheet/movie/:movieName still parks concurrent requests', () => {
  it('answers a parked request with a 500 too when generation fails', async () => {
    const generation = deferred();
    generateSpriteSheet.mockReturnValue(generation.promise);
    quiet.info.mockReset();

    const first = fetch(`${baseUrl}/spritesheet/movie/Sheet%20Movie`);
    await untilGenerationStarted();
    const parked = fetch(`${baseUrl}/spritesheet/movie/Sheet%20Movie`);
    // fetch() returns before the request reaches the server; give the second
    // one time to be parked before the generation is settled.
    await wait(50);

    generation.reject(new Error('extraction failed'));

    const [firstRes, parkedRes] = await Promise.all([first, parked]);
    expect(firstRes.status).toBe(500);
    expect(parkedRes.status).toBe(500);
    expect(generateSpriteSheet).toHaveBeenCalledTimes(1);
  });
});
