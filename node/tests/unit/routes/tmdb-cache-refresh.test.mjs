/**
 * Branch 9 (A-3) contract tests for POST /api/tmdb/cache/refresh: the
 * endpoint must actually refetch (delete the stale row, then call
 * makeTmdbRequest with forceRefresh so the fresh response re-caches), not
 * just delete. Pins the response contract (`refreshed` keeps its original
 * "a row existed" meaning; `fetched` reports the eager refetch) and the
 * 502 path when the TMDB refetch fails after the delete.
 *
 * Runs the real router on an ephemeral port with the auth middleware and
 * data layers mocked.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';

const refreshTmdbCacheEntry = jest.fn();
const makeTmdbRequest = jest.fn();

jest.unstable_mockModule('../../../middleware/auth.mjs', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { email: 'admin@test' };
    next();
  },
  requireAdmin: (req, res, next) => next(),
  requireFullAccess: (req, res, next) => next(),
  createRateLimiter: () => (req, res, next) => next(),
}));

jest.unstable_mockModule('../../../utils/tmdb.mjs', () => ({
  searchMedia: jest.fn(),
  getMediaDetails: jest.fn(),
  getMediaCast: jest.fn(),
  getStructuredMediaCast: jest.fn(),
  getMediaVideos: jest.fn(),
  getMediaImages: jest.fn(),
  getMediaRating: jest.fn(),
  getEpisodeDetails: jest.fn(),
  getEpisodeImages: jest.fn(),
  fetchComprehensiveMediaDetails: jest.fn(),
  searchCollections: jest.fn(),
  getCollectionDetails: jest.fn(),
  getCollectionImages: jest.fn(),
  fetchEnhancedCollectionData: jest.fn(),
  makeTmdbRequest,
}));

jest.unstable_mockModule('../../../sqliteDatabase.mjs', () => ({
  initializeDatabase: jest.fn(),
  releaseDatabase: jest.fn(),
  getTmdbCacheStats: jest.fn(async () => ({ total: 0 })),
  clearTmdbCache: jest.fn(),
  clearExpiredTmdbCache: jest.fn(),
  refreshTmdbCacheEntry,
}));

let server;
let baseUrl;

beforeAll(async () => {
  const { setupTmdbRoutes } = await import('../../../routes/tmdb.mjs');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
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
  refreshTmdbCacheEntry.mockReset();
  makeTmdbRequest.mockReset();
});

const postRefresh = (body) =>
  fetch(`${baseUrl}/api/tmdb/cache/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/tmdb/cache/refresh (A-3 eager refetch)', () => {
  it('rejects a missing endpoint with 400 and touches nothing', async () => {
    const res = await postRefresh({});
    expect(res.status).toBe(400);
    expect(refreshTmdbCacheEntry).not.toHaveBeenCalled();
    expect(makeTmdbRequest).not.toHaveBeenCalled();
  });

  it('drops the stale row, then refetches with forceRefresh and re-caches', async () => {
    refreshTmdbCacheEntry.mockResolvedValue(true);
    makeTmdbRequest.mockResolvedValue({ id: 42 });

    const res = await postRefresh({ endpoint: '/movie/42', params: { language: 'en-US' } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, refreshed: true, fetched: true });

    expect(refreshTmdbCacheEntry).toHaveBeenCalledWith('/movie/42', { language: 'en-US' });
    expect(makeTmdbRequest).toHaveBeenCalledWith('/movie/42', { language: 'en-US' }, 3, 1440, true);
    // Delete first, fetch second — the refetch's setTmdbCache upsert must be
    // the last writer so the fresh row survives.
    expect(refreshTmdbCacheEntry.mock.invocationCallOrder[0]).toBeLessThan(
      makeTmdbRequest.mock.invocationCallOrder[0]
    );
  });

  it('still refetches when no cached row existed (refreshed=false)', async () => {
    refreshTmdbCacheEntry.mockResolvedValue(false);
    makeTmdbRequest.mockResolvedValue({ id: 7 });

    const res = await postRefresh({ endpoint: '/tv/7' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, refreshed: false, fetched: true });
    expect(makeTmdbRequest).toHaveBeenCalledWith('/tv/7', {}, 3, 1440, true);
  });

  it('returns 502 with fetched=false when the TMDB refetch fails after the delete', async () => {
    refreshTmdbCacheEntry.mockResolvedValue(true);
    makeTmdbRequest.mockRejectedValue(new Error('TMDB API request failed after 3 retries'));

    const res = await postRefresh({ endpoint: '/movie/42' });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toMatchObject({ success: false, refreshed: true, fetched: false });
    expect(body.error).toContain('refetch failed');
  });
});
