/**
 * Route order for the search endpoints: /search/collection must reach its
 * own handler (searchCollections). Registered after /search/:type, it was
 * captured as type "collection" and answered from searchMedia instead, so
 * the collection handler never ran. /search/movie and /search/tv must still
 * reach searchMedia.
 *
 * Runs the real router on an ephemeral port with the auth middleware and the
 * TMDB client mocked.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';

const searchMedia = jest.fn();
const searchCollections = jest.fn();

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
  searchMedia,
  getMediaDetails: jest.fn(),
  getMediaCast: jest.fn(),
  getStructuredMediaCast: jest.fn(),
  getMediaVideos: jest.fn(),
  getMediaImages: jest.fn(),
  getMediaRating: jest.fn(),
  getEpisodeDetails: jest.fn(),
  getEpisodeImages: jest.fn(),
  fetchComprehensiveMediaDetails: jest.fn(),
  searchCollections,
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
  searchMedia.mockReset();
  searchCollections.mockReset();
});

describe('search route dispatch', () => {
  it('sends /search/collection to the collection handler', async () => {
    const collections = { page: 2, results: [{ id: 10, name: 'Star Wars Collection' }] };
    searchCollections.mockResolvedValue(collections);

    const res = await fetch(`${baseUrl}/api/tmdb/search/collection?query=star%20wars&page=2&blurhash=true`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(collections);
    expect(searchCollections).toHaveBeenCalledWith('star wars', '2', true);
    expect(searchMedia).not.toHaveBeenCalled();
  });

  it.each(['movie', 'tv'])('still sends /search/%s to searchMedia', async (type) => {
    searchMedia.mockResolvedValue({ page: 1, results: [] });

    const res = await fetch(`${baseUrl}/api/tmdb/search/${type}?query=alien`);

    expect(res.status).toBe(200);
    expect(searchMedia).toHaveBeenCalledWith(type, 'alien', 1, false);
    expect(searchCollections).not.toHaveBeenCalled();
  });
});
