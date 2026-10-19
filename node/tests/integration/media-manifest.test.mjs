/**
 * GET /media/<kind>/manifest and POST /media/<kind>/entries, end to end:
 * fixture library on disk → real scanner → real SQLite → the real builders →
 * MediaPayloadCache → the real handlers behind the real compression
 * middleware, over HTTP, next to the cached body they are cut from.
 *
 * What it pins:
 *
 *   - the manifest lists every title of the cached body by folder name, with
 *     the 16-hex hash of the entry bytes, and each show's season and episode
 *     keys exactly as the body has them;
 *   - an entries line carries that hash over the very bytes it sends, so the
 *     frontend can store the hash of what it applied;
 *   - one changed row moves that title's hash and the manifest ETag, nothing
 *     else; a new episode moves its show's keys;
 *   - a matching If-None-Match gets a 304 even with `Cache-Control: no-cache`;
 *   - entries for a list, for `all`, and for a title the library does not
 *     have; lines that parse one at a time when split on 0x0A, whatever the
 *     names hold (raw U+2028 and U+2029 included);
 *   - the closing line {"end":true,"count":N} after the last title line, with
 *     N the title lines sent, and none on a stream cut off part-way;
 *   - the manifest's exact bytes, format 2;
 *   - a rebuild between the manifest and the entries is a hash mismatch, and a
 *     rebuild mid-stream does not mix generations;
 *   - the stream follows the client's pace, and the request limit holds a list
 *     of every title in a big library.
 *
 * The ffprobe/mediainfo boundary is mocked, as in media-payload-cache.test.mjs.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { promises as fs } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { gunzipSync } from 'zlib';

const tmpRoot = join(tmpdir(), `media-manifest-${randomUUID()}`);
const MEDIA = join(tmpRoot, 'media');
const DB_DIR = join(tmpRoot, 'db');

process.env.MEDIA_DB_DIRECTORY = DB_DIR;
process.env.JIT_ELIGIBILITY_ENABLED = 'true';
process.env.JIT_TRANSCODER_URL = 'https://transcoder.test';

// ---------------------------------------------------------------- probe facts

// Every fixture video probes the same, named after its file.
const probeFor = (fileName) => ({
  uuid: `uuid-${fileName}`,
  length: 2700000,
  dimensions: '1920x1080',
  hdr: null,
  mediaQuality: { isHDR: false, format: 'HEVC', bitDepth: 10 },
  additionalMetadata: {
    duration: 2700000,
    size: { kb: 1500000, mb: 1464.84, gb: 1.43 },
    format: { formatName: 'matroska,webm', formatLongName: 'Matroska / WebM', bitrate: 4000000 },
    audio: [{ codec: 'eac3', channels: 6, language: 'eng', languageTag: 'eng' }],
    video: [{ codec: 'hevc', frame_rate: '24000/1001', bitrate: 3500000, width: 1920, height: 1080 }],
    width: 1920,
    height: 1080,
    dimensions: '1920x1080',
  },
});

jest.unstable_mockModule('../../infoManager.mjs', () => ({
  CURRENT_VERSION: 1.0011,
  getInfo: jest.fn(async (filePath) => probeFor(filePath.split(/[\\/]/).pop())),
  writeInfo: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../ffmpeg/ffprobe.mjs', () => ({
  chapterInfo: jest.fn(async () => null),
  isVideoHDR: jest.fn(async () => false),
  getVideoDuration: jest.fn(async () => 0),
  getVideoCodec: jest.fn(async () => 'h264'),
  getAudioTracks: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../chapter-generator.mjs', () => ({
  generateChapters: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../utils/backdropFocalDetector.mjs', () => ({
  detectBackdropFocal: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../components/caption-generator/data-access/caption-config.mjs', () => ({
  getAutoCaptionsConfigCached: jest.fn(async () => ({ enabled: false, languages: ['en'] })),
}));
jest.unstable_mockModule('../../lib/metadataGenerator.mjs', () => ({
  isFrozenReason: jest.fn(() => false),
  refreshMissingEpisodes: jest.fn(async () => 0),
  MetadataGenerator: class {},
}));

const { scanMovies } = await import('../../components/media-scanner/domain/movie-scanner.mjs');
const { scanTVShows } = await import('../../components/media-scanner/domain/tv-scanner.mjs');
const sqliteDb = await import('../../sqliteDatabase.mjs');
const { initializeDatabase, releaseDatabase, getMovies, getTVShows } = sqliteDb;
const { injectMovieStubs, injectTvStubs } = await import(
  '../../components/caption-generator/domain/caption-stubs.mjs'
);
const { langMap } = await import('../../utils/languageMap.mjs');
const { buildMoviePayloadEntry, buildTvPayloadEntry } = await import('../../lib/mediaPayload.mjs');
const { MediaPayloadCache, compressionFilter } = await import(
  '../../lib/mediaPayloadCache.mjs'
);
const {
  MANIFEST_FORMAT_VERSION,
  TITLE_HASH_LENGTH,
  ENTRIES_REQUEST_BODY_LIMIT,
  tvManifestKeys,
  buildManifest,
  getManifest,
  parseEntriesRequest,
  createManifestHandler,
  createEntriesBodyParser,
  createEntriesHandler,
} = await import('../../lib/mediaManifest.mjs');
const express = (await import('express')).default;
const compression = (await import('compression')).default;

const TV_LIST_VERSION = 1.0001;
const MOVIE_LIST_VERSION = 1.0001;
const PREFIX = '/media';

let db;
let server;
let baseUrl;
let lastRequestCacheControl;
let lastServerResponse;
const quietLogger = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };

// ---------------------------------------------------------------- wiring (as app.mjs)

let tvLoads = 0;

async function loadMovies() {
  const movies = await getMovies();
  await injectMovieStubs(movies, langMap);
  return movies;
}
async function loadShows() {
  tvLoads += 1;
  const shows = await getTVShows();
  await injectTvStubs(shows, langMap);
  return shows;
}

const movieCache = new MediaPayloadCache({
  kind: 'movies',
  version: MOVIE_LIST_VERSION,
  builder: buildMoviePayloadEntry,
  loadRows: loadMovies,
});
const tvCache = new MediaPayloadCache({
  kind: 'tv',
  version: TV_LIST_VERSION,
  builder: buildTvPayloadEntry,
  describe: tvManifestKeys,
  loadRows: loadShows,
});

// Names that test the framing: quotes, a backslash, a newline, a raw U+2028
// and U+2029 (JSON.stringify leaves both raw), an integer-like name, the body's
// own `version` key, and Object.prototype names.
const ODD_NAMES = [
  'Quote " and \\ backslash',
  'Line\nbreak',
  'Separator inside',
  'Paragraph inside',
  '1917',
  'version',
  '__proto__',
  'Ünïcödé — title',
];
const oddCache = new MediaPayloadCache({
  kind: 'movies',
  version: MOVIE_LIST_VERSION,
  builder: (row) => ({ text: row.name, len: row.name.length }),
  loadRows: async () => ODD_NAMES.map((name) => ({ name })),
});

// A library big enough that the client's pace matters: 192 titles of 256 KB.
const BIG_TITLES = 192;
let bigFill = 'a';
const bigCache = new MediaPayloadCache({
  kind: 'movies',
  version: MOVIE_LIST_VERSION,
  builder: (row) => ({ fill: row.fill }),
  loadRows: async () =>
    Array.from({ length: BIG_TITLES }, (_, i) => ({
      name: `Big ${String(i).padStart(3, '0')}`,
      fill: bigFill.repeat(256 * 1024),
    })),
});

let brokenLoads = 0;
const brokenCache = new MediaPayloadCache({
  kind: 'movies',
  version: MOVIE_LIST_VERSION,
  builder: buildMoviePayloadEntry,
  loadRows: async () => {
    brokenLoads += 1;
    if (brokenLoads % 2 === 1) throw new Error('database is locked');
    return loadMovies();
  },
});

// ---------------------------------------------------------------- helpers

async function writeFiles(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  for (const f of files) await fs.writeFile(join(dir, f), 'x'.repeat(64));
}

async function scanAll() {
  await scanMovies(db, join(MEDIA, 'movies'), PREFIX, MEDIA, langMap, 1.0011, false, async () => {});
  await scanTVShows(db, join(MEDIA, 'tv'), PREFIX, MEDIA, langMap, false, async () => {});
}

const sha1 = (data) => createHash('sha1').update(data).digest('hex');
const short = (data) => sha1(data).slice(0, TITLE_HASH_LENGTH);

/** A request that hands back the bytes as sent (no automatic decompression). */
function rawRequest(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function postJson(path, payload, headers = {}) {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return rawRequest('POST', path, {
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers },
    body,
  });
}

