/**
 * Contract tests for how the TMDB GET routes answer a failure
 * (sendTmdbError → classifyTmdbError): TMDB's own verdict instead of a blanket
 * 400, so callers can give up on a title TMDB doesn't have (404
 * TMDB_NOT_FOUND) and retry an outage (502 TMDB_UNAVAILABLE, 429
 * TMDB_RATE_LIMITED with Retry-After). Parameter errors stay 400; anything
 * else is this server's bug and answers 500.
 *
 * Runs the real router on an ephemeral port with the auth middleware and the
 * TMDB client mocked; the error classes are the real ones.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import {
  TmdbInvalidRequestError,
  TmdbNoMatchError,
  TmdbRequestError,
} from '../../../utils/tmdbErrors.mjs';

const client = {
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
  makeTmdbRequest: jest.fn(),
};

jest.unstable_mockModule('../../../middleware/auth.mjs', () => ({
  authenticateUser: (req, res, next) => {
    req.user = { email: 'user@test' };
    next();
  },
  requireAdmin: (req, res, next) => next(),
  requireFullAccess: (req, res, next) => next(),
  createRateLimiter: () => (req, res, next) => next(),
}));

jest.unstable_mockModule('../../../utils/tmdb.mjs', () => client);

const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../lib/logger.mjs', () => ({
  createCategoryLogger: () => log,
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
  for (const fn of Object.values(client)) fn.mockReset();
  for (const fn of Object.values(log)) fn.mockClear();
});

const tmdbFailure = (status, extra = {}) =>
  new TmdbRequestError(`TMDB API request failed: Request failed with status code ${status}`, {
    endpoint: '/tv/275188',
    status,
    ...extra,
  });

const COMPREHENSIVE = '/comprehensive/tv?tmdb_id=275188';

describe('GET /api/tmdb/comprehensive/:type failure answers', () => {
  it('answers a TMDB 404 with 404 TMDB_NOT_FOUND', async () => {
    client.fetchComprehensiveMediaDetails.mockRejectedValue(tmdbFailure(404));

    const res = await fetch(`${baseUrl}/api/tmdb${COMPREHENSIVE}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'TMDB API request failed: Request failed with status code 404',
      code: 'TMDB_NOT_FOUND',
    });
  });

  it('answers a name search with no match with 404 TMDB_NOT_FOUND', async () => {
    client.fetchComprehensiveMediaDetails.mockRejectedValue(
      new TmdbNoMatchError('No results found for tv: Nothing Like It'),
    );

    const res = await fetch(`${baseUrl}/api/tmdb/comprehensive/tv?name=Nothing%20Like%20It`);

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('TMDB_NOT_FOUND');
  });

  it('still answers 400 with no code when neither name nor tmdb_id is given', async () => {
    const res = await fetch(`${baseUrl}/api/tmdb/comprehensive/tv`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Either name or tmdb_id parameter is required' });
    expect(client.fetchComprehensiveMediaDetails).not.toHaveBeenCalled();
  });

  it('answers invalid parameters caught by the client with 400 and no code', async () => {
    client.fetchComprehensiveMediaDetails.mockRejectedValue(
      new TmdbInvalidRequestError('Type must be "movie" or "tv"'),
    );

    const res = await fetch(`${baseUrl}/api/tmdb/comprehensive/film?tmdb_id=1`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Type must be "movie" or "tv"' });
  });

  it('answers a TMDB 429 with 429 TMDB_RATE_LIMITED and Retry-After', async () => {
    client.fetchComprehensiveMediaDetails.mockRejectedValue(tmdbFailure(429, { retryAfter: 7 }));

    const res = await fetch(`${baseUrl}/api/tmdb${COMPREHENSIVE}`);

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect((await res.json()).code).toBe('TMDB_RATE_LIMITED');
  });

  it.each([
    ['a TMDB 5xx', 503],
    ['no response from TMDB', null],
    ['TMDB refusing our key', 401],
  ])('answers %s with 502 TMDB_UNAVAILABLE', async (label, status) => {
    client.fetchComprehensiveMediaDetails.mockRejectedValue(tmdbFailure(status));

    const res = await fetch(`${baseUrl}/api/tmdb${COMPREHENSIVE}`);

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('TMDB_UNAVAILABLE');
  });

  it('answers a bug in this server with 500 and no code', async () => {
    client.fetchComprehensiveMediaDetails.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'id')"),
    );

    const res = await fetch(`${baseUrl}/api/tmdb${COMPREHENSIVE}`);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Cannot read properties of undefined (reading 'id')" });
  });
});

describe('failure log level', () => {
  it('logs an expected 404 as a warning with readable fields and no stack', async () => {
    client.fetchComprehensiveMediaDetails.mockRejectedValue(tmdbFailure(404, { cached: true }));

    await fetch(`${baseUrl}/api/tmdb${COMPREHENSIVE}`);

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('Comprehensive details error:', {
      status: 404,
      code: 'TMDB_NOT_FOUND',
      endpoint: '/tv/275188',
      error: 'TMDB API request failed: Request failed with status code 404',
    });
  });

  it('logs a TMDB outage as an error with the Error itself', async () => {
    const outage = tmdbFailure(503);
    client.fetchComprehensiveMediaDetails.mockRejectedValue(outage);

    await fetch(`${baseUrl}/api/tmdb${COMPREHENSIVE}`);

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('Comprehensive details error:', outage);
  });
});

describe('every TMDB GET route maps failures the same way', () => {
  it.each([
    ['/search/tv?query=x', 'searchMedia'],
    [COMPREHENSIVE, 'fetchComprehensiveMediaDetails'],
    ['/details/tv?tmdb_id=275188', 'getMediaDetails'],
    ['/cast/tv?tmdb_id=275188', 'getMediaCast'],
    ['/structured-cast/tv?tmdb_id=275188', 'getStructuredMediaCast'],
    ['/videos/tv?tmdb_id=275188', 'getMediaVideos'],
    ['/images/tv?tmdb_id=275188', 'getMediaImages'],
    ['/rating/tv?tmdb_id=275188', 'getMediaRating'],
    ['/episode?tmdb_id=275188&season=1&episode=1', 'getEpisodeDetails'],
    ['/episode/images?tmdb_id=275188&season=1&episode=1', 'getEpisodeImages'],
    ['/search/collection?query=x', 'searchCollections'],
    ['/collection?tmdb_id=10', 'getCollectionDetails'],
    ['/collection?tmdb_id=10&enhanced=true', 'fetchEnhancedCollectionData'],
    ['/collection/images?tmdb_id=10', 'getCollectionImages'],
  ])('%s answers a TMDB 404 with 404 TMDB_NOT_FOUND', async (path, fnName) => {
    client[fnName].mockRejectedValue(tmdbFailure(404));

    const res = await fetch(`${baseUrl}/api/tmdb${path}`);

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('TMDB_NOT_FOUND');
  });
});
