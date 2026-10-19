/**
 * The search endpoint: /search/movie and /search/tv reach searchMedia. The
 * /search/collection route was removed in P2 (no caller); that path now goes
 * to searchMedia as type "collection", which the real client rejects as an
 * invalid request (400).
 *
 * Runs the real router on an ephemeral port with the auth middleware and the
 * TMDB client mocked.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { TmdbInvalidRequestError } from '../../../utils/tmdbErrors.mjs';

const searchMedia = jest.fn();

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
  getMediaImages: jest.fn(),
  getEpisodeImages: jest.fn(),
  fetchComprehensiveMediaDetails: jest.fn(),
  getCollectionDetails: jest.fn(),
  fetchEnhancedCollectionData: jest.fn(),
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
});

describe('search route dispatch', () => {
  it.each(['movie', 'tv'])('still sends /search/%s to searchMedia', async (type) => {
    searchMedia.mockResolvedValue({ page: 1, results: [] });

    const res = await fetch(`${baseUrl}/api/tmdb/search/${type}?query=alien`);

    expect(res.status).toBe(200);
    expect(searchMedia).toHaveBeenCalledWith(type, 'alien', 1, false);
  });

  it('sends /search/collection to searchMedia, whose type check answers 400', async () => {
    // The real client's check, which this mock stands in for.
    searchMedia.mockRejectedValue(new TmdbInvalidRequestError('Type must be "movie" or "tv"'));

    const res = await fetch(`${baseUrl}/api/tmdb/search/collection?query=star%20wars`);

    expect(res.status).toBe(400);
    expect(searchMedia).toHaveBeenCalledWith('collection', 'star wars', 1, false);
  });
});
