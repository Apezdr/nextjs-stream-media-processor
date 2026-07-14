/**
 * Contract tests for the content-ETag layer on the TMDB JSON GET endpoints
 * (sendJsonWithETag in routes/tmdb.mjs): a weak ETag derived from the payload
 * with server-stamped volatile fields (_cached/_cachedAt/_expiresAt/_etag/
 * _notModified/last_updated) excluded from the hash — but NOT from the body —
 * and a bodyless 304 when If-None-Match matches.
 *
 * The load-bearing case is the volatile-drift regression: identical content
 * served via different cache paths (fresh fetch vs SQLite hit vs TMDB 304
 * re-up) must produce the SAME ETag, or the ~10s Next.js proxy polls never
 * revalidate and every response re-ships the full payload.
 *
 * Runs the real router on an ephemeral port with the auth middleware and
 * data layers mocked.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';

const fetchComprehensiveMediaDetails = jest.fn();
const getMediaDetails = jest.fn();
const getMediaCast = jest.fn();
const getMediaVideos = jest.fn();
const getMediaImages = jest.fn();
const getMediaRating = jest.fn();
const getEpisodeDetails = jest.fn();
const getEpisodeImages = jest.fn();

jest.unstable_mockModule('../../../middleware/auth.mjs', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { email: 'user@test' };
    next();
  },
  requireAdmin: (req, res, next) => next(),
  requireFullAccess: (req, res, next) => next(),
  createRateLimiter: () => (req, res, next) => next(),
}));

jest.unstable_mockModule('../../../utils/tmdb.mjs', () => ({
  searchMedia: jest.fn(),
  getMediaDetails,
  getMediaCast,
  getStructuredMediaCast: jest.fn(),
  getMediaVideos,
  getMediaImages,
  getMediaRating,
  getEpisodeDetails,
  getEpisodeImages,
  fetchComprehensiveMediaDetails,
  searchCollections: jest.fn(),
  getCollectionDetails: jest.fn(),
  getCollectionImages: jest.fn(),
  fetchEnhancedCollectionData: jest.fn(),
  makeTmdbRequest: jest.fn(),
}));

jest.unstable_mockModule('../../../sqliteDatabase.mjs', () => ({
  initializeDatabase: jest.fn(),
  releaseDatabase: jest.fn(),
  getTmdbCacheStats: jest.fn(),
  clearTmdbCache: jest.fn(),
  clearExpiredTmdbCache: jest.fn(),
  refreshTmdbCacheEntry: jest.fn(),
}));

let server;
let baseUrl;

beforeAll(async () => {
  const { setupTmdbRoutes } = await import('../../../routes/tmdb.mjs');
  const express = (await import('express')).default;
  const app = express();
  app.use('/api/tmdb', setupTmdbRoutes());
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  for (const fn of [
    fetchComprehensiveMediaDetails,
    getMediaDetails,
    getMediaCast,
    getMediaVideos,
    getMediaImages,
    getMediaRating,
    getEpisodeDetails,
    getEpisodeImages,
  ]) {
    fn.mockReset();
  }
});

const getComprehensive = (headers = {}) =>
  fetch(`${baseUrl}/api/tmdb/comprehensive/movie?tmdb_id=603`, { headers });

// One shared content object, spread FIRST in every mock shape: the ETag hash
// is JSON.stringify-order-sensitive by design (stability comes from the
// identical per-request construction path, not canonicalization), so the
// content keys must be written once, in one order, or the equal-ETags
// assertions below would be flaky by construction.
const CONTENT = {
  id: 603,
  title: 'The Matrix',
  overview: 'A computer hacker learns about the true nature of reality.',
  cast: [{ id: 6384, name: 'Keanu Reeves', character: 'Neo' }],
  trailer_url: 'https://www.youtube.com/watch?v=abc123',
  rating: 'R',
};

// The three shapes makeTmdbRequest bookkeeping takes, leaked into the payload
// root via fetchComprehensiveMediaDetails' `...details` spread, plus the
// per-request last_updated stamp.
const freshFetchShape = () => ({
  ...CONTENT,
  last_updated: '2026-07-13T10:00:00.000Z',
  _cached: false,
  _cachedAt: '2026-07-13T10:00:00.000Z',
  _etag: 'W/"upstream-tag-1"',
});

const cacheHitShape = () => ({
  ...CONTENT,
  last_updated: '2026-07-13T10:05:00.000Z',
  _cached: true,
  _cachedAt: '2026-07-13T10:00:00.000Z',
  _expiresAt: '2026-07-14T10:00:00.000Z',
});

const reUpShape = () => ({
  ...CONTENT,
  last_updated: '2026-07-13T10:10:00.000Z',
  _cached: true,
  _cachedAt: '2026-07-13T10:00:00.000Z',
  _expiresAt: '2026-07-15T10:00:00.000Z',
  _notModified: true,
});

describe('GET /api/tmdb/comprehensive/:type content ETag', () => {
  it('serves identical content with an identical ETag across all three cache-path shapes', async () => {
    fetchComprehensiveMediaDetails
      .mockResolvedValueOnce(freshFetchShape())
      .mockResolvedValueOnce(cacheHitShape())
      .mockResolvedValueOnce(reUpShape());

    const first = await getComprehensive();
    const second = await getComprehensive();
    const third = await getComprehensive();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(second.headers.get('etag')).toBe(etag);
    expect(third.headers.get('etag')).toBe(etag);
  });

  it('answers a matching If-None-Match with a bodyless 304 that still carries the ETag', async () => {
    fetchComprehensiveMediaDetails
      .mockResolvedValueOnce(freshFetchShape())
      .mockResolvedValueOnce(cacheHitShape());

    const first = await getComprehensive();
    const etag = first.headers.get('etag');

    const replay = await getComprehensive({ 'If-None-Match': etag });
    expect(replay.status).toBe(304);
    expect(await replay.text()).toBe('');
    expect(replay.headers.get('etag')).toBe(etag);
  });

  it('keeps the volatile fields in the 200 body (hash-input-only exclusion)', async () => {
    fetchComprehensiveMediaDetails.mockResolvedValueOnce(cacheHitShape());

    const res = await getComprehensive();
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{32}"$/);

    const body = await res.json();
    expect(body).toMatchObject({
      id: 603,
      title: 'The Matrix',
      last_updated: '2026-07-13T10:05:00.000Z',
      _cached: true,
      _cachedAt: '2026-07-13T10:00:00.000Z',
      _expiresAt: '2026-07-14T10:00:00.000Z',
    });
  });

  it('returns fresh 200 content with a new ETag when the content actually changes', async () => {
    fetchComprehensiveMediaDetails
      .mockResolvedValueOnce(freshFetchShape())
      .mockResolvedValueOnce({ ...cacheHitShape(), title: 'The Matrix Reloaded' });

    const first = await getComprehensive();
    const staleTag = first.headers.get('etag');

    const replay = await getComprehensive({ 'If-None-Match': staleTag });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('etag')).not.toBe(staleTag);
    const body = await replay.json();
    expect(body.title).toBe('The Matrix Reloaded');
  });

  it('ignores a non-matching If-None-Match and sends the full body', async () => {
    fetchComprehensiveMediaDetails.mockResolvedValueOnce(cacheHitShape());

    const res = await getComprehensive({ 'If-None-Match': 'W/"0000feed0000"' });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(603);
  });

  it('matches its tag inside a multi-tag list and in strong (non-W/) form', async () => {
    fetchComprehensiveMediaDetails
      .mockResolvedValueOnce(freshFetchShape())
      .mockResolvedValueOnce(cacheHitShape())
      .mockResolvedValueOnce(reUpShape());

    const first = await getComprehensive();
    const etag = first.headers.get('etag');

    const listReplay = await getComprehensive({ 'If-None-Match': `W/"aaa", ${etag}` });
    expect(listReplay.status).toBe(304);

    const strongTag = etag.replace(/^W\//, '');
    const strongReplay = await getComprehensive({ 'If-None-Match': strongTag });
    expect(strongReplay.status).toBe(304);
  });

  it('never converts an error response into a 304', async () => {
    // Missing name/tmdb_id -> 400 before any fetch; a stale client tag along
    // for the ride must not matter (ETag handling is success-path only).
    const res = await fetch(`${baseUrl}/api/tmdb/comprehensive/movie`, {
      headers: { 'If-None-Match': 'W/"deadbeefdeadbeefdeadbeefdeadbeef"' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Either name or tmdb_id parameter is required' });
    expect(fetchComprehensiveMediaDetails).not.toHaveBeenCalled();
  });
});

describe('content ETag on the other single-resource TMDB GET endpoints', () => {
  it('revalidates a bare-array payload (/cast) with a 304', async () => {
    const cast = [{ id: 6384, name: 'Keanu Reeves', character: 'Neo' }];
    getMediaCast.mockResolvedValue(cast);

    const first = await fetch(`${baseUrl}/api/tmdb/cast/movie?tmdb_id=603`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
    const body = await first.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual(cast);

    const replay = await fetch(`${baseUrl}/api/tmdb/cast/movie?tmdb_id=603`, {
      headers: { 'If-None-Match': etag },
    });
    expect(replay.status).toBe(304);
    expect(await replay.text()).toBe('');
  });

  it.each([
    ['/details/movie?tmdb_id=603', getMediaDetails, () => cacheHitShape()],
    ['/videos/movie?tmdb_id=603', getMediaVideos, () => ({ trailer_url: 'https://youtu.be/x', videos: [] })],
    ['/images/movie?tmdb_id=603', getMediaImages, () => ({ logo_path: null, backdrops: [], posters: [], logos: [] })],
    ['/rating/movie?tmdb_id=603', getMediaRating, () => ({ rating: 'R' })],
    ['/episode?tmdb_id=1399&season=1&episode=1', getEpisodeDetails, () => cacheHitShape()],
    ['/episode/images?tmdb_id=1399&season=1&episode=1', getEpisodeImages, () => ({ thumbnail_url: null, stills: [] })],
  ])('emits a weak content ETag on %s', async (path, mock, payload) => {
    mock.mockResolvedValue(payload());

    const res = await fetch(`${baseUrl}/api/tmdb${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{32}"$/);
  });
});