/**
 * Split bytes on 0x0A only, as the contract says a reader must, and parse each
 * whole line on its own. Bytes after the last 0x0A are not a line.
 */
function splitLines(body) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== 0x0a) continue;
    const raw = body.subarray(start, i);
    lines.push({ raw, value: JSON.parse(raw) });
    start = i + 1;
  }
  return lines;
}

const closingBytes = (count) => Buffer.from(`{"end":true,"count":${count}}\n`);

/**
 * The title lines of a whole entries body: it must end with the closing line,
 * whose count is the number of title lines before it.
 */
function ndjsonLines(body) {
  expect(body[body.length - 1]).toBe(0x0a);
  const lines = splitLines(body);
  const end = lines.pop();
  expect(end.value).toEqual({ end: true, count: lines.length });
  expect(body.subarray(body.length - end.raw.length - 1).equals(closingBytes(lines.length))).toBe(true);
  for (const line of lines) expect(Object.hasOwn(line.value, 'end')).toBe(false);
  return lines;
}

/** The entry bytes of an entries line, as sent. */
function entryBytesOf({ raw, value }) {
  const head = Buffer.from(`{"title":${JSON.stringify(value.title)},"hash":"${value.hash}","entry":`);
  expect(raw.subarray(0, head.length).equals(head)).toBe(true);
  expect(raw.subarray(raw.length - 1).toString()).toBe('}');
  return raw.subarray(head.length, raw.length - 1);
}

