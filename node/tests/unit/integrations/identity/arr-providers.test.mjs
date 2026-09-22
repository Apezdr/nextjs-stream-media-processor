/**
 * Radarr / Sonarr providers against recorded API shapes.
 *
 * `fetchImpl` is injected, so nothing here touches the network. The fixtures
 * are trimmed copies of the v3 list responses and Webhook payloads, keeping
 * only the fields the providers read plus a few decoys.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { RadarrProvider } from '../../../../integrations/identity/arr/radarr.mjs';
import { SonarrProvider } from '../../../../integrations/identity/arr/sonarr.mjs';
import { parseRootMap, readArrEnv } from '../../../../integrations/identity/arr/arrProvider.mjs';
import { EVENT_KINDS } from '../../../../integrations/identity/provider.mjs';
import { createIdentityProviders, parseUnsourcedPinTreatment } from '../../../../integrations/identity/registry.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/identity');
const loadFixture = async (name) => JSON.parse(await fs.readFile(join(fixtures, name), 'utf8'));

function fakeFetch(routes) {
  const calls = [];
  const impl = jest.fn(async (url, init) => {
    calls.push({ url, init });
    const pathname = new URL(url).pathname;
    const route = routes[pathname];
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    if (route instanceof Error) throw route;
    return { ok: true, status: 200, json: async () => route };
  });
  impl.calls = calls;
  return impl;
}

describe('env parsing', () => {
  it('unset is "not configured", half-set is an error', () => {
    expect(readArrEnv({}, 'RADARR')).toBeNull();
    expect(() => readArrEnv({ RADARR_URL: 'http://r:7878' }, 'RADARR')).toThrow(/both be set/);
    expect(() => readArrEnv({ RADARR_URL: 'not a url', RADARR_API_KEY: 'k' }, 'RADARR')).toThrow(/valid URL/);
    expect(() => readArrEnv({ RADARR_URL: 'http://r', RADARR_API_KEY: 'k', RADARR_TIMEOUT_MS: 'soon' }, 'RADARR')).toThrow(/TIMEOUT_MS/);
  });

  it('strips a trailing slash from the URL and defaults the timeout', () => {
    const cfg = readArrEnv({ RADARR_URL: 'http://radarr:7878/', RADARR_API_KEY: 'k' }, 'RADARR');
    expect(cfg).toMatchObject({ baseUrl: 'http://radarr:7878', apiKey: 'k', rootMap: [], timeoutMs: 15000 });
  });

  it('root map: longest provider root first, library root validated', () => {
    const map = parseRootMap('/media=movies; /media/anime=movies, D:\\tv\\=tv');
    expect(map.map((m) => m.providerRoot)).toEqual(['/media/anime', '/media', 'D:/tv']);
    expect(map.map((m) => m.libraryRoot)).toEqual(['movies', 'movies', 'tv']);
    expect(() => parseRootMap('/x=music')).toThrow(/library root/);
    expect(() => parseRootMap('/x')).toThrow(/providerRoot/);
    expect(parseRootMap(undefined)).toEqual([]);
  });

  it('IDENTITY_UNSOURCED_PINS falls back to manual on anything unexpected', () => {
    expect(parseUnsourcedPinTreatment(undefined)).toBe('manual');
    expect(parseUnsourcedPinTreatment('AUTO')).toBe('auto');
    expect(parseUnsourcedPinTreatment('yes please')).toBe('manual');
  });
});

describe('registry', () => {
  it('builds only the providers whose env is present, in precedence order', () => {
    const { providers, errors } = createIdentityProviders({ SONARR_URL: 'http://s:8989', SONARR_API_KEY: 'k' });
    expect(providers.map((p) => p.name)).toEqual(['sonarr']);
    expect(errors).toEqual([]);

    const both = createIdentityProviders({ RADARR_URL: 'http://r', RADARR_API_KEY: 'k', SONARR_URL: 'http://s', SONARR_API_KEY: 'k' });
    expect(both.providers.map((p) => p.name)).toEqual(['radarr', 'sonarr']);
  });

  it('a misconfigured provider is reported and skipped, the others still build', () => {
    const { providers, errors } = createIdentityProviders({ RADARR_URL: 'http://r', SONARR_URL: 'http://s', SONARR_API_KEY: 'k' });
    expect(providers.map((p) => p.name)).toEqual(['sonarr']);
    expect(errors).toEqual([{ provider: 'radarr', error: expect.stringMatching(/RADARR_API_KEY/) }]);
  });

  it('nothing configured → no providers, no errors', () => {
    expect(createIdentityProviders({})).toEqual({ providers: [], errors: [] });
  });
});

describe('RadarrProvider', () => {
  const env = { RADARR_URL: 'http://radarr:7878', RADARR_API_KEY: 'secret-key' };

  it('sends the API key header and never exposes it through describe()/JSON', async () => {
    const fetchImpl = fakeFetch({ '/api/v3/movie': [] });
    const provider = RadarrProvider.fromEnv(env, { fetchImpl });
    await provider.fetchClaims();
    expect(fetchImpl.calls[0].init.headers['X-Api-Key']).toBe('secret-key');
    expect(JSON.stringify(provider)).not.toContain('secret-key');
    expect(JSON.stringify(provider.describe())).not.toContain('secret-key');
  });

  it('maps every managed movie onto movies/<basename>, carrying year, ids and hasFile', async () => {
    const fetchImpl = fakeFetch({ '/api/v3/movie': await loadFixture('radarr-movies.json') });
    const provider = RadarrProvider.fromEnv(env, { fetchImpl });
    const claims = await provider.fetchClaims();

    // 5 items: one has tmdbId 0 (dropped); with no root map, /kids_movies maps by basename too.
    expect(claims).toHaveLength(4);
    const professor = claims.find((c) => c.tmdbId === 467956);
    expect(professor).toEqual({
      mediaType: 'movie',
      libraryRelativePath: 'movies/The Professor',
      tmdbId: 467956,
      source: 'radarr',
      year: 2018,
      title: 'The Professor',
      externalIds: { imdb: 'tt5559796' },
      hasFile: true,
      providerPath: '/processed_movies/The Professor',
    });
    expect(claims.find((c) => c.tmdbId === 999001).hasFile).toBe(false);
    expect(provider.lastFetch).toMatchObject({ items: 5, claims: 4, unmapped: 0, noId: 1 });
  });

  it('with a root map, items under unmapped roots are skipped and counted', async () => {
    const fetchImpl = fakeFetch({ '/api/v3/movie': await loadFixture('radarr-movies.json') });
    const provider = RadarrProvider.fromEnv({ ...env, RADARR_ROOT_MAP: '/processed_movies=movies' }, { fetchImpl });
    const claims = await provider.fetchClaims();
    expect(claims.map((c) => c.libraryRelativePath)).toEqual([
      'movies/The Professor',
      'movies/Dune (2021)',
      'movies/Not Downloaded Yet (2026)',
    ]);
    expect(provider.lastFetch.unmapped).toBe(1);
  });

  it('a root map can point a second root at the same library root', () => {
    const provider = RadarrProvider.fromEnv({ ...env, RADARR_ROOT_MAP: '/processed_movies=movies;/kids_movies=movies' }, {});
    expect(provider.mapPath('/kids_movies/Kids Film (2020)')).toBe('movies/Kids Film (2020)');
    expect(provider.mapPath('/kids_movies/Nested/Deeper')).toBe('movies/Nested/Deeper');
    expect(provider.mapPath('/elsewhere/X')).toBeNull();
    expect(provider.mapPath('/processed_movies')).toBeNull();
  });

  it('surfaces HTTP failures and timeouts as errors (the index builder isolates them)', async () => {
    const fetchImpl = fakeFetch({});
    await expect(RadarrProvider.fromEnv(env, { fetchImpl }).fetchClaims()).rejects.toThrow(/HTTP 404/);

    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const slow = fakeFetch({ '/api/v3/movie': abortErr });
    await expect(RadarrProvider.fromEnv(env, { fetchImpl: slow }).fetchClaims()).rejects.toThrow(/timed out/);
  });

  it('rejects a non-array list body', async () => {
    const fetchImpl = fakeFetch({ '/api/v3/movie': { error: 'Unauthorized' } });
    await expect(RadarrProvider.fromEnv(env, { fetchImpl }).fetchClaims()).rejects.toThrow(/did not return an array/);
  });

  it('parses a Download webhook into an imported event with a claim from movie.folderPath', async () => {
    const provider = RadarrProvider.fromEnv(env, {});
    const [event] = provider.parseWebhook(await loadFixture('radarr-webhook-download.json'));
    expect(event).toMatchObject({
      kind: EVENT_KINDS.IMPORTED,
      source: 'radarr',
      rawType: 'Download',
      details: { isUpgrade: false },
      claim: { libraryRelativePath: 'movies/The Professor', tmdbId: 467956, mediaType: 'movie' },
    });
  });

  it('maps the rest of the Radarr event vocabulary', () => {
    const provider = RadarrProvider.fromEnv(env, {});
    const kindOf = (body) => provider.parseWebhook(body)[0]?.kind;
    const movie = { tmdbId: 1, folderPath: '/processed_movies/X' };
    expect(kindOf({ eventType: 'Test' })).toBe(EVENT_KINDS.TEST);
    expect(kindOf({ eventType: 'Download', isUpgrade: true, movie })).toBe(EVENT_KINDS.UPGRADED);
    expect(kindOf({ eventType: 'Rename', movie })).toBe(EVENT_KINDS.RENAMED);
    expect(kindOf({ eventType: 'MovieAdded', movie })).toBe(EVENT_KINDS.ADDED);
    expect(kindOf({ eventType: 'MovieDelete', movie })).toBe(EVENT_KINDS.DELETED);
    expect(kindOf({ eventType: 'MovieFileDelete', movie })).toBe(EVENT_KINDS.FILE_DELETED);
    expect(kindOf({ eventType: 'Grab', movie })).toBe(EVENT_KINDS.IGNORED);
    expect(kindOf({ eventType: 'SomethingNew', movie })).toBe(EVENT_KINDS.IGNORED);
    expect(provider.parseWebhook({})).toEqual([]);
    expect(provider.parseWebhook(null)).toEqual([]);
    expect(provider.parseWebhook('nope')).toEqual([]);
  });

  it('a webhook whose subject lacks an id still yields an event, with no claim', () => {
    const provider = RadarrProvider.fromEnv(env, {});
    const [event] = provider.parseWebhook({ eventType: 'Download', movie: { title: 'Mystery', folderPath: '/processed_movies/M' } });
    expect(event.kind).toBe(EVENT_KINDS.IMPORTED);
    expect(event.claim).toBeNull();
  });
});

describe('SonarrProvider', () => {
  const env = { SONARR_URL: 'http://sonarr:8989', SONARR_API_KEY: 'k' };

  it('maps series onto tv/<basename>, reads tmdbId directly and carries tvdb/imdb', async () => {
    const fetchImpl = fakeFetch({ '/api/v3/series': await loadFixture('sonarr-series.json') });
    const provider = SonarrProvider.fromEnv(env, { fetchImpl });
    const claims = await provider.fetchClaims();
    expect(claims).toHaveLength(2); // the third series has no tmdbId
    expect(claims[0]).toEqual({
      mediaType: 'tv',
      libraryRelativePath: 'tv/Kingdom (2019)',
      tmdbId: 83097,
      source: 'sonarr',
      year: 2019,
      title: 'Kingdom',
      externalIds: { imdb: 'tt6611916', tvdb: 354167 },
      hasFile: true,
      providerPath: '/processed_tv/Kingdom (2019)',
    });
    expect(claims[1]).toMatchObject({ libraryRelativePath: 'tv/Kingdom (2014)', tmdbId: 61137, hasFile: false });
    expect(fetchImpl.calls[0].url).toBe('http://sonarr:8989/api/v3/series');
  });

  it('two same-titled shows are two distinct claims — no name heuristic involved', async () => {
    const fetchImpl = fakeFetch({ '/api/v3/series': await loadFixture('sonarr-series.json') });
    const claims = await SonarrProvider.fromEnv(env, { fetchImpl }).fetchClaims();
    const kingdoms = claims.filter((c) => c.title === 'Kingdom');
    expect(new Set(kingdoms.map((c) => c.tmdbId)).size).toBe(2);
  });

  it('parses an upgrade Download webhook from series.path', async () => {
    const provider = SonarrProvider.fromEnv(env, {});
    const [event] = provider.parseWebhook(await loadFixture('sonarr-webhook-download.json'));
    expect(event).toMatchObject({
      kind: EVENT_KINDS.UPGRADED,
      rawType: 'Download',
      details: { isUpgrade: true, deletedFiles: 1 },
      claim: { libraryRelativePath: 'tv/Kingdom (2019)', tmdbId: 83097, mediaType: 'tv', externalIds: { tvdb: 354167, imdb: 'tt6611916' } },
    });
  });

  it('maps Sonarr-specific event types', () => {
    const provider = SonarrProvider.fromEnv(env, {});
    const series = { tmdbId: 1, path: '/processed_tv/X' };
    expect(provider.parseWebhook({ eventType: 'SeriesAdd', series })[0].kind).toBe(EVENT_KINDS.ADDED);
    expect(provider.parseWebhook({ eventType: 'SeriesDelete', series })[0].kind).toBe(EVENT_KINDS.DELETED);
    expect(provider.parseWebhook({ eventType: 'EpisodeFileDelete', series })[0].kind).toBe(EVENT_KINDS.FILE_DELETED);
  });

  it('health check reports the app and version, or the failure', async () => {
    const ok = SonarrProvider.fromEnv(env, { fetchImpl: fakeFetch({ '/api/v3/system/status': { appName: 'Sonarr', version: '4.0.20' } }) });
    expect(await ok.healthCheck()).toEqual({ ok: true, detail: 'Sonarr 4.0.20' });
    const down = SonarrProvider.fromEnv(env, { fetchImpl: fakeFetch({}) });
    expect((await down.healthCheck()).ok).toBe(false);
  });
});
