/**
 * The VTT and sprite-sheet routes coalesce concurrent requests for one title:
 * the first starts generation and later ones are parked in an in-memory queue
 * to be served when it finishes. When generation failed (every MKV did, until
 * the duration probe learned to read the container duration) only the first
 * request was answered; the parked ones were never responded to and hung
 * until the client gave up. These tests pin that a failure answers every
 * parked request, and that the route retries from scratch on the next
 * request instead of trusting the stale error state.
 *
 * Runs the real router on an ephemeral port with generation and the data
 * layers mocked.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-route-'));
const generateSpriteSheet = jest.fn();

jest.unstable_mockModule('../../../sprite.mjs', () => ({
  generateSpriteSheet,
  generateVttFileFFmpeg: jest.fn(),
}));
jest.unstable_mockModule('../../../sqliteDatabase.mjs', () => ({
  initializeDatabase: jest.fn(async () => ({})),
  getTVShowByName: jest.fn(async () => null),
  getMovieByName: jest.fn(async (name) => ({ name })),
  releaseDatabase: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../../sqlite/processTracking.mjs', () => ({
  createOrUpdateProcessQueue: jest.fn(async () => {}),
  updateProcessQueue: jest.fn(async () => {}),
  finalizeProcessQueue: jest.fn(async () => {}),
  getProcessTrackingDb: jest.fn(async () => ({})),
}));
jest.unstable_mockModule('../../../utils/utils.mjs', () => ({
  fileExists: async (p) => fs.access(p).then(() => true, () => false),
  shouldUseAvif: () => false,
  convertToAvif: jest.fn(),
  spritesheetCacheDir: cacheDir,
}));
jest.unstable_mockModule('../../../utils/mediaResolution.mjs', () => ({
  resolveMovieVideo: jest.fn(async () => ({ path: '/lib/movies/Test Movie/Test.Movie.2001.mkv' })),
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

// movie_<sanitized name>_spritesheet_<first 8 of uuid>_v<SPRITE_VERSION>.vtt
const VTT_NAME = 'movie_Test-Movie_spritesheet_581bf51c_v10001.vtt';
const vttPath = path.join(cacheDir, VTT_NAME);

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

beforeEach(async () => {
  generateSpriteSheet.mockReset();
  quiet.info.mockReset();
  await fs.rm(vttPath, { force: true });
});

const requestVtt = () => fetch(`${baseUrl}/vtt/movie/Test%20Movie`);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// The first request is only "in flight" once the route has called into
// generation; the second must arrive after that to be parked, not to start
// its own generation.
async function untilGenerationStarted() {
  await until(() => generateSpriteSheet.mock.calls.length > 0);
  expect(generateSpriteSheet).toHaveBeenCalledTimes(1);
}

// fetch() returns before the request reaches the server, so settling the
// generation right after firing the second request would race it. The route
// logs when it parks a request; wait for that.
async function untilParked() {
  await until(() =>
    quiet.info.mock.calls.some(([message]) => /already being processed/.test(String(message)))
  );
}

async function until(condition) {
  for (let i = 0; i < 300 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

describe('GET /vtt/movie/:movieName with a request parked behind generation', () => {
  it('answers the parked request with a 500 too when generation fails', async () => {
    const generation = deferred();
    generateSpriteSheet.mockReturnValue(generation.promise);

    const first = requestVtt();
    await untilGenerationStarted();
    const parked = requestVtt();
    await untilParked();

    generation.reject(new Error('Failed to parse video duration (stream=N/A, format=N/A).'));

    const [firstRes, parkedRes] = await Promise.all([first, parked]);
    expect(firstRes.status).toBe(500);
    expect(parkedRes.status).toBe(500);
    // Coalesced: one generation for both requests.
    expect(generateSpriteSheet).toHaveBeenCalledTimes(1);
  });

  it('serves every parked request the VTT when generation succeeds', async () => {
    const generation = deferred();
    generateSpriteSheet.mockReturnValue(generation.promise);

    const first = requestVtt();
    await untilGenerationStarted();
    const parked = requestVtt();
    await untilParked();

    await fs.writeFile(vttPath, 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nsprite.png#xywh=0,0,320,180\n');
    generation.resolve({});

    const [firstRes, parkedRes] = await Promise.all([first, parked]);
    expect(firstRes.status).toBe(200);
    expect(parkedRes.status).toBe(200);
    expect(await firstRes.text()).toMatch(/^WEBVTT/);
    expect(await parkedRes.text()).toMatch(/^WEBVTT/);
    expect(generateSpriteSheet).toHaveBeenCalledTimes(1);
  });

  it('retries generation from scratch on the next request after a failure', async () => {
    generateSpriteSheet.mockRejectedValueOnce(new Error('probe failed'));
    expect((await requestVtt()).status).toBe(500);

    generateSpriteSheet.mockImplementationOnce(async () => {
      await fs.writeFile(vttPath, 'WEBVTT\n\n');
      return {};
    });
    const retry = await requestVtt();
    expect(retry.status).toBe(200);
    expect(generateSpriteSheet).toHaveBeenCalledTimes(2);
  });
});