async function getJson(path) {
  const res = await rawRequest('GET', path);
  expect(res.status).toBe(200);
  return { res, json: JSON.parse(res.body) };
}

function titlesOfBody(body) {
  return Object.keys(body).filter((key) => key !== 'version');
}

/** The cached body of `cache`, parsed: what the manifest and entries are cut from. */
async function cachedBody(cache) {
  return JSON.parse((await cache.get()).body);
}

/** A show's season → episode keys, read off the cached TV body. */
function keysFromBody(show) {
  return Object.fromEntries(
    Object.entries(show.seasons ?? {}).map(([seasonKey, season]) => [seasonKey, Object.keys(season?.episodes ?? {})])
  );
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- setup

beforeAll(async () => {
  await writeFiles(join(MEDIA, 'movies', 'Zeta Movie'), ['Zeta.2160p.mkv']);
  await writeFiles(join(MEDIA, 'movies', 'Alpha Movie'), ['Alpha.1080p.mp4', 'Alpha.en.srt']);
  await writeFiles(join(MEDIA, 'tv', 'Some Show', 'Season 1'), [
    'Some Show - S01E01.mkv',
    'Some Show - S01E02.mkv',
  ]);
  await writeFiles(join(MEDIA, 'tv', 'Some Show', 'Season 2'), ['Some Show - S02E01.mkv']);
  await writeFiles(join(MEDIA, 'tv', 'Other Show', 'Season 1'), ['Other Show - S01E01.mkv']);

  await fs.mkdir(DB_DIR, { recursive: true });
  db = await initializeDatabase();
  await scanAll();

  const app = express();
  app.use((req, res, next) => {
    lastRequestCacheControl = req.headers['cache-control'];
    lastServerResponse = res;
    next();
  });
  app.use(compression({ filter: compressionFilter }));
  const opts = (errorLabel) => ({ logger: quietLogger, errorLabel });
  for (const [path, cache] of [
    ['/media/movies', movieCache],
    ['/media/tv', tvCache],
    ['/odd', oddCache],
    ['/big', bigCache],
    ['/broken', brokenCache],
  ]) {
    app.get(`${path}/manifest`, createManifestHandler(cache, opts('manifest')));
    app.post(`${path}/entries`, createEntriesBodyParser(), createEntriesHandler(cache, opts('entries')));
  }
  // As app.mjs's error handler: a body-parser error keeps its status. (Four
  // parameters, or Express does not take it for an error handler.)
  app.use((err, req, res, next) => {
    res.status(Number.isInteger(err?.status) ? err.status : 500).json({ error: err?.type ?? 'error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  if (db) await releaseDatabase(db);
  await sqliteDb.closeAllDatabaseConnections();
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows may still hold the sqlite file; the temp dir is the OS's to reclaim.
  }
});

beforeEach(() => {
  movieCache.invalidate('test');
  tvCache.invalidate('test');
});

// ---------------------------------------------------------------- the manifest

describe('the manifest', () => {
  it('lists every title of the cached body by folder name, with the hash of its entry bytes', async () => {
    for (const [kind, cache, version] of [
      ['movies', movieCache, MOVIE_LIST_VERSION],
      ['tv', tvCache, TV_LIST_VERSION],
    ]) {
      const body = await cachedBody(cache);
      const { json: manifest } = await getJson(`/media/${kind}/manifest`);

      expect(MANIFEST_FORMAT_VERSION).toBe(2);
      expect(manifest.format).toBe(MANIFEST_FORMAT_VERSION);
      expect(manifest.kind).toBe(kind);
      expect(manifest.version).toBe(version);
      expect(Object.keys(manifest)).toEqual(['format', 'kind', 'version', 'titles']);
      expect(Object.keys(manifest.titles)).toEqual(titlesOfBody(body));

      const entry = cache.peek();
      for (const title of entry.titles) {
        const record = manifest.titles[title.name];
        expect(record.hash).toMatch(/^[0-9a-f]{16}$/);
        expect(record.hash).toBe(short(entry.body.subarray(title.start, title.end)));
        expect(Object.keys(record)).toEqual(kind === 'tv' ? ['hash', 'seasons'] : ['hash']);
      }
    }
  });

  it('carries each show\'s season and episode keys exactly as the cached body has them', async () => {
    const body = await cachedBody(tvCache);
    const { json: manifest } = await getJson('/media/tv/manifest');

    expect(Object.keys(manifest.titles)).toEqual(['Other Show', 'Some Show']);
    for (const show of titlesOfBody(body)) {
      const seasons = manifest.titles[show].seasons;
      expect(seasons).toEqual(keysFromBody(body[show]));
      // In the same order, too.
      expect(Object.keys(seasons)).toEqual(Object.keys(body[show].seasons));
    }
    expect(manifest.titles['Some Show'].seasons).toEqual({
      'Season 1': ['S01E01', 'S01E02'],
      'Season 2': ['S02E01'],
    });
  });

  it('answers a matching If-None-Match with a 304, even with Cache-Control: no-cache', async () => {
    const first = await fetch(`${baseUrl}/media/tv/manifest`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    await first.arrayBuffer();
    expect(etag).toMatch(/^W\/"tv-manifest-[0-9a-f]{40}"$/);

    // Node's fetch sends If-None-Match with Cache-Control: no-cache on its own.
    const loadsBefore = tvLoads;
    const conditional = await fetch(`${baseUrl}/media/tv/manifest`, { headers: { 'If-None-Match': etag } });
    expect(lastRequestCacheControl).toBe('no-cache');
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('etag')).toBe(etag);
    expect((await conditional.arrayBuffer()).byteLength).toBe(0);

    // And said explicitly.
    const explicit = await rawRequest('GET', '/media/tv/manifest', {
      headers: { 'If-None-Match': etag, 'Cache-Control': 'no-cache' },
    });
    expect(explicit.status).toBe(304);
    expect(explicit.headers.etag).toBe(etag);
    expect(explicit.body.length).toBe(0);
    expect(tvLoads).toBe(loadsBefore);
  });

  it('sends its gzip copy when the client takes it, the identity bytes otherwise', async () => {
    const identity = await rawRequest('GET', '/media/movies/manifest');
    expect(identity.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(Number(identity.headers['content-length'])).toBe(identity.body.length);

    const gzipped = await rawRequest('GET', '/media/movies/manifest', { headers: { 'Accept-Encoding': 'gzip, br' } });
    expect(gzipped.headers['content-encoding']).toBe('gzip');
    expect(gzipped.headers.vary).toMatch(/Accept-Encoding/);
    expect(gzipped.headers.etag).toBe(identity.headers.etag);
    expect(gunzipSync(gzipped.body).equals(identity.body)).toBe(true);
  });

  it('is the same from the same rows', async () => {
    const before = await rawRequest('GET', '/media/tv/manifest');
    tvCache.invalidate('test');
    const after = await rawRequest('GET', '/media/tv/manifest');
    expect(after.headers.etag).toBe(before.headers.etag);
    expect(after.body.equals(before.body)).toBe(true);
  });

  it('moves only the changed title\'s hash, and its ETag, when one row changes', async () => {
    const before = await getJson('/media/movies/manifest');
    const { hdr } = await db.get(`SELECT hdr FROM movies WHERE name = 'Alpha Movie'`);
    await db.run(`UPDATE movies SET hdr = 'Dolby Vision' WHERE name = 'Alpha Movie'`);
    try {
      movieCache.invalidate('test');
      const after = await getJson('/media/movies/manifest');
      expect(after.res.headers.etag).not.toBe(before.res.headers.etag);
      expect(Object.keys(after.json.titles)).toEqual(Object.keys(before.json.titles));
      const changed = Object.keys(after.json.titles).filter(
        (name) => after.json.titles[name].hash !== before.json.titles[name].hash
      );
      expect(changed).toEqual(['Alpha Movie']);
    } finally {
      await db.run(`UPDATE movies SET hdr = ? WHERE name = 'Alpha Movie'`, [hdr]);
    }
    movieCache.invalidate('test');
    expect((await rawRequest('GET', '/media/movies/manifest')).headers.etag).toBe(before.res.headers.etag);
  });

  it('moves with a show\'s episode set: that show\'s keys and hash, and the ETag', async () => {
    const before = await getJson('/media/tv/manifest');
    const seasonDir = join(MEDIA, 'tv', 'Some Show', 'Season 1');
    await fs.writeFile(join(seasonDir, 'Some Show - S01E03.mkv'), 'z'.repeat(64));
    try {
      await scanTVShows(db, join(MEDIA, 'tv'), PREFIX, MEDIA, langMap, false, async () => {});
      tvCache.invalidate('scan tick');
      const after = await getJson('/media/tv/manifest');
      expect(after.res.headers.etag).not.toBe(before.res.headers.etag);
      expect(after.json.titles['Some Show'].seasons['Season 1']).toEqual(['S01E01', 'S01E02', 'S01E03']);
      expect(after.json.titles['Some Show'].hash).not.toBe(before.json.titles['Some Show'].hash);
      expect(after.json.titles['Other Show']).toEqual(before.json.titles['Other Show']);
      expect(after.json.titles['Some Show'].seasons).toEqual(keysFromBody((await cachedBody(tvCache))['Some Show']));
    } finally {
      await fs.rm(join(seasonDir, 'Some Show - S01E03.mkv'));
      await scanTVShows(db, join(MEDIA, 'tv'), PREFIX, MEDIA, langMap, false, async () => {});
    }
  });

  it('answers 500 when the build fails, and builds again on the next request', async () => {
    brokenCache.invalidate('test');
    brokenLoads = 0;
    const failed = await rawRequest('GET', '/broken/manifest');
    expect(failed.status).toBe(500);
    expect(failed.body.toString()).toBe('Internal server error');
    expect((await rawRequest('GET', '/broken/manifest')).status).toBe(200);
  });

  it('fails closed without a show\'s keys, and leaves the cached body as it was', async () => {
    const reference = await tvCache.get();

    // A describe that throws for one show: the list is untouched, the manifest
    // refuses rather than publish a show without seasons.
    const throwing = new MediaPayloadCache({
      kind: 'tv',
      version: TV_LIST_VERSION,
      builder: buildTvPayloadEntry,
      describe: (entry, row) => {
        if (row.name === 'Some Show') throw new Error('bad seasons');
        return tvManifestKeys(entry);
      },
      loadRows: loadShows,
    });
    // And a TV cache wired without one.
    const undescribed = new MediaPayloadCache({
      kind: 'tv',
      version: TV_LIST_VERSION,
      builder: buildTvPayloadEntry,
      loadRows: loadShows,
    });

    const errors = [];
    const logger = { ...quietLogger, error: (message) => errors.push(message) };
    for (const cache of [throwing, undescribed]) {
      const built = await cache.get();
      expect(built.body.equals(reference.body)).toBe(true);

      const app = express();
      app.get('/manifest', createManifestHandler(cache, { logger, errorLabel: 'manifest' }));
      app.post('/entries', express.json(), createEntriesHandler(cache, { logger, errorLabel: 'entries' }));
      const local = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      try {
        const url = `http://127.0.0.1:${local.address().port}`;
        expect((await fetch(`${url}/manifest`)).status).toBe(500);
        const entries = await fetch(`${url}/entries`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true }),
        });
        expect(entries.status).toBe(500);
      } finally {
        local.closeAllConnections?.();
        await new Promise((resolve) => local.close(resolve));
      }
    }
    expect(errors.some((m) => m.includes('"Some Show": bad seasons'))).toBe(true);
    expect(errors.some((m) => m.includes('no season keys for TV title "Other Show"'))).toBe(true);
  });
});

// ---------------------------------------------------------------- the entries

describe('the entries', () => {
  it('answers a list in the order asked, once per title, with a line for a title it does not have', async () => {
    const body = await cachedBody(movieCache);
    const manifestRes = await rawRequest('GET', '/media/movies/manifest');

    const res = await postJson('/media/movies/entries', {
      titles: ['Zeta Movie', 'No Such Movie', 'Alpha Movie', 'Zeta Movie'],
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['x-manifest-etag']).toBe(manifestRes.headers.etag);
    // P4: the whole-library ETag went with its route.
    expect(res.headers['x-library-etag']).toBeUndefined();

    const lines = ndjsonLines(res.body).map((line) => line.value);
    expect(lines.map((line) => line.title)).toEqual(['Zeta Movie', 'No Such Movie', 'Alpha Movie']);
    expect(lines[1]).toEqual({ title: 'No Such Movie', missing: true });
    for (const line of [lines[0], lines[2]]) {
      expect(Object.keys(line)).toEqual(['title', 'hash', 'entry']);
      expect(line.entry).toEqual(body[line.title]);
    }
  });

  it('gives each line its title\'s manifest hash, over the very bytes it sends', async () => {
    for (const kind of ['movies', 'tv']) {
      const { json: manifest } = await getJson(`/media/${kind}/manifest`);
      const res = await postJson(`/media/${kind}/entries`, { all: true });
      const lines = ndjsonLines(res.body);
      expect(lines).toHaveLength(Object.keys(manifest.titles).length);
      for (const line of lines) {
        const { title, hash } = line.value;
        expect(hash).toBe(manifest.titles[title].hash);
        expect(short(entryBytesOf(line))).toBe(hash);
        // Re-serializing what the frontend parsed gives the same bytes, so it
        // can check the hash itself.
        expect(short(JSON.stringify(line.value.entry))).toBe(hash);
      }
    }
  });

  it('answers all with every title of the cached body, in its order', async () => {
    for (const [kind, cache] of [['movies', movieCache], ['tv', tvCache]]) {
      const body = await cachedBody(cache);
      const lines = ndjsonLines((await postJson(`/media/${kind}/entries`, { all: true })).body).map((l) => l.value);
      expect(lines.map((line) => line.title)).toEqual(titlesOfBody(body));
      for (const line of lines) expect(line.entry).toEqual(body[line.title]);
      expect(lines.some((line) => line.missing)).toBe(false);
    }
  });

  it('frames every line on its own, whatever the names hold', async () => {
    oddCache.invalidate('test');
    const { json: manifest } = await getJson('/odd/manifest');
    expect(Object.keys(manifest.titles).sort()).toEqual([...ODD_NAMES].sort());

    const all = await postJson('/odd/entries', { all: true });
    // One newline per title and one for the closing line, each ending a line
    // that parses by itself.
    expect(all.body.toString().split('\n')).toHaveLength(ODD_NAMES.length + 2);
    const lines = ndjsonLines(all.body);
    expect(lines.map((line) => line.value.title)).toEqual(ODD_NAMES);
    for (const line of lines) {
      expect(line.value.entry).toEqual({ text: line.value.title, len: line.value.title.length });
      expect(line.value.hash).toBe(manifest.titles[line.value.title].hash);
      expect(short(entryBytesOf(line))).toBe(line.value.hash);
    }

    // Asked by name, Object.prototype's names are titles like any other: the
    // one the library has is found, the ones it does not are missing.
    const asked = ['__proto__', 'constructor', 'toString', 'Line\nbreak', '1917'];
    const picked = ndjsonLines((await postJson('/odd/entries', { titles: asked })).body).map((l) => l.value);
    expect(picked.map((line) => line.title)).toEqual(asked);
    expect(picked.map((line) => Boolean(line.missing))).toEqual([false, true, true, false, false]);
    expect(picked[0].entry).toEqual({ text: '__proto__', len: 9 });
  });

  it('sends a raw U+2028 or U+2029 inside a title as is: split on 0x0A, the line gives the name back', async () => {
    oddCache.invalidate('test');
    const { json: manifest } = await getJson('/odd/manifest');
    const names = ['Separator inside', 'Paragraph inside'];
    for (const encoding of ['identity', 'gzip']) {
      const res = await postJson('/odd/entries', { titles: names }, { 'Accept-Encoding': encoding });
      const body = encoding === 'gzip' ? gunzipSync(res.body) : res.body;
      // The raw UTF-8 bytes, not a \u escape: a reader that also split on
      // these (Node's readline does) would cut both lines in two.
      for (const separator of [' ', ' ']) {
        expect(JSON.stringify(separator)).toBe(`"${separator}"`);
        expect(body.includes(Buffer.from(separator))).toBe(true);
      }
      expect(body.includes(Buffer.from('\\u2028'))).toBe(false);
      expect(body.includes(Buffer.from('\\u2029'))).toBe(false);

      const lines = ndjsonLines(body);
      expect(lines.map((line) => line.value.title)).toEqual(names);
      for (const line of lines) {
        expect(line.value.entry).toEqual({ text: line.value.title, len: line.value.title.length });
        expect(line.value.hash).toBe(manifest.titles[line.value.title].hash);
        expect(short(entryBytesOf(line))).toBe(line.value.hash);
      }
    }
  });

  it('closes every answer with {"end":true,"count":N}, N the title lines sent, missing ones included', async () => {
    const endsWith = (body, count) => body.subarray(-closingBytes(count).length).equals(closingBytes(count));

    // A list: a repeat is sent once, a title the library lacks is a line.
    const list = await postJson('/media/movies/entries', {
      titles: ['Zeta Movie', 'No Such Movie', 'Alpha Movie', 'Zeta Movie'],
    });
    expect(endsWith(list.body, 3)).toBe(true);
    expect(ndjsonLines(list.body)).toHaveLength(3);

    // Only titles the library lacks.
    const missing = await postJson('/media/tv/entries', { titles: ['Gone 1', 'Gone 2'] });
    expect(missing.body.toString()).toBe(
      '{"title":"Gone 1","missing":true}\n{"title":"Gone 2","missing":true}\n{"end":true,"count":2}\n'
    );

    // All: one line per title of the manifest.
    for (const kind of ['movies', 'tv']) {
      const { json: manifest } = await getJson(`/media/${kind}/manifest`);
      const count = Object.keys(manifest.titles).length;
      expect(count).toBeGreaterThan(0);
      const all = await postJson(`/media/${kind}/entries`, { all: true });
      expect(endsWith(all.body, count)).toBe(true);
      expect(ndjsonLines(all.body)).toHaveLength(count);
    }

    // An empty list: the closing line alone.
    const empty = await postJson('/media/tv/entries', { titles: [] });
    expect(empty.status).toBe(200);
    expect(empty.body.equals(closingBytes(0))).toBe(true);

    // Gzipped, the same closing line inside.
    const gzipped = await postJson('/media/movies/entries', { titles: ['Alpha Movie', 'Gone'] }, { 'Accept-Encoding': 'gzip' });
    expect(gzipped.headers['content-encoding']).toBe('gzip');
    expect(endsWith(gunzipSync(gzipped.body), 2)).toBe(true);
  });

  it('refuses what is not an entries request', async () => {
    for (const payload of [
      [],
      {},
      { titles: 'Alpha Movie' },
      { titles: ['Alpha Movie', 7] },
      { titles: [null] },
      { all: false },
      { all: 'true' },
      { all: true, titles: ['Alpha Movie'] },
    ]) {
      const res = await postJson('/media/movies/entries', payload);
      expect([JSON.stringify(payload), res.status]).toEqual([JSON.stringify(payload), 400]);
      expect(JSON.parse(res.body).error).toBe('Bad request');
    }
    // Not JSON at all, or not said to be.
    expect((await postJson('/media/movies/entries', '{"titles": [')).status).toBe(400);
    const plain = await rawRequest('POST', '/media/movies/entries', {
      headers: { 'Content-Type': 'text/plain' },
      body: '{"all": true}',
    });
    expect(plain.status).toBe(400);
  });

  it('takes a list of every title in a big library, and refuses a body past its limit', async () => {
    expect(ENTRIES_REQUEST_BODY_LIMIT).toBe('8mb');
    // 30,000 folder names at the 255-byte maximum.
    const names = Array.from({ length: 30000 }, (_, i) => `${String(i).padStart(5, '0')}${'n'.repeat(250)}`);
    const payload = JSON.stringify({ titles: names });
    expect(payload.length).toBeLessThan(8 * 1024 * 1024);
    const res = await postJson('/media/movies/entries', payload);
    expect(res.status).toBe(200);
    const lines = ndjsonLines(res.body);
    expect(lines).toHaveLength(names.length);
    expect(lines.every((line) => line.value.missing === true)).toBe(true);

    const tooBig = await postJson('/media/movies/entries', { titles: ['x'.repeat(9 * 1024 * 1024)] });
    expect(tooBig.status).toBe(413);
  });

  it('sends gzip when the client takes it: the same lines', async () => {
    const identity = await postJson('/media/tv/entries', { all: true });
    const gzipped = await postJson('/media/tv/entries', { all: true }, { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(gzipped.status).toBe(200);
    expect(gzipped.headers['content-encoding']).toBe('gzip');
    expect(gzipped.headers.vary).toMatch(/Accept-Encoding/);
    expect(gunzipSync(gzipped.body).equals(identity.body)).toBe(true);
  });

  it('shows a rebuild between the manifest and the entries as a hash mismatch, not mixed data', async () => {
    const manifestRes = await rawRequest('GET', '/media/movies/manifest');
    const manifest = JSON.parse(manifestRes.body);

    const { hdr } = await db.get(`SELECT hdr FROM movies WHERE name = 'Alpha Movie'`);
    await db.run(`UPDATE movies SET hdr = 'Dolby Vision' WHERE name = 'Alpha Movie'`);
    try {
      movieCache.invalidate('scan tick');
      const res = await postJson('/media/movies/entries', { titles: ['Alpha Movie', 'Zeta Movie'] });
      expect(res.headers['x-manifest-etag']).not.toBe(manifestRes.headers.etag);

      const [alpha, zeta] = ndjsonLines(res.body);
      // The new entry, under its own hash: never under the hash the frontend
      // holds from the older manifest.
      expect(alpha.value.entry.hdr).toBe('Dolby Vision');
      expect(alpha.value.hash).not.toBe(manifest.titles['Alpha Movie'].hash);
      expect(short(entryBytesOf(alpha))).toBe(alpha.value.hash);
      // An unchanged title still matches.
      expect(zeta.value.hash).toBe(manifest.titles['Zeta Movie'].hash);

      // And the new manifest agrees with the line.
      const current = await getJson('/media/movies/manifest');
      expect(current.res.headers.etag).toBe(res.headers['x-manifest-etag']);
      expect(current.json.titles['Alpha Movie'].hash).toBe(alpha.value.hash);
    } finally {
      await db.run(`UPDATE movies SET hdr = ? WHERE name = 'Alpha Movie'`, [hdr]);
    }
  });

  it('answers 500 when the build fails, and builds again on the next request', async () => {
    brokenCache.invalidate('test');
    brokenLoads = 0;
    const failed = await postJson('/broken/entries', { all: true });
    expect(failed.status).toBe(500);
    expect(failed.body.toString()).toBe('Internal server error');
    expect((await postJson('/broken/entries', { all: true })).status).toBe(200);
  });
});

// ---------------------------------------------------------------- the stream

describe('the entries stream', () => {
  it('goes at the client\'s pace, and stays one generation when the cache is rebuilt under it', async () => {
    bigFill = 'a';
    bigCache.invalidate('test');
    const first = await bigCache.get();
    const firstManifest = JSON.parse((await rawRequest('GET', '/big/manifest')).body);
    const total = first.body.length;
    expect(total).toBeGreaterThan(48 * 1024 * 1024);

    // Ask for everything, and do not read.
    let response;
    const headersIn = new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ all: true }));
      const req = http.request(
        `${baseUrl}/big/entries`,
        { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
        (res) => {
          res.pause();
          response = res;
          resolve();
        }
      );
      req.on('error', reject);
      req.end(body);
    });
    await headersIn;
    const serverRes = lastServerResponse;
    await pause(300);

    // With the client stalled, the server holds back: what it has handed the
    // socket is a small part of the body.
    const inFlight = serverRes.socket.bytesWritten + serverRes.writableLength;
    expect(inFlight).toBeLessThan(total / 4);
    expect(serverRes.writableEnded).toBe(false);

    // Rebuild the cache under the stalled stream, with different content.
    bigFill = 'b';
    bigCache.invalidate('scan tick');
    const second = await bigCache.get();
    expect(second.body.equals(first.body)).toBe(false);

    // Now read it all: every line from the generation the response began with.
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.resume();
    await new Promise((resolve, reject) => {
      response.on('end', resolve);
      response.on('error', reject);
    });
    expect(response.headers['x-manifest-etag']).toBe((await getManifest(bigCache, first)).etag);

    const lines = ndjsonLines(Buffer.concat(chunks));
    expect(lines).toHaveLength(BIG_TITLES);
    for (const line of lines) {
      expect(line.value.hash).toBe(firstManifest.titles[line.value.title].hash);
      expect(line.value.entry.fill[0]).toBe('a');
      expect(short(entryBytesOf(line))).toBe(line.value.hash);
    }
  });

  it('has no closing line when the stream is cut off part-way', async () => {
    bigFill = 'a';
    bigCache.invalidate('test');
    const total = (await bigCache.get()).body.length;

    const chunks = [];
    let received = 0;
    let response;
    await new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ all: true }));
      const req = http.request(
        `${baseUrl}/big/entries`,
        { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
        (res) => {
          response = res;
          const serverRes = lastServerResponse;
          res.on('data', (chunk) => {
            chunks.push(chunk);
            received += chunk.length;
            // A few title lines in: the server's side of the connection dies.
            if (received > 2 * 1024 * 1024 && !serverRes.destroyed) serverRes.destroy();
          });
          // The response errors ('aborted') and closes; it never ends.
          res.on('error', () => {});
          res.on('close', resolve);
        }
      );
      req.on('error', reject);
      req.end(body);
    });

    expect(response.statusCode).toBe(200);
    expect(response.complete).toBe(false);
    const got = Buffer.concat(chunks);
    expect(got.length).toBeLessThan(total / 4);
    // Whole title lines arrived before the cut, and they look fine...
    const lines = splitLines(got);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(short(entryBytesOf(line))).toBe(line.value.hash);
    // ...but no closing line did, so a reader knows the answer is not whole.
    expect(lines.some((line) => Object.hasOwn(line.value, 'end'))).toBe(false);
    expect(got.includes(Buffer.from('{"end":'))).toBe(false);
  });
});

