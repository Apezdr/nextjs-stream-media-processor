/**
 * The /videoClip request handler, over real HTTP, with the library lookups and
 * ffmpeg mocked. The cache directory, the job queue and the range responses
 * are real.
 *
 * What this pins down, each of which was wrong before:
 *   - a clip that is still being encoded is never served (requests wait for it);
 *   - a burst of requests for one clip encodes it once;
 *   - a cache hit does not probe the source;
 *   - an unknown title is a 404, not a 422;
 *   - the TV app's original-quality clip is cached like any other, and falls
 *     back to the encoded clip when the source cannot be copied.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { promises as fs } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import express from 'express';

// One encode at a time, so "queued behind another encode" is easy to arrange.
process.env.VIDEO_CLIP_CONCURRENCY = '1';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-handler-'));
const cacheDir = path.join(root, 'cache');
const sourcePath = path.join(root, 'A Film.mkv');
await fs.mkdir(cacheDir);
await fs.writeFile(sourcePath, 'not really a video');

const exists = (target) => fs.access(target).then(() => true, () => false);

const quiet = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../lib/logger.mjs', () => ({
  createCategoryLogger: () => quiet,
}));

jest.unstable_mockModule('../../utils/utils.mjs', () => ({
  fileExists: exists,
  getCachedClipPath: (cacheKey, extension = '.mp4') => path.join(cacheDir, `${cacheKey}${extension}`),
}));

const getMovieByName = jest.fn();
const getTVShowByName = jest.fn();
jest.unstable_mockModule('../../sqliteDatabase.mjs', () => ({ getMovieByName, getTVShowByName }));

const resolveMovieVideo = jest.fn();
const resolveEpisodeVideo = jest.fn();
const findEpisodeEntry = jest.fn();
jest.unstable_mockModule('../../utils/mediaResolution.mjs', () => ({
  resolveMovieVideo,
  resolveEpisodeVideo,
  findEpisodeEntry,
}));

const getInfo = jest.fn();
jest.unstable_mockModule('../../infoManager.mjs', () => ({ getInfo }));

class ClipNotCopyableError extends Error {}
const probeClipSource = jest.fn();
const canCopyOriginal = jest.fn();
const transcodeClip = jest.fn();
const copyOriginalClip = jest.fn();
// The quality levels are the real ones: they are pure, and the handler's
// validation and cache names are about them.
const { resolveClipQuality, CLIP_QUALITY_VALUES } = await import('../../ffmpeg/clipEncode.mjs');
jest.unstable_mockModule('../../ffmpeg/clipEncode.mjs', () => ({
  probeClipSource,
  canCopyOriginal,
  transcodeClip,
  copyOriginalClip,
  ClipNotCopyableError,
  resolveClipQuality,
  CLIP_QUALITY_VALUES,
}));

const { handleVideoClipRequest } = await import('../../videoHandler.mjs');

const TRANSCODED = Buffer.from('h264 clip '.repeat(200));
const ORIGINAL = Buffer.from('original clip '.repeat(200));
const SOURCE = { codec: 'hevc', pixFmt: 'yuv420p10le', dovi: false, duration: 5400, startTime: 0 };

let server;
let origin;
let uuid;
let testNumber = 0;

beforeAll(async () => {
  const app = express();
  app.get('/videoClip/movie/:movieName', (req, res) => handleVideoClipRequest(req, res, 'movies', root));
  app.get('/videoClip/tv/:showName/:season/:episode', (req, res) => handleVideoClipRequest(req, res, 'tv', root));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  jest.clearAllMocks();
  await fs.rm(cacheDir, { recursive: true, force: true });
  await fs.mkdir(cacheDir);

  // A new file identity per test: the handler remembers probe results by uuid.
  testNumber += 1;
  uuid = `uuid-${testNumber}`;

  getMovieByName.mockImplementation(async (name) => (name === 'Missing' ? null : { name }));
  resolveMovieVideo.mockResolvedValue({ path: sourcePath });
  getTVShowByName.mockImplementation(async (name) => (name === 'Missing' ? null : { name, seasons: {} }));
  findEpisodeEntry.mockReturnValue({ episode: { filename: 'S01E02.mkv' } });
  resolveEpisodeVideo.mockResolvedValue({ path: sourcePath });
  getInfo.mockImplementation(async () => ({ uuid }));
  probeClipSource.mockResolvedValue(SOURCE);
  canCopyOriginal.mockReturnValue(true);
  transcodeClip.mockImplementation(async ({ outputPath }) => fs.writeFile(outputPath, TRANSCODED));
  copyOriginalClip.mockImplementation(async ({ outputPath }) => fs.writeFile(outputPath, ORIGINAL));
});

const clipUrl = (query = 'start=3200&end=3250', title = 'A Film') =>
  `${origin}/videoClip/movie/${encodeURIComponent(title)}?${query}`;
const body = async (response) => Buffer.from(await response.arrayBuffer());
const cached = () => fs.readdir(cacheDir);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transcode that finishes when the test says so. */
function heldTranscode() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  transcodeClip.mockImplementationOnce(async ({ outputPath }) => {
    await gate;
    await fs.writeFile(outputPath, TRANSCODED);
  });
  return release;
}

