/**
 * Branch 7 behavior tests for makeTmdbRequest (utils/tmdb.mjs) with the HTTP
 * and cache layers mocked:
 *  - T-1: an expired row's stored ETag rides out as If-None-Match, a 304
 *    re-ups the row (setTmdbCache with the same etag) and returns the cached
 *    payload without transfer
 *  - fresh 200 responses persist their captured ETag
 *  - T-5: 5xx and connection-level errors (ECONNRESET) retry with backoff;
 *    non-retryable HTTP errors still fail fast
 *  - cache hits return without touching the network or the revalidation path
 *  - failures keep TMDB's status (and Retry-After) on the thrown error
 *  - a TMDB 404 is remembered for a day and answered without a network call
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'test-key';

const axiosGet = jest.fn();
jest.unstable_mockModule('axios', () => ({
  default: { get: axiosGet },
}));

const getTmdbCache = jest.fn();
const getTmdbCacheEntryAnyAge = jest.fn();
const setTmdbCache = jest.fn(async () => true);
jest.unstable_mockModule('../../../sqliteDatabase.mjs', () => ({
  getTmdbCache,
  getTmdbCacheEntryAnyAge,
  setTmdbCache,
  withWriteTx: jest.fn(async () => {}),
}));

// Pass-through tracer wrappers — behavior under test lives in tmdb.mjs.
jest.unstable_mockModule('../../../lib/apiTracer.mjs', () => ({
  withApiRequestSpan: (opts, fn) => fn(),
  withApiCacheSpan: (opts, fn) => fn(),
}));

jest.unstable_mockModule('../../../utils/tmdbBlurhash.mjs', () => ({
  generateBlurhashCacheKey: () => null,
  enhanceTmdbResponseWithBlurhash: jest.fn(async (d) => d),
}));

const { makeTmdbRequest, TmdbRequestError } = await import('../../../utils/tmdb.mjs');
const { withWriteTx } = await import('../../../sqliteDatabase.mjs');

beforeEach(() => {
  axiosGet.mockReset();
  getTmdbCache.mockReset().mockResolvedValue(null);
  getTmdbCacheEntryAnyAge.mockReset().mockResolvedValue(null);
  setTmdbCache.mockReset().mockResolvedValue(true);
  withWriteTx.mockClear();
});

const httpError = (status, headers = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, headers } });

const NOT_FOUND_KEY = '/tv/275188_{}_notfound';

describe('T-1 conditional revalidation', () => {
  it('sends the expired row\'s ETag as If-None-Match and re-ups the row on 304', async () => {
    getTmdbCacheEntryAnyAge.mockResolvedValue({
      data: { id: 7, name: 'Stale But Valid' },
      etag: 'W/"abc"',
      cachedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-03-01T00:00:00.000Z',
      expired: true,
    });
    axiosGet.mockResolvedValue({ status: 304, headers: {} });

    const result = await makeTmdbRequest('/tv/7', {});

    expect(axiosGet).toHaveBeenCalledTimes(1);
    const [, axiosOpts] = axiosGet.mock.calls[0];
    expect(axiosOpts.headers['If-None-Match']).toBe('W/"abc"');

    // Row re-upped under the same etag: last arg of setTmdbCache.
    expect(setTmdbCache).toHaveBeenCalledTimes(1);
    const setArgs = setTmdbCache.mock.calls[0];
    expect(setArgs[0]).toBe('/tv/7');
    expect(setArgs[2]).toEqual({ id: 7, name: 'Stale But Valid' });
    expect(setArgs[5]).toBe('W/"abc"');

    expect(result).toMatchObject({ id: 7, _cached: true, _notModified: true });
  });

  it('persists the captured ETag on a fresh 200', async () => {
    axiosGet.mockResolvedValue({ status: 200, data: { id: 9 }, headers: { etag: 'W/"fresh"' } });

    const result = await makeTmdbRequest('/movie/9', {});

    // No stored row → no If-None-Match header sent.
    const [, axiosOpts] = axiosGet.mock.calls[0];
    expect(axiosOpts.headers['If-None-Match']).toBeUndefined();

    const setArgs = setTmdbCache.mock.calls[0];
    expect(setArgs[5]).toBe('W/"fresh"');
    expect(result).toMatchObject({ id: 9, _cached: false, _etag: 'W/"fresh"' });
  });
});

describe('T-5 transient-error retry', () => {
  it('retries a 5xx response and succeeds on the second attempt', async () => {
    axiosGet
      .mockRejectedValueOnce(Object.assign(new Error('upstream boom'), { response: { status: 503, headers: {} } }))
      .mockResolvedValueOnce({ status: 200, data: { id: 1 }, headers: {} });

    const result = await makeTmdbRequest('/movie/1', {});

    expect(axiosGet).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ id: 1 });
  });

  it('retries ECONNRESET and succeeds on the second attempt', async () => {
    axiosGet
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ status: 200, data: { id: 2 }, headers: {} });

    const result = await makeTmdbRequest('/movie/2', {});

    expect(axiosGet).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ id: 2 });
  });

  it('still fails fast on a non-retryable HTTP error', async () => {
    axiosGet.mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, headers: {} } }));

    await expect(makeTmdbRequest('/movie/404', {})).rejects.toThrow(/TMDB API request failed/);
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });
});

describe('TMDB status on thrown errors', () => {
  it('keeps TMDB\'s status on a non-retryable failure', async () => {
    axiosGet.mockRejectedValue(httpError(401));

    const err = await makeTmdbRequest('/movie/1', {}).catch((e) => e);

    expect(err).toBeInstanceOf(TmdbRequestError);
    expect(err.status).toBe(401);
    expect(err.endpoint).toBe('/movie/1');
    expect(err.message).toBe('TMDB API request failed: Request failed with status code 401');
  });

  it('keeps the last 5xx status when retries run out, and caches nothing', async () => {
    axiosGet.mockRejectedValue(httpError(503));

    const err = await makeTmdbRequest('/movie/1', {}, 1).catch((e) => e);

    expect(err).toBeInstanceOf(TmdbRequestError);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/TMDB API request failed after 1 retries/);
    expect(setTmdbCache).not.toHaveBeenCalled();
  });

  it('reports a null status when TMDB never answered', async () => {
    axiosGet.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));

    const err = await makeTmdbRequest('/movie/1', {}, 1).catch((e) => e);

    expect(err.status).toBeNull();
    expect(setTmdbCache).not.toHaveBeenCalled();
  });

  it('carries TMDB\'s Retry-After on a 429 that outlasts the retries', async () => {
    axiosGet.mockRejectedValue(httpError(429, { 'retry-after': '1' }));

    const err = await makeTmdbRequest('/movie/1', {}, 1).catch((e) => e);

    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(1);
    expect(setTmdbCache).not.toHaveBeenCalled();
  });
});

describe('not-found cache', () => {
  // Pin the 10% expired-row cleanup off: it also goes through withWriteTx.
  let randomSpy;
  beforeEach(() => {
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.99);
  });
  afterEach(() => {
    randomSpy.mockRestore();
  });

  it('remembers a TMDB 404 for a day under its own key', async () => {
    axiosGet.mockRejectedValue(httpError(404));

    const err = await makeTmdbRequest('/tv/275188', {}).catch((e) => e);

    expect(err.status).toBe(404);
    expect(err.cached).toBe(false);
    expect(setTmdbCache).toHaveBeenCalledTimes(1);
    const [endpoint, , data, ttlHours, cacheKey] = setTmdbCache.mock.calls[0];
    expect(endpoint).toBe('/tv/275188');
    expect(data).toMatchObject({ notFound: true, status: 404 });
    expect(ttlHours).toBe(24);
    expect(cacheKey).toBe(NOT_FOUND_KEY);
  });

  it('answers a remembered 404 without calling TMDB', async () => {
    getTmdbCache.mockImplementation(async (endpoint, params, key) =>
      key === NOT_FOUND_KEY
        ? { data: { notFound: true, status: 404, message: 'Request failed with status code 404' } }
        : null,
    );

    const err = await makeTmdbRequest('/tv/275188', {}).catch((e) => e);

    expect(axiosGet).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(TmdbRequestError);
    expect(err.status).toBe(404);
    expect(err.cached).toBe(true);
    expect(err.message).toBe('TMDB API request failed: Request failed with status code 404');
  });

  it('lets forceRefresh past the marker and clears it on success', async () => {
    getTmdbCache.mockImplementation(async (endpoint, params, key) =>
      key === NOT_FOUND_KEY ? { data: { notFound: true, status: 404, message: 'gone' } } : null,
    );
    axiosGet.mockResolvedValue({ status: 200, data: { id: 275188 }, headers: {} });
    const dbRun = jest.fn(async () => ({ changes: 1 }));
    withWriteTx.mockImplementationOnce(async (name, fn) => fn({ run: dbRun }));

    const result = await makeTmdbRequest('/tv/275188', {}, 3, 1440, /* forceRefresh */ true);

    expect(result).toMatchObject({ id: 275188 });
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(dbRun).toHaveBeenCalledWith('DELETE FROM tmdb_cache WHERE cache_key = ?', [NOT_FOUND_KEY]);
  });

  it('skips the marker delete on a forced refetch that has no marker', async () => {
    axiosGet.mockResolvedValue({ status: 200, data: { id: 3 }, headers: {} });

    await makeTmdbRequest('/tv/3', {}, 3, 1440, /* forceRefresh */ true);

    expect(withWriteTx).not.toHaveBeenCalled();
  });
});

describe('cache hit short-circuit', () => {
  it('returns the cached payload without touching the network or the revalidation lookup', async () => {
    getTmdbCache.mockResolvedValue({
      data: { id: 5 },
      cachedAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
      etag: 'W/"hit"',
    });

    const result = await makeTmdbRequest('/tv/5', {});

    expect(result).toMatchObject({ id: 5, _cached: true });
    expect(axiosGet).not.toHaveBeenCalled();
    expect(getTmdbCacheEntryAnyAge).not.toHaveBeenCalled();
  });
});
