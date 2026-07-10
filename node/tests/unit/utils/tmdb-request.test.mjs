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
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

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

const { makeTmdbRequest } = await import('../../../utils/tmdb.mjs');

beforeEach(() => {
  axiosGet.mockReset();
  getTmdbCache.mockReset().mockResolvedValue(null);
  getTmdbCacheEntryAnyAge.mockReset().mockResolvedValue(null);
  setTmdbCache.mockReset().mockResolvedValue(true);
});

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