describe('request validation', () => {
  it('rejects a missing, reversed or negative time range', async () => {
    for (const query of ['', 'start=10', 'start=10&end=10', 'start=20&end=10', 'start=-5&end=10', 'start=a&end=b']) {
      const response = await fetch(clipUrl(query));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid start or end parameters.');
    }
    expect(transcodeClip).not.toHaveBeenCalled();
  });

  it('rejects a clip longer than ten minutes', async () => {
    const response = await fetch(clipUrl('start=0&end=601'));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('exceeds maximum allowed duration of 600 seconds');
  });

  it('rejects a codec it does not make, and accepts the two names for the one it does', async () => {
    const rejected = await fetch(clipUrl('start=0&end=10&codec=vp9'));
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toBe('Unsupported codec. Supported values: auto, h264.');

    expect((await fetch(clipUrl('start=0&end=10&codec=h264'))).status).toBe(200);
    expect((await fetch(clipUrl('start=0&end=10&codec=auto'))).status).toBe(200);
    // Both named the same clip: it was encoded once.
    expect(transcodeClip).toHaveBeenCalledTimes(1);
  });

  it('rejects a quality level it does not have', async () => {
    for (const value of ['best', '28', 'low&quality=low']) {
      const response = await fetch(clipUrl(`start=0&end=10&quality=${value}`));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Unsupported quality. Supported values: high, medium, low.');
    }
    expect(transcodeClip).not.toHaveBeenCalled();
  });

  it('rejects a clip that runs past the end of the video', async () => {
    probeClipSource.mockResolvedValue({ ...SOURCE, duration: 3240 });
    const response = await fetch(clipUrl('start=3200&end=3250'));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('End time exceeds video duration.');
    expect(transcodeClip).not.toHaveBeenCalled();
  });
});

describe('titles that are not there', () => {
  it('answers 404 for a movie the library does not have', async () => {
    const response = await fetch(clipUrl('start=0&end=10', 'Missing'));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: 'Movie not found: Missing',
      statusCode: 404,
      type: 'movies',
      details: { suggestion: 'Verify the media exists in the library' },
    });
  });

  it('answers 404 for an unknown show, and for an episode the show does not have', async () => {
    const noShow = await fetch(`${origin}/videoClip/tv/Missing/1/2?start=0&end=10`);
    expect(noShow.status).toBe(404);
    expect((await noShow.json()).error).toBe('Show not found: Missing');

    findEpisodeEntry.mockReturnValue(null);
    const noEpisode = await fetch(`${origin}/videoClip/tv/A%20Show/1/2?start=0&end=10`);
    expect(noEpisode.status).toBe(404);
    expect((await noEpisode.json()).error).toBe('Episode not found: A Show - Season 1 Episode 2');
  });

  it('answers 404 when the title is known but has no video file', async () => {
    resolveMovieVideo.mockResolvedValue(null);
    const response = await fetch(clipUrl());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Video not found.');
  });
});

