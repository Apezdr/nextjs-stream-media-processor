/**
 * The cached TV and movie bodies across scan ticks, end to end:
 * fixture library on disk → the real scanners → real SQLite and its table
 * generations → MediaPayloadCache → the real manifest and entries handlers,
 * over HTTP. The tick is run as app.mjs's runGenerateList runs it:
 * movies, then TV, then clearPayloadsAfterScan, failed when a scan threw or
 * the TV scan reported an error.
 *
 * What it pins:
 *
 *   - a scan of an unchanged library writes no row and moves no generation,
 *     though both scanners reach their upserts for every title (the fixture
 *     has no .info sidecars and no artwork, so every movie and show is
 *     reprocessed on every pass, as titles with missing art are in production);
 *   - after such a tick both bodies, their manifests and their entries stay as
 *     they were: no rebuild, and a matching If-None-Match is still a 304;
 *   - a tick that changes a row rebuilds the body of that table, and only that
 *     one, and its manifest's ETag moves; a manifest taken before it shows up in the
 *     entries as a hash mismatch, never as mixed data;
 *   - a tick that adds or deletes a title rebuilds;
 *   - a failed scan drops both bodies;
 *   - the autoCaptions settings check and the 10-minute backstop still drop a
 *     body that a quiet tick kept;
 *   - a write made outside a scan is picked up by the next clear point, and a
 *     build that began before such a write is not kept.
 *
 * The ffprobe/mediainfo boundary is mocked, as in media-payload-cache.test.mjs.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { promises as fs } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID, createHash } from 'crypto';

const tmpRoot = join(tmpdir(), `media-payload-generation-${randomUUID()}`);
const MEDIA = join(tmpRoot, 'media');
const DB_DIR = join(tmpRoot, 'db');

process.env.MEDIA_DB_DIRECTORY = DB_DIR;
process.env.JIT_ELIGIBILITY_ENABLED = 'true';
process.env.JIT_TRANSCODER_URL = 'https://transcoder.test';

// ---------------------------------------------------------------- probe facts

const audioTrack = (codec, channels, languageTag) => ({
  codec,
  channels,
  sample_rate: '48000',
  bitrate: 640000,
  language: languageTag,
  languageTag,
  title: null,
  disposition: { default: false, comment: false, visual_impaired: false, descriptions: false },
});

const meta = ({ audio, width = 1920, height = 1080 }) => ({
  duration: 7200000,
  size: { kb: 4404019.2, mb: 4300.8, gb: 4.2 },
  format: { formatName: 'matroska,webm', formatLongName: 'Matroska / WebM', bitrate: 9000000 },
  audio,
  video: [{ codec: 'hevc', frame_rate: '24000/1001', bitrate: 8000000, width, height }],
  width,
  height,
  dimensions: `${width}x${height}`,
});

const probe = (uuid, additionalMetadata, { dimensions = '1920x1080', hdr = null } = {}) => ({
  uuid,
  length: 7200000,
  dimensions,
  hdr,
  mediaQuality: { isHDR: hdr !== null, format: 'HEVC', bitDepth: 10 },
  additionalMetadata,
});

const PROBE = {
  'Zeta.2160p.mkv': probe('uuid-zeta', meta({ audio: [audioTrack('truehd', 8, 'eng')], width: 3840, height: 2160 }), {
    dimensions: '3840x2160',
    hdr: 'HDR10',
  }),
  'Alpha.1080p.mp4': probe('uuid-alpha', meta({ audio: [audioTrack('aac', 2, 'eng')] })),
  'Gamma.1080p.mp4': probe('uuid-gamma', meta({ audio: [audioTrack('aac', 2, 'eng')] })),
  'Some Show - S01E01.mkv': probe('uuid-s01e01', meta({ audio: [audioTrack('eac3', 6, 'eng')] })),
  'Some Show - S01E02.mkv': probe('uuid-s01e02', meta({ audio: [audioTrack('eac3', 6, 'eng')] })),
  'Some Show - S01E03.mkv': probe('uuid-s01e03', meta({ audio: [audioTrack('eac3', 6, 'eng')] })),
};

jest.unstable_mockModule('../../infoManager.mjs', () => ({
  CURRENT_VERSION: 1.0011,
  getInfo: jest.fn(async (filePath) => {
    const name = filePath.split(/[\\/]/).pop();
    const facts = PROBE[name];
    if (!facts) throw new Error(`no fixture probe for ${name}`);
    return JSON.parse(JSON.stringify(facts));
  }),
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

// The autoCaptions settings (Mongo in production), switchable per test.
let captionConfig = { enabled: false, languages: ['en'] };
jest.unstable_mockModule('../../components/caption-generator/data-access/caption-config.mjs', () => ({
  getAutoCaptionsConfigCached: jest.fn(async () => captionConfig),
}));
jest.unstable_mockModule('../../lib/metadataGenerator.mjs', () => ({
  isFrozenReason: jest.fn(() => false),
  refreshMissingEpisodes: jest.fn(async () => 0),
  MetadataGenerator: class {},
}));

const { scanMovies } = await import('../../components/media-scanner/domain/movie-scanner.mjs');
const { scanTVShows } = await import('../../components/media-scanner/domain/tv-scanner.mjs');
const sqliteDb = await import('../../sqliteDatabase.mjs');
const { initializeDatabase, releaseDatabase, getMovies, getTVShows, getMediaTableGeneration, deleteMovie } = sqliteDb;
const { injectMovieStubs, injectTvStubs } = await import(
  '../../components/caption-generator/domain/caption-stubs.mjs'
);
const { langMap } = await import('../../utils/languageMap.mjs');
const { buildMoviePayloadEntry, buildTvPayloadEntry } = await import('../../lib/mediaPayload.mjs');
const {
  MediaPayloadCache,
  PAYLOAD_CACHE_MAX_AGE_MS,
  compressionFilter,
  autoCaptionsContextKey,
  clearPayloadsAfterScan,
} = await import('../../lib/mediaPayloadCache.mjs');
const {
  TITLE_HASH_LENGTH,
  tvManifestKeys,
  peekManifest,
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
const quietLogger = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };

// ---------------------------------------------------------------- wiring (as app.mjs)

let movieLoads = 0;
let tvLoads = 0;

async function loadMovies() {
  movieLoads += 1;
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
const readContext = async () => autoCaptionsContextKey(captionConfig);

const movieCache = new MediaPayloadCache({
  kind: 'movies',
  version: MOVIE_LIST_VERSION,
  builder: buildMoviePayloadEntry,
  loadRows: loadMovies,
  readContext,
  dataGeneration: () => getMediaTableGeneration('movies'),
});
const tvCache = new MediaPayloadCache({
  kind: 'tv',
  version: TV_LIST_VERSION,
  builder: buildTvPayloadEntry,
  describe: tvManifestKeys,
  loadRows: loadShows,
  readContext,
  dataGeneration: () => getMediaTableGeneration('tv_shows'),
});
const CACHES = [tvCache, movieCache];

// ---------------------------------------------------------------- helpers

async function writeFiles(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  for (const f of files) await fs.writeFile(join(dir, f), 'x'.repeat(64));
}

let lastDropped = null;

/**
 * One scan tick, as runGenerateList runs it. Returns the scanners' summaries
 * and the kinds whose body the clear point dropped (also kept in lastDropped,
 * for a tick that throws).
 */
