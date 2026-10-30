/**
 * The library root's credits sidecar (`<library root>/credits.json`), end to
 * end: fixture library on disk → the scan tick's steps (scanLibraryCredits,
 * then the real scanners, then the clear point) → real SQLite → the caches,
 * wired as app.mjs wires them, behind the real list, manifest and entries
 * handlers, over HTTP.
 *
 * What it pins:
 *
 *   - both manifests carry `library.credits`, the same four-state value a
 *     title publishes: url and hash, absent, not-a-file (a directory of that
 *     name), or unreadable (a root that cannot be listed, or one that lists
 *     neither movies nor tv, as an unmounted share does: never absent);
 *   - no `library` key before any library scan stored a value (unknown);
 *   - the root file moving moves both manifest ETags; a scan that changed
 *     nothing moves neither, and rebuilds no body;
 *   - GET /media/<kind> and the entries lines are byte-identical whatever the
 *     library value is.
 *
 * The ffprobe/mediainfo boundary is mocked, as in media-manifest.test.mjs.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';

const tmpRoot = join(tmpdir(), `library-credits-${randomUUID()}`);
const MEDIA = join(tmpRoot, 'media');
const DB_DIR = join(tmpRoot, 'db');

process.env.MEDIA_DB_DIRECTORY = DB_DIR;
process.env.JIT_ELIGIBILITY_ENABLED = 'true';
process.env.JIT_TRANSCODER_URL = 'https://transcoder.test';

// ---------------------------------------------------------------- mocks

const probeFor = (name) => ({
  uuid: `uuid-${name}`, length: 1200000, dimensions: '1920x1080', hdr: null,
  mediaQuality: { isHDR: false },
  additionalMetadata: {
    format: { formatName: 'matroska,webm' },
    video: [{ codec: 'h264', pix_fmt: 'yuv420p', field_order: 'progressive' }],
    audio: [{ codec: 'aac', languageTag: 'eng' }],
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
  getAutoCaptionsConfigCached: jest.fn(async () => ({ enabled: false, languages: [] })),
}));
jest.unstable_mockModule('../../lib/metadataGenerator.mjs', () => ({
  isFrozenReason: jest.fn(() => false),
  refreshMissingEpisodes: jest.fn(async () => 0),
  MetadataGenerator: class {},
}));

const { scanMovies } = await import('../../components/media-scanner/domain/movie-scanner.mjs');
const { scanTVShows } = await import('../../components/media-scanner/domain/tv-scanner.mjs');
const { scanLibraryCredits } = await import('../../components/media-scanner/index.mjs');
const sqliteDb = await import('../../sqliteDatabase.mjs');
const { initializeDatabase, releaseDatabase, getMovies, getTVShows, getLibraryStateGeneration } = sqliteDb;
const { buildMoviePayloadEntry, buildTvPayloadEntry } = await import('../../lib/mediaPayload.mjs');
const { MediaPayloadCache, createMediaListHandler, compressionFilter, clearPayloadsAfterScan } = await import(
  '../../lib/mediaPayloadCache.mjs'
);
const { tvManifestKeys, buildManifest, createManifestHandler, createEntriesBodyParser, createEntriesHandler } =
  await import('../../lib/mediaManifest.mjs');
const { readManifestLibrary, mediaDataGeneration } = await import('../../lib/libraryCredits.mjs');
const express = (await import('express')).default;
const compression = (await import('compression')).default;

// ---------------------------------------------------------------- wiring (as app.mjs)

const PREFIX = '/media';
const VERSION = 1.0001;
const quietLogger = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };
const loads = { movies: 0, tv: 0 };

const movieCache = new MediaPayloadCache({
  kind: 'movies',
  version: VERSION,
  builder: buildMoviePayloadEntry,
  readLibrary: () => readManifestLibrary({ logger: quietLogger }),
  dataGeneration: mediaDataGeneration('movies'),
  loadRows: async () => {
    loads.movies += 1;
    return getMovies();
  },
});
const tvCache = new MediaPayloadCache({
  kind: 'tv',
  version: VERSION,
  builder: buildTvPayloadEntry,
  describe: tvManifestKeys,
  readLibrary: () => readManifestLibrary({ logger: quietLogger }),
  dataGeneration: mediaDataGeneration('tv_shows'),
  loadRows: async () => {
    loads.tv += 1;
    return getTVShows();
  },
});
const CACHES = [movieCache, tvCache];

let db;
let server;
let baseUrl;

// ---------------------------------------------------------------- helpers

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ROOT_FILE = join(MEDIA, 'credits.json');

async function scanTitles() {
  await scanMovies(db, join(MEDIA, 'movies'), PREFIX, MEDIA, {}, 1.0011, false, async () => {});
  await scanTVShows(db, join(MEDIA, 'tv'), PREFIX, MEDIA, {}, false, async () => {});
}

/** One scan tick, in app.mjs's order: library credits, the scans, the clear point. */
async function tick(root = MEDIA) {
  await scanLibraryCredits({ root, prefixPath: PREFIX });
  await scanTitles();
  clearPayloadsAfterScan(CACHES, { reason: 'test tick' });
}

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

