/**
 * TMDB /find by external id — the exact lookup the identity providers use
 * when a manager (Sonarr, mostly) knows a title's TVDB/IMDb id but carries
 * no TMDB id. Pure result picking is tested directly; the request wrapper is
 * tested for argument validation and for not calling out on an empty id.
 */
import { describe, it, expect, jest } from '@jest/globals';

process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'test_api_key';

jest.unstable_mockModule('../../../sqliteDatabase.mjs', () => ({
  getTmdbCache: jest.fn().mockResolvedValue(null),
  getTmdbCacheEntryAnyAge: jest.fn().mockResolvedValue(null),
  setTmdbCache: jest.fn().mockResolvedValue(true),
  withWriteTx: jest.fn(() => Promise.resolve()),
  withDb: jest.fn(() => Promise.resolve()),
  withRetry: jest.fn((fn) => fn()),
}));

const { pickFindResult, findTmdbIdByExternalId, EXTERNAL_ID_SOURCES } = await import('../../../utils/tmdb.mjs');
const { createExternalIdResolver } = await import('../../../integrations/identity/external-id-resolver.mjs');

describe('pickFindResult', () => {
  const response = {
    movie_results: [{ id: 467956, title: 'The Professor' }],
    tv_results: [{ id: 251234, name: 'The Wayfinders' }, { id: 999, name: 'decoy' }],
    person_results: [{ id: 1 }],
  };

  it('picks the first result of the wanted type', () => {
    expect(pickFindResult(response, 'tv')).toBe(251234);
    expect(pickFindResult(response, 'movie')).toBe(467956);
  });

  it('a miss is null, never a guess from the other type', () => {
    expect(pickFindResult({ movie_results: [], tv_results: [] }, 'tv')).toBeNull();
    expect(pickFindResult({ movie_results: [{ id: 5 }] }, 'tv')).toBeNull();
    expect(pickFindResult(null, 'tv')).toBeNull();
    expect(pickFindResult({ tv_results: [{ id: 0 }] }, 'tv')).toBeNull();
  });
});

describe('findTmdbIdByExternalId', () => {
  it('knows the two external sources', () => {
    expect(EXTERNAL_ID_SOURCES).toEqual({ imdb: 'imdb_id', tvdb: 'tvdb_id' });
  });

  it('rejects an unknown source or type before any request', async () => {
    await expect(findTmdbIdByExternalId('trakt', '1', 'tv')).rejects.toThrow(/Unknown external id source/);
    await expect(findTmdbIdByExternalId('imdb', 'tt1', 'music')).rejects.toThrow(/Type must be/);
  });

  it('an empty id is a null answer, not a request', async () => {
    expect(await findTmdbIdByExternalId('imdb', '', 'tv')).toBeNull();
    expect(await findTmdbIdByExternalId('tvdb', undefined, 'tv')).toBeNull();
  });
});

describe('createExternalIdResolver', () => {
  it('tries IMDb first, then TVDB for tv only, and reports which one hit', async () => {
    const find = jest.fn(async (source, id, type) => (source === 'tvdb' && type === 'tv' ? 251234 : null));
    const resolve = createExternalIdResolver({ find });
    expect(await resolve({ mediaType: 'tv', libraryRelativePath: 'tv/X', externalIds: { imdb: 'tt29712397', tvdb: 470313 } }))
      .toEqual({ tmdbId: 251234, via: 'tvdb' });
    expect(find.mock.calls.map((c) => c[0])).toEqual(['imdb', 'tvdb']);
  });

  it('never tries TVDB for a movie, and a movie with only a TVDB id resolves to nothing', async () => {
    const find = jest.fn(async () => 1);
    const resolve = createExternalIdResolver({ find });
    expect(await resolve({ mediaType: 'movie', libraryRelativePath: 'movies/X', externalIds: { tvdb: 1 } })).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it('a lookup error is swallowed and the next source is still tried', async () => {
    const find = jest.fn(async (source) => {
      if (source === 'imdb') throw new Error('HTTP 500');
      return 7;
    });
    const resolve = createExternalIdResolver({ find });
    expect(await resolve({ mediaType: 'tv', libraryRelativePath: 'tv/X', externalIds: { imdb: 'tt1', tvdb: 2 } })).toEqual({ tmdbId: 7, via: 'tvdb' });
  });

  it('a claim with no external ids resolves to nothing without a lookup', async () => {
    const find = jest.fn();
    expect(await createExternalIdResolver({ find })({ mediaType: 'tv', externalIds: {} })).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });
});