// ---------------------------------------------------------------- the pieces

describe('tvManifestKeys', () => {
  it('lists what JSON.stringify puts in the body, and nothing else', () => {
    const entry = {
      seasons: {
        'Season 1': { episodes: { S01E01: {}, S01E02: undefined, S01E03: {} } },
        'Season 2': { episodes: null },
        'Season 3': null,
        'Season 4': undefined,
        Specials: { lengths: {} },
      },
    };
    const keys = tvManifestKeys(entry);
    expect({ ...keys }).toEqual({
      'Season 1': ['S01E01', 'S01E03'],
      'Season 2': [],
      'Season 3': [],
      Specials: [],
    });
    expect(Object.keys(keys)).toEqual(Object.keys(JSON.parse(JSON.stringify(entry)).seasons));
  });

  it('keeps any key as a key, __proto__ included', () => {
    const entry = JSON.parse('{"seasons":{"__proto__":{"episodes":{"S01E01":{}}},"Season 1":{"episodes":{}}}}');
    expect(JSON.parse(JSON.stringify(tvManifestKeys(entry)))).toEqual(
      JSON.parse('{"__proto__":["S01E01"],"Season 1":[]}')
    );
  });

  it('has nothing to say about a show without seasons', () => {
    expect({ ...tvManifestKeys({ seasons: null }) }).toEqual({});
    expect({ ...tvManifestKeys({}) }).toEqual({});
  });
});

