/**
 * The cached /media/tv and /media/movies bodies, end to end: fixture library on
 * disk → real scanner → real SQLite → the real builders → MediaPayloadCache →
 * the real route handler behind the real compression middleware, over HTTP.
 *
 * What it pins:
 *
 *   - the slim shape: every probe fact the frontend sync reads survives the
 *     trim, the rest of the entry is untouched, and the caption stubs are still
 *     decided from the full audio list;
 *   - the body parses to exactly what res.json sent before the cache;
 *   - the ETag is a function of the rows alone: same rows, same tag, whatever
 *     order SQLite returns them in; one changed row, a different tag (and only
 *     that title's hash moves);
 *   - a matching If-None-Match gets a 304 even with `Cache-Control: no-cache`,
 *     which Node's fetch adds to every conditional request and which Express's
 *     own freshness check answers with a full 200;
 *   - the cached bytes go out as they are: gzip when accepted, never
 *     recompressed by the middleware;
 *   - invalidation, the autoCaptions settings check and the 10-minute backstop.
 *
 * The ffprobe/mediainfo boundary is mocked, as in media-payload.test.mjs.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { promises as fs } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { gunzipSync } from 'zlib';

const tmpRoot = join(tmpdir(), `media-payload-cache-${randomUUID()}`);
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

// Everything infoManager.extractAdditionalMetadata records for a probed file.
const fullMeta = ({ audio, width = 3840, height = 2160, sizeGb = 42.5 }) => ({
  duration: 7200000,
  size: { kb: sizeGb * 1024 * 1024, mb: sizeGb * 1024, gb: sizeGb },
  format: { formatName: 'matroska,webm', formatLongName: 'Matroska / WebM', bitrate: 9000000 },
  audio,
  video: [
    {
      codec: 'hevc',
      frame_rate: '24000/1001',
      bitrate: 8000000,
      aspect_ratio: '16:9',
      width,
      height,
      pix_fmt: 'yuv420p10le',
      field_order: 'progressive',
      color_transfer: 'smpte2084',
      color_primaries: 'bt2020',
      color_space: 'bt2020nc',
      profile: 'Main 10',
      level: 153,
    },
    { codec: 'mjpeg', frame_rate: '0/0', bitrate: null, width: 600, height: 900 },
  ],
  width,
  height,
  dimensions: `${width}x${height}`,
});

// infoManager's shaped empty for a file it could not probe.
const SHAPED_EMPTY = {
  duration: null,
  size: { kb: null, mb: null, gb: null },
  format: null,
  audio: [],
  video: [],
  width: null,
  height: null,
  dimensions: null,
};

const probe = (uuid, additionalMetadata, { length = 7200000, dimensions = '3840x2160', hdr = 'HDR10' } = {}) => ({
  uuid,
  length,
  dimensions,
  hdr,
  mediaQuality: { isHDR: hdr !== null, format: 'HEVC', bitDepth: 10 },
  additionalMetadata,
});

const PROBE = {
  // First audio track Japanese, second English: the published copy keeps the
  // Japanese one only, and the English caption stub must still be offered.
  'Zeta.2160p.mkv': probe('uuid-zeta', fullMeta({ audio: [audioTrack('truehd', 8, 'jpn'), audioTrack('ac3', 6, 'eng')] })),
  'Alpha.1080p.mp4': probe(
    'uuid-alpha',
    fullMeta({ audio: [audioTrack('aac', 2, 'eng')], width: 1920, height: 1080, sizeGb: 4.2 }),
    { dimensions: '1920x1080', hdr: null }
  ),
  'Broken.mkv': probe('uuid-broken', SHAPED_EMPTY, { length: 0, dimensions: '', hdr: null }),
  'Some Show - S01E01.mkv': probe('uuid-s01e01', fullMeta({ audio: [audioTrack('eac3', 6, 'eng'), audioTrack('aac', 2, 'spa')] })),
  // A sidecar from before the probe recorded anything: an empty object.
  'Some Show - S01E02.mkv': probe('uuid-s01e02', {}),
  'Some Show - S01E03.mkv': probe('uuid-s01e03', fullMeta({ audio: [audioTrack('aac', 2, 'eng')] })),
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
const { initializeDatabase, releaseDatabase, getMovies, getTVShows } = sqliteDb;
const { injectMovieStubs, injectTvStubs } = await import(
  '../../components/caption-generator/domain/caption-stubs.mjs'
);
const { langMap } = await import('../../utils/languageMap.mjs');
const { buildMoviePayloadEntry, buildTvPayloadEntry, buildPayloadMap } = await import(
  '../../lib/mediaPayload.mjs'
);
const {
  MediaPayloadCache,
  PAYLOAD_CACHE_MAX_AGE_MS,
  createMediaListHandler,
  compressionFilter,
  autoCaptionsContextKey,
  ifNoneMatchMatches,
  serializeKeyedList,
} = await import('../../lib/mediaPayloadCache.mjs');
const express = (await import('express')).default;
const compression = (await import('compression')).default;

const TV_LIST_VERSION = 1.0001;
const MOVIE_LIST_VERSION = 1.0001;
const PREFIX = '/media';

let db;
let server;
let baseUrl;
let lastRequestCacheControl;
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
});
const tvCache = new MediaPayloadCache({
  kind: 'tv',
  version: TV_LIST_VERSION,
  builder: buildTvPayloadEntry,
  loadRows: loadShows,
  readContext,
});

let brokenLoads = 0;
const brokenCache = new MediaPayloadCache({
  kind: 'movies',
  version: MOVIE_LIST_VERSION,
  builder: buildMoviePayloadEntry,
  loadRows: async () => {
    brokenLoads += 1;
    if (brokenLoads === 1) throw new Error('database is locked');
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

/** A GET that hands back the bytes as sent (no automatic decompression). */
function rawGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, { headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** The entry as it was published before the trim: the stored facts in full. */
function untrimmedMovieEntry(row) {
  return { ...buildMoviePayloadEntry(row), additional_metadata: row.additional_metadata };
}

// What the frontend sync reads from a movie's probe facts
// (nextjs-stream MovieContentStrategy.extractVideoMetadataFromFileServerData,
// and the legacy flat sync's `additional_metadata.size.kb` priority leaf).
function movieFactsTheFrontendReads(entry) {
  const meta = entry.additional_metadata;
  return {
    duration: meta?.duration,
    dimensions: meta?.dimensions,
    width: meta?.width,
    height: meta?.height,
    size: meta?.size,
    sizeKb: meta?.size?.kb,
    codec: meta?.video?.[0]?.codec,
    bitrate: meta?.video?.[0]?.bitrate,
    frameRate: meta?.video?.[0]?.frame_rate,
    audioCodec: meta?.audio?.[0]?.codec,
    audioChannels: meta?.audio?.[0]?.channels,
  };
}

// What it reads from an episode's (EpisodeSyncService, flat sync videoInfo):
// the size, and whether the object is there at all.
function episodeFactsTheFrontendReads(episode) {
  return {
    present: Boolean(episode.additionalMetadata),
    size: episode.additionalMetadata?.size,
    sizeKb: episode.additionalMetadata?.size?.kb,
  };
}

function episodesOf(entryOrRow) {
  const out = {};
  for (const [seasonKey, season] of Object.entries(entryOrRow.seasons ?? {})) {
    for (const [episodeKey, episode] of Object.entries(season.episodes ?? {})) {
      out[`${seasonKey}/${episodeKey}`] = episode;
    }
  }
  return out;
}

// ---------------------------------------------------------------- setup

beforeAll(async () => {
  await writeFiles(join(MEDIA, 'movies', 'Zeta Movie'), ['Zeta.2160p.mkv']);
  await writeFiles(join(MEDIA, 'movies', 'Alpha Movie'), ['Alpha.1080p.mp4', 'Alpha.en.srt']);
  await writeFiles(join(MEDIA, 'movies', 'Probe Failed'), ['Broken.mkv']);
  await writeFiles(join(MEDIA, 'tv', 'Some Show', 'Season 1'), [
    'Some Show - S01E01.mkv',
    'Some Show - S01E02.mkv',
  ]);

  await fs.mkdir(DB_DIR, { recursive: true });
  db = await initializeDatabase();
  await scanAll();

  const app = express();
  app.use((req, res, next) => {
    lastRequestCacheControl = req.headers['cache-control'];
    next();
  });
  app.use(compression({ filter: compressionFilter }));
  app.get('/media/movies', createMediaListHandler(movieCache, { logger: quietLogger, errorLabel: 'Error fetching movies' }));
  app.get('/media/tv', createMediaListHandler(tvCache, { logger: quietLogger, errorLabel: 'Error fetching TV shows' }));
  app.get('/broken', createMediaListHandler(brokenCache, { logger: quietLogger, errorLabel: 'Error fetching movies' }));
  // Any other JSON route: the filter must leave the middleware working for it.
  app.get('/other', (req, res) => res.json({ filler: 'x'.repeat(8192) }));
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
  captionConfig = { enabled: false, languages: ['en'] };
  movieCache.invalidate('test');
  tvCache.invalidate('test');
});

// ---------------------------------------------------------------- slim shape

describe('the slim shape', () => {
  it('keeps every movie probe fact the frontend reads, and nothing else', async () => {
    for (const row of await getMovies()) {
      const published = buildMoviePayloadEntry(row);
      const before = untrimmedMovieEntry(row);
      expect(movieFactsTheFrontendReads(published)).toEqual(movieFactsTheFrontendReads(before));
      // The rest of the entry is exactly what it was.
      expect({ ...published, additional_metadata: null }).toEqual({ ...before, additional_metadata: null });
    }

    const zeta = buildMoviePayloadEntry((await getMovies()).find((r) => r.name === 'Zeta Movie'));
    expect(zeta.additional_metadata).toEqual({
      duration: 7200000,
      size: { kb: 42.5 * 1024 * 1024, mb: 42.5 * 1024, gb: 42.5 },
      audio: [{ codec: 'truehd', channels: 8 }],
      video: [{ codec: 'hevc', frame_rate: '24000/1001', bitrate: 8000000 }],
      width: 3840,
      height: 2160,
      dimensions: '3840x2160',
    });
  });

  it('keeps an unprobed movie\'s shaped empty as nulls and empty track lists', async () => {
    const row = (await getMovies()).find((r) => r.name === 'Probe Failed');
    expect(buildMoviePayloadEntry(row).additional_metadata).toEqual({
      duration: null,
      size: { kb: null, mb: null, gb: null },
      audio: [],
      video: [],
      width: null,
      height: null,
      dimensions: null,
    });
  });

  it('keeps an episode\'s size only, and an empty object where there was one', async () => {
    const [row] = await getTVShows();
    const published = buildTvPayloadEntry(row);
    const stored = episodesOf(row);
    const sent = episodesOf(published);
    expect(Object.keys(sent)).toEqual(Object.keys(stored));

    for (const key of Object.keys(stored)) {
      expect(episodeFactsTheFrontendReads(sent[key])).toEqual(episodeFactsTheFrontendReads(stored[key]));
      // Everything else on the episode is untouched, but the top-level
      // filename, length and dimensions, which are not published (the primary
      // source and the season maps below carry them).
      const { filename, length, dimensions, ...storedRest } = stored[key];
      expect({ filename, length, dimensions }).toEqual({
        filename: expect.any(String),
        length: expect.any(Number),
        dimensions: expect.any(String),
      });
      expect(Object.keys(sent[key])).toEqual(Object.keys(storedRest));
      expect({ ...sent[key], additionalMetadata: null }).toEqual({ ...storedRest, additionalMetadata: null });
    }
    expect(sent['Season 1/S01E01'].additionalMetadata).toEqual({
      size: { kb: 42.5 * 1024 * 1024, mb: 42.5 * 1024, gb: 42.5 },
    });
    expect(sent['Season 1/S01E02'].additionalMetadata).toEqual({});

    // The season's duration and dimensions maps, which the episode facts come
    // from, are untouched.
    expect(published.seasons['Season 1'].lengths).toEqual(row.seasons['Season 1'].lengths);
    expect(published.seasons['Season 1'].dimensions).toEqual(row.seasons['Season 1'].dimensions);
    expect(published.seasons['Season 1'].lengths.S01E01).toBe(7200000);
  });

  it('does not change the rows it publishes', async () => {
    const [row] = await getTVShows();
    const copy = JSON.parse(JSON.stringify(row));
    buildTvPayloadEntry(row);
    expect(row).toEqual(copy);
  });

  it('still offers a caption stub decided from the full audio list', async () => {
    captionConfig = { enabled: true, languages: ['en'] };
    const body = JSON.parse((await movieCache.get()).body);
    // English is the SECOND track; only the first is published.
    expect(body['Zeta Movie'].additional_metadata.audio).toEqual([{ codec: 'truehd', channels: 8 }]);
    expect(body['Zeta Movie'].urls.subtitles['English - Auto Generated']).toMatchObject({
      srcLang: 'en',
      autoGenerated: true,
      pending: true,
    });
  });
});

// ---------------------------------------------------------------- body and ETag

describe('the cached body and its ETag', () => {
  it('parses to exactly what res.json sent', async () => {
    const movies = await movieCache.get();
    const shows = await tvCache.get();
    expect(JSON.parse(movies.body)).toEqual({
      ...buildPayloadMap(await loadMovies(), buildMoviePayloadEntry),
      version: MOVIE_LIST_VERSION,
    });
    expect(JSON.parse(shows.body)).toEqual({
      ...buildPayloadMap(await loadShows(), buildTvPayloadEntry),
      version: TV_LIST_VERSION,
    });
    expect(gunzipSync(movies.gzipBody).equals(movies.body)).toBe(true);
  });

  it('keeps each title\'s entry and hash, in name order', async () => {
    const entry = await movieCache.get();
    expect(entry.titles.map((t) => t.name)).toEqual(['Alpha Movie', 'Probe Failed', 'Zeta Movie']);
    const parsed = JSON.parse(entry.body);
    for (const title of entry.titles) {
      const bytes = entry.body.subarray(title.start, title.end);
      expect(JSON.parse(bytes)).toEqual(parsed[title.name]);
      expect(title.hash).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('builds the same ETag from the same rows', async () => {
    const first = await movieCache.get();
    movieCache.invalidate('test');
    const second = await movieCache.get();
    expect(second).not.toBe(first);
    expect(second.etag).toBe(first.etag);
    expect(second.body.equals(first.body)).toBe(true);

    // An independent cache over the same rows agrees.
    const other = new MediaPayloadCache({
      kind: 'movies',
      version: MOVIE_LIST_VERSION,
      builder: buildMoviePayloadEntry,
      loadRows: loadMovies,
    });
    expect((await other.get()).etag).toBe(first.etag);
  });

  it('does not depend on the order SQLite returns the rows in', async () => {
    const before = await movieCache.get();

    // Give the alphabetically first title the highest rowid, so the unordered
    // SELECT getMovies used to run returns it last. (`SELECT name` alone would
    // read the unique name index, which is already in order.)
    await db.run(`UPDATE movies SET id = (SELECT MAX(id) + 1000 FROM movies) WHERE name = 'Alpha Movie'`);
    const unordered = (await db.all('SELECT * FROM movies')).map((r) => r.name);
    expect(unordered[unordered.length - 1]).toBe('Alpha Movie');

    expect((await getMovies()).map((r) => r.name)).toEqual(['Alpha Movie', 'Probe Failed', 'Zeta Movie']);
    movieCache.invalidate('test');
    const after = await movieCache.get();
    expect(after.etag).toBe(before.etag);
    expect(after.body.equals(before.body)).toBe(true);
  });

  it('changes the ETag when one row changes, and only that title\'s hash', async () => {
    const before = await movieCache.get();
    const { hdr } = await db.get(`SELECT hdr FROM movies WHERE name = 'Alpha Movie'`);
    await db.run(`UPDATE movies SET hdr = 'Dolby Vision' WHERE name = 'Alpha Movie'`);
    try {
      movieCache.invalidate('test');
      const after = await movieCache.get();
      expect(after.etag).not.toBe(before.etag);

      const changed = after.titles.filter((t, i) => t.hash !== before.titles[i].hash).map((t) => t.name);
      expect(changed).toEqual(['Alpha Movie']);
    } finally {
      await db.run(`UPDATE movies SET hdr = ? WHERE name = 'Alpha Movie'`, [hdr]);
    }
    movieCache.invalidate('test');
    expect((await movieCache.get()).etag).toBe(before.etag);
  });

  it('serializes awkward names and an empty library', async () => {
    const rows = [
      { name: 'Quote " and \\ backslash' },
      { name: '1917' },
      { name: 'Ünïcödé — title' },
    ];
    const { body, titles, etag } = await serializeKeyedList({
      kind: 'movies',
      rows,
      builder: (row) => ({ len: row.name.length }),
      version: 1.0001,
    });
    expect(JSON.parse(body)).toEqual({
      ...Object.fromEntries(rows.map(({ name }) => [name, { len: name.length }])),
      version: 1.0001,
    });
    for (const t of titles) expect(JSON.parse(body.subarray(t.start, t.end))).toEqual({ len: t.name.length });
    expect(etag).toMatch(/^W\/"movies-[0-9a-f]{40}"$/);

    const empty = await serializeKeyedList({ kind: 'tv', rows: [], builder: () => ({}), version: 1.0001 });
    expect(empty.body.toString()).toBe('{"version":1.0001}');
  });
});

// ---------------------------------------------------------------- HTTP

describe('GET over HTTP', () => {
  it('answers a matching If-None-Match with a 304, even with Cache-Control: no-cache', async () => {
    const first = await fetch(`${baseUrl}/media/tv`, { headers: { 'x-webhook-id': 'test' } });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    await first.arrayBuffer();
    expect(etag).toBe(tvCache.peek().etag);

    // Node's fetch sends If-None-Match with Cache-Control: no-cache on its own.
    const loadsBefore = tvLoads;
    const conditional = await fetch(`${baseUrl}/media/tv`, { headers: { 'If-None-Match': etag } });
    expect(lastRequestCacheControl).toBe('no-cache');
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('etag')).toBe(etag);
    expect((await conditional.arrayBuffer()).byteLength).toBe(0);

    // And said explicitly, on a plain request.
    const explicit = await rawGet('/media/tv', { 'If-None-Match': etag, 'Cache-Control': 'no-cache' });
    expect(explicit.status).toBe(304);
    expect(explicit.headers.etag).toBe(etag);
    expect(explicit.body.length).toBe(0);

    // A 304 built nothing.
    expect(tvLoads).toBe(loadsBefore);
  });

  it('matches weak, strong, listed and wildcard tags, and only those', async () => {
    const { etag } = await tvCache.get();
    const opaque = etag.slice(2);
    for (const header of [etag, opaque, `"other", ${etag}`, `W/"a,b", ${opaque}`, '*']) {
      expect((await rawGet('/media/tv', { 'If-None-Match': header })).status).toBe(304);
    }
    for (const header of ['W/"tv-0000"', `"${opaque}"`, opaque.slice(0, -2) + '"']) {
      expect((await rawGet('/media/tv', { 'If-None-Match': header })).status).toBe(200);
    }
  });

  it('sends the cached gzip bytes as they are, with today\'s headers', async () => {
    const entry = await tvCache.get();
    const res = await rawGet('/media/tv', { 'Accept-Encoding': 'gzip, deflate, br' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers.vary).toMatch(/Accept-Encoding/);
    expect(res.headers.etag).toBe(entry.etag);
    expect(Number(res.headers['content-length'])).toBe(entry.gzipBody.length);
    // Not recompressed: the very bytes the cache holds.
    expect(res.body.equals(entry.gzipBody)).toBe(true);
  });

  it('sends the identity bytes to a client that does not take gzip, uncompressed', async () => {
    const entry = await movieCache.get();
    for (const headers of [{}, { 'Accept-Encoding': 'br' }, { 'Accept-Encoding': 'identity' }]) {
      const res = await rawGet('/media/movies', headers);
      expect(res.status).toBe(200);
      // The middleware would brotli-compress the second; it must not touch it.
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers.etag).toBe(entry.etag);
      expect(res.body.equals(entry.body)).toBe(true);
    }
  });

  it('leaves compression on for every other response', async () => {
    const res = await rawGet('/other', { 'Accept-Encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(res.body)).filler).toHaveLength(8192);
  });

  it('serves the new body after an invalidation', async () => {
    const before = await fetch(`${baseUrl}/media/tv`);
    const oldEtag = before.headers.get('etag');
    const oldBody = await before.json();
    expect(Object.keys(oldBody['Some Show'].seasons['Season 1'].episodes)).toEqual(['S01E01', 'S01E02']);

    const seasonDir = join(MEDIA, 'tv', 'Some Show', 'Season 1');
    await fs.writeFile(join(seasonDir, 'Some Show - S01E03.mkv'), 'z'.repeat(64));
    try {
      await scanTVShows(db, join(MEDIA, 'tv'), PREFIX, MEDIA, langMap, false, async () => {});

      // Until the cache is told, the old body still stands.
      expect((await fetch(`${baseUrl}/media/tv`, { headers: { 'If-None-Match': oldEtag } })).status).toBe(304);

      tvCache.invalidate('scan tick');
      const after = await fetch(`${baseUrl}/media/tv`, { headers: { 'If-None-Match': oldEtag } });
      expect(after.status).toBe(200);
      expect(after.headers.get('etag')).not.toBe(oldEtag);
      const body = await after.json();
      expect(Object.keys(body['Some Show'].seasons['Season 1'].episodes)).toEqual(['S01E01', 'S01E02', 'S01E03']);
      expect(body['Some Show'].seasons['Season 1'].episodes.S01E03.additionalMetadata).toEqual({
        size: { kb: 42.5 * 1024 * 1024, mb: 42.5 * 1024, gb: 42.5 },
      });
    } finally {
      await fs.rm(join(seasonDir, 'Some Show - S01E03.mkv'));
      await scanTVShows(db, join(MEDIA, 'tv'), PREFIX, MEDIA, langMap, false, async () => {});
    }
  });

  it('answers 500 when the build fails, and builds again on the next request', async () => {
    const failed = await rawGet('/broken');
    expect(failed.status).toBe(500);
    expect(failed.body.toString()).toBe('Internal server error');

    const retried = await rawGet('/broken');
    expect(retried.status).toBe(200);
    expect(brokenLoads).toBe(2);
  });
});

// ---------------------------------------------------------------- invalidation

describe('when the cache is rebuilt', () => {
  it('shares one build between concurrent requests', async () => {
    const loadsBefore = movieLoads;
    const responses = await Promise.all(Array.from({ length: 6 }, () => rawGet('/media/movies')));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.headers.etag)).size).toBe(1);
    expect(movieLoads - loadsBefore).toBe(1);
  });

  it('does not keep a build that an invalidation overtook', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let loads = 0;
    const cache = new MediaPayloadCache({
      kind: 'movies',
      version: MOVIE_LIST_VERSION,
      builder: buildMoviePayloadEntry,
      loadRows: async () => {
        loads += 1;
        if (loads === 1) await gate;
        return loadMovies();
      },
    });

    const pending = cache.get();
    cache.invalidate('scan tick');
    release();
    const stale = await pending;
    expect(stale.etag).toBeTruthy(); // its requests are still answered
    expect(cache.peek()).toBeNull();

    await cache.get();
    expect(loads).toBe(2);
    expect(cache.peek()).not.toBeNull();
  });

  it('drops the body when the autoCaptions settings change, and only then', async () => {
    const withoutStubs = await movieCache.get();
    expect(await movieCache.checkContext()).toBe(false);
    expect(movieCache.peek()).toBe(withoutStubs);

    captionConfig = { enabled: true, languages: ['en'] };
    expect(await movieCache.checkContext()).toBe(true);
    expect(movieCache.peek()).toBeNull();

    const withStubs = await movieCache.get();
    expect(withStubs.etag).not.toBe(withoutStubs.etag);
    expect(JSON.parse(withStubs.body)['Alpha Movie'].urls.subtitles['English - Auto Generated']).toBeDefined();
    expect(await movieCache.checkContext()).toBe(false);
  });

  it('reads the stubs\' view of the settings: off, unset and unreadable are the same', () => {
    expect(autoCaptionsContextKey(null)).toBe(autoCaptionsContextKey({ enabled: false, languages: ['en'] }));
    expect(autoCaptionsContextKey({ enabled: true })).toBe(autoCaptionsContextKey(undefined));
    expect(autoCaptionsContextKey({ enabled: true, languages: ['en', 'es'] })).not.toBe(
      autoCaptionsContextKey({ enabled: true, languages: ['es', 'en'] })
    );
  });

  it('rebuilds a body older than the 10-minute backstop', async () => {
    let clock = 1_000_000;
    let loads = 0;
    const cache = new MediaPayloadCache({
      kind: 'movies',
      version: MOVIE_LIST_VERSION,
      builder: buildMoviePayloadEntry,
      loadRows: async () => {
        loads += 1;
        return loadMovies();
      },
      now: () => clock,
    });

    const first = await cache.get();
    clock += PAYLOAD_CACHE_MAX_AGE_MS - 1;
    expect(cache.peek()).toBe(first);
    clock += 1;
    expect(cache.peek()).toBeNull();

    const second = await cache.get();
    expect(loads).toBe(2);
    expect(second.etag).toBe(first.etag);
    expect(PAYLOAD_CACHE_MAX_AGE_MS).toBe(10 * 60 * 1000);
  });
});

describe('ifNoneMatchMatches', () => {
  it('compares weakly across a list and ignores anything that is not a tag', () => {
    const etag = 'W/"tv-abc"';
    expect(ifNoneMatchMatches('W/"tv-abc"', etag)).toBe(true);
    expect(ifNoneMatchMatches('"tv-abc"', etag)).toBe(true);
    expect(ifNoneMatchMatches(' "x" ,W/"tv-abc" ', etag)).toBe(true);
    expect(ifNoneMatchMatches('*', etag)).toBe(true);
    expect(ifNoneMatchMatches('"tv-ab", "tv-abcd"', etag)).toBe(false);
    expect(ifNoneMatchMatches('tv-abc', etag)).toBe(false);
    expect(ifNoneMatchMatches('"*"', etag)).toBe(false);
    expect(ifNoneMatchMatches(undefined, etag)).toBe(false);
    expect(ifNoneMatchMatches('', etag)).toBe(false);
  });
});