async function tick({ moviesDir = join(MEDIA, 'movies') } = {}) {
  let failed = true;
  const result = {};
  lastDropped = null;
  try {
    result.movies = await scanMovies(db, moviesDir, PREFIX, MEDIA, langMap, 1.0011, false, async () => {});
    result.tv = await scanTVShows(db, join(MEDIA, 'tv'), PREFIX, MEDIA, langMap, false, async () => {});
    failed = Boolean(result.tv?.error);
  } finally {
    lastDropped = clearPayloadsAfterScan(CACHES, { reason: 'scan tick', failed });
  }
  result.dropped = lastDropped;
  return result;
}

const generations = () => ({ movies: getMediaTableGeneration('movies'), tv_shows: getMediaTableGeneration('tv_shows') });
const loads = () => ({ movies: movieLoads, tv: tvLoads });

/** Every write to movies and tv_shows on the shared connection, logged by temp triggers. */
async function installWriteLog() {
  await db.exec('CREATE TEMP TABLE IF NOT EXISTS media_write_log (tbl TEXT, op TEXT, name TEXT)');
  for (const table of ['movies', 'tv_shows']) {
    for (const [op, row] of [['INSERT', 'NEW'], ['UPDATE', 'NEW'], ['DELETE', 'OLD']]) {
      await db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS log_${table}_${op.toLowerCase()} AFTER ${op} ON main.${table} ` +
          `BEGIN INSERT INTO media_write_log VALUES ('${table}', '${op.toLowerCase()}', ${row}.name); END`
      );
    }
  }
}
const writeLog = () => db.all('SELECT tbl, op, name FROM media_write_log');
const clearWriteLog = () => db.run('DELETE FROM media_write_log');

async function allRows() {
  return {
    movies: await db.all('SELECT * FROM movies ORDER BY name'),
    tv_shows: await db.all('SELECT * FROM tv_shows ORDER BY name'),
  };
}

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

function postJson(path, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return rawRequest('POST', path, {
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    body,
  });
}

/**
 * The title lines of an entries response: the parsed line and its entry bytes.
 * The response must end with the closing line, counting them.
 */
function entryLines(body) {
  const raws = body.toString('utf8').split('\n');
  expect(raws.pop()).toBe('');
  const end = JSON.parse(raws.pop());
  expect(end).toEqual({ end: true, count: raws.length });
  return raws.map((raw) => {
    const value = JSON.parse(raw);
    const head = `{"title":${JSON.stringify(value.title)},"hash":"${value.hash}","entry":`;
    return { value, entryBytes: Buffer.from(raw.slice(head.length, -1), 'utf8') };
  });
}

const shortHash = (bytes) => createHash('sha1').update(bytes).digest('hex').slice(0, TITLE_HASH_LENGTH);

// ---------------------------------------------------------------- setup

beforeAll(async () => {
  await writeFiles(join(MEDIA, 'movies', 'Zeta Movie'), ['Zeta.2160p.mkv']);
  await writeFiles(join(MEDIA, 'movies', 'Alpha Movie'), ['Alpha.1080p.mp4', 'Alpha.en.srt']);
  await writeFiles(join(MEDIA, 'tv', 'Some Show', 'Season 1'), [
    'Some Show - S01E01.mkv',
    'Some Show - S01E02.mkv',
  ]);

  await fs.mkdir(DB_DIR, { recursive: true });
  db = await initializeDatabase();
  await tick();
  await installWriteLog();

  const app = express();
  app.use(compression({ filter: compressionFilter }));
  const opts = (errorLabel) => ({ logger: quietLogger, errorLabel });
  for (const [path, cache] of [
    ['/media/movies', movieCache],
    ['/media/tv', tvCache],
  ]) {
    app.get(`${path}/manifest`, createManifestHandler(cache, opts('manifest')));
    app.post(`${path}/entries`, createEntriesBodyParser(), createEntriesHandler(cache, opts('entries')));
  }
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

beforeEach(async () => {
  captionConfig = { enabled: false, languages: ['en'] };
  for (const cache of CACHES) cache.invalidate('test');
  await clearWriteLog();
});

// ---------------------------------------------------------------- a quiet tick

describe('a scan of an unchanged library', () => {
  it('writes no row and moves no generation, though it reprocesses every title', async () => {
    const before = { generations: generations(), rows: await allRows() };

    const { movies, tv, dropped } = await tick();

    // Both scanners went all the way to their upserts for every title ...
    expect(movies).toEqual({ titles: 2, reprocessed: 2 });
    expect(tv).toEqual({ titles: 1, reprocessed: 1, error: null });
    // ... and not one statement changed a row.
    expect(await writeLog()).toEqual([]);
    expect(generations()).toEqual(before.generations);
    expect(await allRows()).toEqual(before.rows);
    expect(dropped).toEqual([]);
  });

  it('keeps both bodies: the next manifest request builds nothing, and a matching If-None-Match is still a 304', async () => {
    const tvFirst = await rawRequest('GET', '/media/tv/manifest');
    const movieFirst = await rawRequest('GET', '/media/movies/manifest');
    expect([tvFirst.status, movieFirst.status]).toEqual([200, 200]);
    const tvEntry = tvCache.peek();
    const movieEntry = movieCache.peek();
    const loadsBefore = loads();

    const { dropped } = await tick();
    expect(dropped).toEqual([]);
    expect(tvCache.peek()).toBe(tvEntry);
    expect(movieCache.peek()).toBe(movieEntry);

    // As the frontend sync asks: Node's fetch adds Cache-Control: no-cache.
    const tvConditional = await fetch(`${baseUrl}/media/tv/manifest`, { headers: { 'If-None-Match': tvFirst.headers.etag } });
    expect(tvConditional.status).toBe(304);
    expect(tvConditional.headers.get('etag')).toBe(tvFirst.headers.etag);
    const movieConditional = await fetch(`${baseUrl}/media/movies/manifest`, {
      headers: { 'If-None-Match': movieFirst.headers.etag },
    });
    expect(movieConditional.status).toBe(304);

    // A plain request gets the cached manifest, as it was.
    const tvAgain = await rawRequest('GET', '/media/tv/manifest');
    expect(tvAgain.headers.etag).toBe(tvFirst.headers.etag);
    expect(tvAgain.body.equals(tvFirst.body)).toBe(true);

    expect(loads()).toEqual(loadsBefore);
  });

  it('keeps the manifests and the entries on the same generation', async () => {
    const manifest = await rawRequest('GET', '/media/tv/manifest');
    expect(manifest.status).toBe(200);
    const builtManifest = peekManifest(tvCache.peek());
    const loadsBefore = loads();

    await tick();

    expect(peekManifest(tvCache.peek())).toBe(builtManifest);
    const conditional = await rawRequest('GET', '/media/tv/manifest', {
      headers: { 'If-None-Match': manifest.headers.etag, 'Cache-Control': 'no-cache' },
    });
    expect(conditional.status).toBe(304);

    const entries = await postJson('/media/tv/entries', { titles: ['Some Show'] });
    expect(entries.status).toBe(200);
    expect(entries.headers['x-manifest-etag']).toBe(manifest.headers.etag);
    const [line] = entryLines(entries.body);
    expect(line.value.hash).toBe(JSON.parse(manifest.body).titles['Some Show'].hash);

    expect(loads()).toEqual(loadsBefore);
  });
});

// ---------------------------------------------------------------- ticks that change rows

describe('a scan that changes rows', () => {
  it('rebuilds the body of the table that changed, and only that one, and its manifest moves', async () => {
    const tvFirst = await rawRequest('GET', '/media/tv/manifest');
    const movieFirst = await rawRequest('GET', '/media/movies/manifest');
    const oldManifestResponse = tvFirst;
    const oldManifest = JSON.parse(oldManifestResponse.body);
    const oldManifestEtag = oldManifestResponse.headers.etag;
    const before = { generations: generations(), loads: loads() };

    const episode = join(MEDIA, 'tv', 'Some Show', 'Season 1', 'Some Show - S01E03.mkv');
    await fs.writeFile(episode, 'z'.repeat(64));
    try {
      const { dropped } = await tick();
      expect(dropped).toEqual(['tv']);
      expect(await writeLog()).toEqual([{ tbl: 'tv_shows', op: 'update', name: 'Some Show' }]);
      expect(generations()).toEqual({
        movies: before.generations.movies,
        tv_shows: before.generations.tv_shows + 1,
      });

      const tvAfter = await rawRequest('GET', '/media/tv/manifest', { headers: { 'If-None-Match': tvFirst.headers.etag } });
      expect(tvAfter.status).toBe(200);
      expect(tvAfter.headers.etag).not.toBe(tvFirst.headers.etag);
      expect(JSON.parse(tvAfter.body).titles['Some Show'].seasons['Season 1']).toEqual([
        'S01E01',
        'S01E02',
        'S01E03',
      ]);

      const movieAfter = await rawRequest('GET', '/media/movies/manifest', {
        headers: { 'If-None-Match': movieFirst.headers.etag },
      });
      expect(movieAfter.status).toBe(304);
      expect(loads()).toEqual({ movies: before.loads.movies, tv: before.loads.tv + 1 });

      // A client holding the manifest from before the tick asks for the show:
      // the line carries the new hash over the bytes it sends, and the new
      // manifest's ETag, so the mismatch shows. Never the old hash on new bytes.
      const entries = await postJson('/media/tv/entries', { titles: ['Some Show'] });
      expect(entries.headers['x-manifest-etag']).not.toBe(oldManifestEtag);
      expect(entries.headers['x-manifest-etag']).toBe(tvAfter.headers.etag);
      expect(entries.headers['x-library-etag']).toBeUndefined();
      const [line] = entryLines(entries.body);
      expect(line.value.hash).not.toBe(oldManifest.titles['Some Show'].hash);
      expect(line.value.hash).toBe(shortHash(line.entryBytes));
      expect(Object.keys(line.value.entry.seasons['Season 1'].episodes)).toContain('S01E03');
    } finally {
      await fs.rm(episode, { force: true });
      await tick();
    }
  });

  it('rebuilds when a title is added, and again when it is deleted', async () => {
    const first = await rawRequest('GET', '/media/movies/manifest');
    const folder = join(MEDIA, 'movies', 'Gamma Movie');

    await writeFiles(folder, ['Gamma.1080p.mp4']);
    try {
      const added = await tick();
      expect(added.dropped).toEqual(['movies']);
      expect(await writeLog()).toEqual([{ tbl: 'movies', op: 'insert', name: 'Gamma Movie' }]);
      const withGamma = await rawRequest('GET', '/media/movies/manifest', { headers: { 'If-None-Match': first.headers.etag } });
      expect(withGamma.status).toBe(200);
      expect(Object.keys(JSON.parse(withGamma.body).titles)).toContain('Gamma Movie');

      await clearWriteLog();
      await fs.rm(folder, { recursive: true, force: true });
      const generationBefore = generations().movies;
      const deleted = await tick();
      expect(deleted.dropped).toEqual(['movies']);
      expect(await writeLog()).toEqual([{ tbl: 'movies', op: 'delete', name: 'Gamma Movie' }]);
      expect(generations().movies).toBe(generationBefore + 1);

      const withoutGamma = await rawRequest('GET', '/media/movies/manifest', {
        headers: { 'If-None-Match': withGamma.headers.etag },
      });
      expect(withoutGamma.status).toBe(200);
      expect(Object.keys(JSON.parse(withoutGamma.body).titles)).not.toContain('Gamma Movie');
      // The same rows as before the title came: the same ETag.
      expect(withoutGamma.headers.etag).toBe(first.headers.etag);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- failed scans

describe('a failed scan', () => {
  it('drops both bodies, though no row changed', async () => {
    const tvFirst = await rawRequest('GET', '/media/tv/manifest');
    const movieFirst = await rawRequest('GET', '/media/movies/manifest');
    const before = { generations: generations(), loads: loads() };

    await expect(tick({ moviesDir: join(MEDIA, 'no-such-folder') })).rejects.toThrow(/ENOENT/);
    expect(lastDropped).toEqual(['tv', 'movies']);
    expect(generations()).toEqual(before.generations);
    expect(tvCache.peek()).toBeNull();
    expect(movieCache.peek()).toBeNull();

    const tvAfter = await rawRequest('GET', '/media/tv/manifest', { headers: { 'If-None-Match': tvFirst.headers.etag } });
    const movieAfter = await rawRequest('GET', '/media/movies/manifest', { headers: { 'If-None-Match': movieFirst.headers.etag } });
    // Rebuilt, and the rows did not change: the same tags, so still 304s.
    expect([tvAfter.status, movieAfter.status]).toEqual([304, 304]);
    expect(loads()).toEqual({ movies: before.loads.movies + 1, tv: before.loads.tv + 1 });
  });

  it('drops both bodies when the scan reports that it failed, whatever the generations say', async () => {
    // The TV scanner returns the error that stopped it instead of throwing;
    // runGenerateList passes that on as `failed`.
    await tvCache.get();
    await movieCache.get();
    const before = generations();
    expect(clearPayloadsAfterScan(CACHES, { reason: 'scan tick', failed: true })).toEqual(['tv', 'movies']);
    expect(generations()).toEqual(before);
    expect(tvCache.peek()).toBeNull();
    expect(movieCache.peek()).toBeNull();
  });
});

// ---------------------------------------------------------------- the other clear points

describe('the other reasons a body is dropped', () => {
  it('the autoCaptions settings check still drops a body a quiet tick kept', async () => {
    const withoutStubs = await movieCache.get();
    await tick();
    expect(movieCache.peek()).toBe(withoutStubs);

    captionConfig = { enabled: true, languages: ['en'] };
    expect(await movieCache.checkContext()).toBe(true);
    expect(movieCache.peek()).toBeNull();

    const withStubs = await movieCache.get();
    expect(withStubs.body.equals(withoutStubs.body)).toBe(false);
    expect(JSON.parse(withStubs.body)['Alpha Movie'].urls.subtitles['English - Auto Generated']).toBeDefined();
  });

  it('the 10-minute backstop still rebuilds a body a quiet tick kept', async () => {
    let clock = 5_000_000;
    let built = 0;
    const cache = new MediaPayloadCache({
      kind: 'movies',
      version: MOVIE_LIST_VERSION,
      builder: buildMoviePayloadEntry,
      loadRows: async () => {
        built += 1;
        return loadMovies();
      },
      dataGeneration: () => getMediaTableGeneration('movies'),
      now: () => clock,
    });

    const first = await cache.get();
    await tick();
    expect(clearPayloadsAfterScan([cache], { reason: 'scan tick' })).toEqual([]);
    clock += PAYLOAD_CACHE_MAX_AGE_MS - 1;
    expect(cache.peek()).toBe(first);

    clock += 1;
    expect(cache.peek()).toBeNull();
    const second = await cache.get();
    expect(built).toBe(2);
    expect(second.body.equals(first.body)).toBe(true);
  });

  it('a cache with no generation to compare is always dropped', async () => {
    const blind = new MediaPayloadCache({
      kind: 'movies',
      version: MOVIE_LIST_VERSION,
      builder: buildMoviePayloadEntry,
      loadRows: loadMovies,
    });
    const unreadable = new MediaPayloadCache({
      kind: 'movies',
      version: MOVIE_LIST_VERSION,
      builder: buildMoviePayloadEntry,
      loadRows: loadMovies,
      dataGeneration: () => {
        throw new Error('no generation');
      },
    });
    await blind.get();
    await unreadable.get();
    expect(clearPayloadsAfterScan([blind, unreadable], { reason: 'scan tick' })).toEqual(['movies', 'movies']);
    expect(blind.peek()).toBeNull();
    expect(unreadable.peek()).toBeNull();
  });
});

// ---------------------------------------------------------------- writes outside a scan

describe('a write made outside a scan', () => {
  it('is picked up by the next clear point', async () => {
    const first = await rawRequest('GET', '/media/movies/manifest');
    const tvEntry = await tvCache.get();
    const generationBefore = generations().movies;

    try {
      // Not a scan: a writer called on its own.
      await deleteMovie('Alpha Movie');
      expect(generations().movies).toBe(generationBefore + 1);

      // The cache is not told until a clear point, as with a scan's writes.
      const meanwhile = await rawRequest('GET', '/media/movies/manifest', { headers: { 'If-None-Match': first.headers.etag } });
      expect(meanwhile.status).toBe(304);

      // The next clear point (here POST /media/scan's, which runs the same
      // check as the tick's) drops the movie body and keeps the TV one.
      expect(clearPayloadsAfterScan(CACHES, { reason: 'POST /media/scan' })).toEqual(['movies']);
      expect(tvCache.peek()).toBe(tvEntry);
      const after = await rawRequest('GET', '/media/movies/manifest', { headers: { 'If-None-Match': first.headers.etag } });
      expect(after.status).toBe(200);
      expect(Object.keys(JSON.parse(after.body).titles)).not.toContain('Alpha Movie');
    } finally {
      // The next tick puts the row back: the folder is still on disk.
      const { dropped } = await tick();
      expect(dropped).toEqual(['movies']);
    }
    const restored = await rawRequest('GET', '/media/movies/manifest');
    expect(restored.headers.etag).toBe(first.headers.etag);
  });

  it('is not missed by a build that began before it, and a build that began after it is kept', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let built = 0;
    const cache = new MediaPayloadCache({
      kind: 'movies',
      version: MOVIE_LIST_VERSION,
      builder: buildMoviePayloadEntry,
      loadRows: async () => {
        built += 1;
        if (built === 1) await gate;
        return loadMovies();
      },
      dataGeneration: () => getMediaTableGeneration('movies'),
    });

    try {
      const pending = cache.get();
      await deleteMovie('Zeta Movie');
      expect(clearPayloadsAfterScan([cache], { reason: 'scan tick' })).toEqual(['movies']);
      release();
      const overtaken = await pending;
      expect(overtaken.body.length).toBeGreaterThan(0); // its requests are still answered
      expect(cache.peek()).toBeNull();

      const fresh = await cache.get();
      expect(Object.keys(JSON.parse(fresh.body))).not.toContain('Zeta Movie');
      expect(clearPayloadsAfterScan([cache], { reason: 'scan tick' })).toEqual([]);
      expect(cache.peek()).toBe(fresh);
      expect(built).toBe(2);
    } finally {
      release();
      await tick();
    }
  });
});