async function manifest(kind) {
  const res = await rawRequest('GET', `/media/${kind}/manifest`);
  expect(res.status).toBe(200);
  return { etag: res.headers.etag, body: res.body, json: JSON.parse(res.body) };
}

/** What a reader of either kind sees outside the manifests: bodies and entries lines. */
async function everythingButManifests() {
  const out = {};
  for (const kind of ['movies', 'tv']) {
    const list = await rawRequest('GET', `/media/${kind}`);
    const payload = Buffer.from('{"all":true}');
    const entries = await rawRequest('POST', `/media/${kind}/entries`, {
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      body: payload,
    });
    expect(list.status).toBe(200);
    expect(entries.status).toBe(200);
    out[kind] = {
      listEtag: list.headers.etag,
      list: list.body.toString('base64'),
      entries: entries.body.toString('base64'),
      libraryEtag: entries.headers['x-library-etag'],
    };
  }
  return out;
}

// ---------------------------------------------------------------- setup

let withoutLibrary;

beforeAll(async () => {
  await fs.mkdir(join(MEDIA, 'movies', 'Root Movie'), { recursive: true });
  await fs.writeFile(join(MEDIA, 'movies', 'Root Movie', 'Root.mkv'), 'x'.repeat(64));
  await fs.mkdir(join(MEDIA, 'tv', 'Root Show', 'Season 1'), { recursive: true });
  await fs.writeFile(join(MEDIA, 'tv', 'Root Show', 'Season 1', 'Root Show - S01E01.mkv'), 'x'.repeat(64));

  await fs.mkdir(DB_DIR, { recursive: true });
  db = await initializeDatabase();
  // The titles only: no library scan has stored a value yet.
  await scanTitles();

  const app = express();
  app.use(compression({ filter: compressionFilter }));
  for (const cache of CACHES) {
    const opts = { logger: quietLogger, errorLabel: cache.kind };
    app.get(`/media/${cache.kind}`, createMediaListHandler(cache, opts));
    app.get(`/media/${cache.kind}/manifest`, createManifestHandler(cache, opts));
    app.post(`/media/${cache.kind}/entries`, createEntriesBodyParser(), createEntriesHandler(cache, opts));
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

// ---------------------------------------------------------------- tests

describe('library.credits in both manifests', () => {
  it('is no key at all before a library scan stored a value', async () => {
    for (const kind of ['movies', 'tv']) {
      const { json } = await manifest(kind);
      expect(Object.keys(json)).toEqual(['format', 'kind', 'version', 'titles']);
    }
    withoutLibrary = await everythingButManifests();
  });

  it('is absent when the root has no credits.json, right after version', async () => {
    await tick();
    for (const kind of ['movies', 'tv']) {
      const { json, body } = await manifest(kind);
      expect(json.format).toBe(2);
      expect(json.library).toEqual({ credits: { absent: true } });
      expect(body.toString().startsWith(
        `{"format":2,"kind":"${kind}","version":1.0001,"library":{"credits":{"absent":true}},"titles":{`
      )).toBe(true);
    }
  });

  it('moves neither ETag, and rebuilds no body, on a scan that changed nothing', async () => {
    const before = { movies: await manifest('movies'), tv: await manifest('tv') };
    const generation = getLibraryStateGeneration();
    const loadsBefore = { ...loads };

    await tick();
    expect(getLibraryStateGeneration()).toBe(generation);
    for (const kind of ['movies', 'tv']) {
      expect((await manifest(kind)).etag).toBe(before[kind].etag);
      const conditional = await rawRequest('GET', `/media/${kind}/manifest`, {
        headers: { 'If-None-Match': before[kind].etag, 'Cache-Control': 'no-cache' },
      });
      expect(conditional.status).toBe(304);
    }
    expect(loads).toEqual(loadsBefore);
  });

  it('carries url and hash for <root>/credits.json, and moves both ETags', async () => {
    const before = { movies: (await manifest('movies')).etag, tv: (await manifest('tv')).etag };
    const bytes = Buffer.from('{"schemaVersion":1,"assets":[{"path":"poster_collage.jpg"}]}');
    await fs.writeFile(ROOT_FILE, bytes);
    await tick();

    for (const kind of ['movies', 'tv']) {
      const { json, etag } = await manifest(kind);
      expect(json.library).toEqual({
        credits: { url: `${PREFIX}/credits.json?hash=${sha256(bytes)}`, hash: sha256(bytes) },
      });
      expect(etag).not.toBe(before[kind]);
    }
  });

  it('leaves the GET bodies and the entries lines byte-identical to those without it', async () => {
    expect(await everythingButManifests()).toEqual(withoutLibrary);
  });

  it('moves both ETags again when the root file is edited', async () => {
    const before = { movies: await manifest('movies'), tv: await manifest('tv') };
    const bytes = Buffer.from('{"schemaVersion":1,"assets":[{"path":"poster_collage.jpg","title":"edited"}]}');
    await fs.writeFile(ROOT_FILE, bytes);
    await tick();

    for (const kind of ['movies', 'tv']) {
      const after = await manifest(kind);
      expect(after.json.library.credits.hash).toBe(sha256(bytes));
      expect(after.json.library.credits.hash).not.toBe(before[kind].json.library.credits.hash);
      expect(after.etag).not.toBe(before[kind].etag);
      // Only the library value moved: the titles are as they were.
      expect(after.json.titles).toEqual(before[kind].json.titles);
    }
  });

  it('is not-a-file for a directory named credits.json, and absent again once it is gone', async () => {
    await fs.rm(ROOT_FILE);
    await fs.mkdir(ROOT_FILE);
    await tick();
    for (const kind of ['movies', 'tv']) {
      expect((await manifest(kind)).json.library).toEqual({ credits: { error: 'not-a-file' } });
    }

    await fs.rm(ROOT_FILE, { recursive: true });
    await tick();
    expect((await manifest('tv')).json.library).toEqual({ credits: { absent: true } });
  });

  it('is unreadable, never absent, for an empty mount point: a share that is not mounted', async () => {
    const before = (await manifest('movies')).etag;
    const mountPoint = join(tmpRoot, 'empty-mount-point');
    await fs.mkdir(mountPoint, { recursive: true });
    await scanLibraryCredits({ root: mountPoint, prefixPath: PREFIX });
    clearPayloadsAfterScan(CACHES, { reason: 'test tick' });
    for (const kind of ['movies', 'tv']) {
      expect((await manifest(kind)).json.library).toEqual({ credits: { error: 'unreadable' } });
    }
    expect((await manifest('movies')).etag).not.toBe(before);
  });

  it('is unreadable, never absent, when the root cannot be listed', async () => {
    await scanLibraryCredits({ root: join(tmpRoot, 'not-mounted'), prefixPath: PREFIX });
    clearPayloadsAfterScan(CACHES, { reason: 'test tick' });
    for (const kind of ['movies', 'tv']) {
      expect((await manifest(kind)).json.library).toEqual({ credits: { error: 'unreadable' } });
    }
    expect(await everythingButManifests()).toEqual(withoutLibrary);
  });
});

describe('buildManifest with a library value', () => {
  it('writes it after version, and nothing when there is none', async () => {
    const titles = [{ name: '1917', hash: 'f'.repeat(40) }];
    const library = { credits: { url: '/media/credits.json?hash=ab', hash: 'ab' } };
    const withLibrary = await buildManifest({ kind: 'movies', version: VERSION, titles, library });
    expect(withLibrary.body.toString()).toBe(
      '{"format":2,"kind":"movies","version":1.0001,' +
        '"library":{"credits":{"url":"/media/credits.json?hash=ab","hash":"ab"}},' +
        '"titles":{"1917":{"hash":"ffffffffffffffff"}}}'
    );
    const without = await buildManifest({ kind: 'movies', version: VERSION, titles });
    expect(without.body.toString()).toBe(
      '{"format":2,"kind":"movies","version":1.0001,"titles":{"1917":{"hash":"ffffffffffffffff"}}}'
    );
    expect(withLibrary.etag).not.toBe(without.etag);
  });
});