describe('buildManifest', () => {
  it('writes these exact bytes, format 2', async () => {
    const tv = await buildManifest({
      kind: 'tv',
      version: 1.0001,
      titles: [
        { name: 'B Show', hash: 'ab'.repeat(20), keys: { 'Season 1': ['S01E01', 'S01E02'], Specials: [] } },
        { name: 'A "Show" ', hash: '0123456789'.repeat(4), keys: {} },
      ],
    });
    expect(tv.body.toString()).toBe(
      '{"format":2,"kind":"tv","version":1.0001,"titles":{' +
        '"B Show":{"hash":"abababababababab","seasons":{"Season 1":["S01E01","S01E02"],"Specials":[]}},' +
        '"A \\"Show\\" ":{"hash":"0123456789012345","seasons":{}}}}'
    );
    expect(tv.etag).toBe(`W/"tv-manifest-${sha1(tv.body)}"`);
    expect(gunzipSync(tv.gzipBody).equals(tv.body)).toBe(true);

    const movies = await buildManifest({
      kind: 'movies',
      version: 1.0001,
      titles: [{ name: '1917', hash: 'f'.repeat(40) }],
    });
    expect(movies.body.toString()).toBe(
      '{"format":2,"kind":"movies","version":1.0001,"titles":{"1917":{"hash":"ffffffffffffffff"}}}'
    );
  });
});

describe('parseEntriesRequest', () => {
  it('reads a list, without repeats, in the order first asked, or all', () => {
    expect(parseEntriesRequest({ titles: ['b', 'a', 'b', ''] })).toEqual({ titles: ['b', 'a', ''] });
    expect(parseEntriesRequest({ all: true })).toEqual({ all: true });
  });

  it('refuses anything else', () => {
    for (const body of [undefined, null, 'all', [], {}, { titles: {} }, { titles: [1] }, { all: 1 }, { all: true, titles: [] }]) {
      expect(parseEntriesRequest(body).error).toEqual(expect.any(String));
    }
  });
});