describe('the encoded clip', () => {
  it('encodes on the first request and serves the cached file after that, without probing again', async () => {
    const first = await fetch(clipUrl());
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('video/mp4');
    expect(first.headers.get('accept-ranges')).toBe('bytes');
    expect(first.headers.get('cache-control')).toBe('public, max-age=31536000');
    expect((await body(first)).equals(TRANSCODED)).toBe(true);

    expect(transcodeClip).toHaveBeenCalledWith({
      videoPath: sourcePath,
      start: 3200,
      duration: 50,
      source: SOURCE,
      quality: 'high',
      outputPath: path.join(cacheDir, `A Film-key_${uuid}-start_3200-end_3250-v2-h264-high.mp4`),
    });

    const second = await fetch(clipUrl());
    expect((await body(second)).equals(TRANSCODED)).toBe(true);
    expect(transcodeClip).toHaveBeenCalledTimes(1);
    expect(probeClipSource).toHaveBeenCalledTimes(1);
  });

  it('serves a cached clip without touching ffprobe at all', async () => {
    await fs.writeFile(path.join(cacheDir, `A Film-key_${uuid}-start_3200-end_3250-v2-h264-high.mp4`), TRANSCODED);

    const response = await fetch(clipUrl());
    expect((await body(response)).equals(TRANSCODED)).toBe(true);
    expect(probeClipSource).not.toHaveBeenCalled();
    expect(transcodeClip).not.toHaveBeenCalled();
  });

  it('answers range requests against the cached clip', async () => {
    await fetch(clipUrl()).then(body);

    const probe = await fetch(clipUrl(), { headers: { Range: 'bytes=0-1' } });
    expect(probe.status).toBe(206);
    expect(probe.headers.get('content-range')).toBe(`bytes 0-1/${TRANSCODED.length}`);

    const tail = await fetch(clipUrl(), { headers: { Range: 'bytes=-10' } });
    expect(tail.status).toBe(206);
    expect((await body(tail)).equals(TRANSCODED.subarray(-10))).toBe(true);
  });

  it('makes every request wait for the finished clip, and encodes it once', async () => {
    const release = heldTranscode();

    const requests = Array.from({ length: 6 }, () => fetch(clipUrl()));
    // Long enough for all six to arrive while the encode is still running.
    await pause(150);
    expect(await cached()).toEqual([]); // nothing in the cache to be served early
    release();

    const responses = await Promise.all(requests);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe(String(TRANSCODED.length));
      expect((await body(response)).equals(TRANSCODED)).toBe(true);
    }
    expect(transcodeClip).toHaveBeenCalledTimes(1);
    expect(probeClipSource).toHaveBeenCalledTimes(1);
  });

  it('makes and caches each quality level separately, and treats no level as high', async () => {
    await fetch(clipUrl('start=3200&end=3250')).then(body);
    await fetch(clipUrl('start=3200&end=3250&quality=high')).then(body);
    await fetch(clipUrl('start=3200&end=3250&quality=LOW')).then(body);
    await fetch(clipUrl('start=3200&end=3250&quality=medium')).then(body);
    await fetch(clipUrl('start=3200&end=3250&quality=low')).then(body);

    expect(transcodeClip.mock.calls.map(([params]) => params.quality)).toEqual(['high', 'low', 'medium']);
    expect((await cached()).sort()).toEqual([
      `A Film-key_${uuid}-start_3200-end_3250-v2-h264-high.mp4`,
      `A Film-key_${uuid}-start_3200-end_3250-v2-h264-low.mp4`,
      `A Film-key_${uuid}-start_3200-end_3250-v2-h264-medium.mp4`,
    ]);
    // One source, probed once for all three.
    expect(probeClipSource).toHaveBeenCalledTimes(1);
  });

  it('keys the cache on the file identity, so a replaced video gets new clips', async () => {
    await fetch(clipUrl()).then(body);
    uuid = `${uuid}-replaced`;
    await fetch(clipUrl()).then(body);

    expect(transcodeClip).toHaveBeenCalledTimes(2);
    expect((await cached()).length).toBe(2);
  });

  it('answers 422 when the encode fails, and tries again on the next request', async () => {
    transcodeClip.mockRejectedValueOnce(new Error('FFmpeg exited with code 1: Conversion failed!'));

    const failed = await fetch(clipUrl());
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({
      error: 'Video encoding error',
      statusCode: 422,
      type: 'movies',
      details: { hint: 'Try using ?useOriginalVideo=true to serve without re-encoding' },
    });

    const retried = await fetch(clipUrl());
    expect(retried.status).toBe(200);
    expect(transcodeClip).toHaveBeenCalledTimes(2);
  });

  it('refuses to cache a clip of a file it cannot identify', async () => {
    getInfo.mockResolvedValue({});
    const response = await fetch(clipUrl());
    expect(response.status).toBe(422);
    expect(transcodeClip).not.toHaveBeenCalled();
  });

  it('drops a queued encode whose only viewer has gone, and keeps the one that is running', async () => {
    const release = heldTranscode();
    const running = fetch(clipUrl('start=100&end=150'));
    await pause(100); // the first encode now holds the only slot

    const abandoned = new AbortController();
    const queued = fetch(clipUrl('start=200&end=250'), { signal: abandoned.signal }).catch((error) => error);
    await pause(100);
    abandoned.abort();
    expect((await queued).name).toBe('AbortError');
    await pause(400); // let the server notice the disconnect, with room for a busy CI box

    release();
    expect((await running).status).toBe(200);
    await pause(100);

    expect(transcodeClip).toHaveBeenCalledTimes(1);
    expect(await cached()).toEqual([`A Film-key_${uuid}-start_100-end_150-v2-h264-high.mp4`]);
  });

  it('serves a TV episode clip under the show title', async () => {
    const response = await fetch(`${origin}/videoClip/tv/A%20Show/1/2?start=600&end=650`);
    expect(response.status).toBe(200);
    expect(resolveEpisodeVideo).toHaveBeenCalledWith({
      basePath: root, showName: 'A Show', season: '1', episode: '2', preferFilename: 'S01E02.mkv',
    });
    expect(await cached()).toEqual([`A Show-key_${uuid}-start_600-end_650-v2-h264-high.mp4`]);
  });
});

describe('the original-quality clip (?useOriginalVideo=true)', () => {
  const originalUrl = (query = 'start=3200&end=3250') => clipUrl(`${query}&useOriginalVideo=true`);

  it('copies the source once, caches it, and serves it with ranges', async () => {
    const first = await fetch(originalUrl());
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('video/mp4');
    expect((await body(first)).equals(ORIGINAL)).toBe(true);
    // The name clearOriginalSegmentsCache (utils.mjs) evicts by.
    expect(await cached()).toEqual([`A Film-key_${uuid}-start_3200-end_3250-v2-original.mp4`]);

    // A request with no Range header, which is what the TV app's are in the
    // production logs, is served from the cache too. It used to re-run ffmpeg
    // into the socket every time.
    const again = await fetch(originalUrl());
    expect((await body(again)).equals(ORIGINAL)).toBe(true);
    const ranged = await fetch(originalUrl(), { headers: { Range: 'bytes=0-1' } });
    expect(ranged.status).toBe(206);

    expect(copyOriginalClip).toHaveBeenCalledTimes(1);
    expect(transcodeClip).not.toHaveBeenCalled();
  });

  it('sends the encoded clip when the source is not something to copy', async () => {
    canCopyOriginal.mockReturnValue(false);

    const response = await fetch(originalUrl());
    expect(response.status).toBe(200);
    expect((await body(response)).equals(TRANSCODED)).toBe(true);
    expect(copyOriginalClip).not.toHaveBeenCalled();
  });

  it('uses the requested quality level for that fallback, and for nothing else', async () => {
    // A copy has no levels: the same original-quality file answers every one.
    await fetch(originalUrl('start=100&end=150&quality=low')).then(body);
    await fetch(originalUrl('start=100&end=150&quality=high')).then(body);
    expect(copyOriginalClip).toHaveBeenCalledTimes(1);
    expect(await cached()).toEqual([`A Film-key_${uuid}-start_100-end_150-v2-original.mp4`]);

    canCopyOriginal.mockReturnValue(false);
    const response = await fetch(originalUrl('start=200&end=250&quality=low'));
    expect((await body(response)).equals(TRANSCODED)).toBe(true);
    expect(transcodeClip).toHaveBeenCalledWith(expect.objectContaining({ start: 200, quality: 'low' }));
  });

  it('sends the encoded clip when the copy finds no keyframe to start on', async () => {
    copyOriginalClip.mockRejectedValue(new ClipNotCopyableError('no usable keyframe'));

    const response = await fetch(originalUrl());
    expect(response.status).toBe(200);
    expect((await body(response)).equals(TRANSCODED)).toBe(true);
  });

  it('sends the encoded clip, and reports the failure, when the copy itself fails', async () => {
    copyOriginalClip.mockRejectedValue(new Error('FFmpeg exited with code 1: muxing failed'));

    const response = await fetch(originalUrl());
    expect(response.status).toBe(200);
    expect((await body(response)).equals(TRANSCODED)).toBe(true);
    expect(quiet.error).toHaveBeenCalledWith(expect.stringContaining('failed, sending the transcode'));
  });

  it('does not repeat a copy that has just failed: the next requests go straight to the encoded clip', async () => {
    copyOriginalClip.mockRejectedValue(new Error('FFmpeg exited with code 1: muxing failed'));

    for (let request = 0; request < 3; request += 1) {
      const response = await fetch(originalUrl());
      expect(response.status).toBe(200);
      expect((await body(response)).equals(TRANSCODED)).toBe(true);
    }

    expect(copyOriginalClip).toHaveBeenCalledTimes(1);
    expect(quiet.error).toHaveBeenCalledTimes(1);
    expect(transcodeClip).toHaveBeenCalledTimes(1);

    // A different stretch of the same film is a different copy, and is tried.
    await fetch(originalUrl('start=100&end=150')).then(body);
    expect(copyOriginalClip).toHaveBeenCalledTimes(2);
  });

  it('limits how long an original-quality clip may be', async () => {
    const response = await fetch(originalUrl('start=0&end=121'));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Original-quality clips are limited to 120 seconds.');
    expect(copyOriginalClip).not.toHaveBeenCalled();
  });

  it('does not wait behind an encode: copies have their own lane', async () => {
    const release = heldTranscode();
    const encoding = fetch(clipUrl('start=100&end=150'));
    await pause(100); // the only encode slot is taken

    const copy = await fetch(originalUrl('start=200&end=250'));
    expect(copy.status).toBe(200);
    expect((await body(copy)).equals(ORIGINAL)).toBe(true);

    release();
    expect((await encoding).status).toBe(200);
  });
});
