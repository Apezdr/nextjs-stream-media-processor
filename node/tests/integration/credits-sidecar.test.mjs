/**
 * The credits sidecar, end to end: fixture library on disk → real scanners →
 * real SQLite → the real /media/movies and /media/tv builders, and the
 * manifest's per-title hash over the bytes they build.
 *
 * What it pins (the processor's part of the frontend's CREDITS_SIDECAR.md, repo root):
 *
 *   - a movie, a show and an episode with a sidecar publish `{ url, hash }`,
 *     the hash the SHA-256 of the file's bytes, which are never parsed;
 *   - without one, `{ absent: true }`; a frozen title (update_metadata: false,
 *     or an unparseable tmdb.config) publishes its sidecar all the same;
 *   - editing the file moves the hash, the url and the manifest title hash;
 *   - a stored `unreadable` is read again on the next scan though the
 *     directory did not change, becomes `{ url, hash }` once the file reads,
 *     and then stops bringing the title back; `not-a-file`, `too-large` and
 *     `empty` wait for the change that fixes them, which moves the directory
 *     hash;
 *   - a row written before credits existed (column NULL) publishes no
 *     `credits` key at all.
 *
 * The ffprobe/mediainfo boundary is mocked, as in media-payload.test.mjs.
 * Every movie video gets a current `.info` sidecar, so a movie whose folder
 * did not change is skipped and `reprocessed` counts only real re-reads.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';

const tmpRoot = join(tmpdir(), `credits-sidecar-${randomUUID()}`);
const MEDIA = join(tmpRoot, 'media');
const DB_DIR = join(tmpRoot, 'db');

process.env.MEDIA_DB_DIRECTORY = DB_DIR;
process.env.JIT_ELIGIBILITY_ENABLED = 'true';
process.env.JIT_TRANSCODER_URL = 'https://transcoder.test';

// ---------------------------------------------------------------- mocks

const INFO_VERSION = 1.0011;
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
  CURRENT_VERSION: INFO_VERSION,
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
const sqliteDb = await import('../../sqliteDatabase.mjs');
const { initializeDatabase, releaseDatabase, getMovies, getTVShows } = sqliteDb;
const { buildMoviePayloadEntry, buildTvPayloadEntry, buildPayloadMap } = await import('../../lib/mediaPayload.mjs');
const { serializeKeyedList } = await import('../../lib/mediaPayloadCache.mjs');
const { titleHash } = await import('../../lib/mediaManifest.mjs');

// ---------------------------------------------------------------- fixtures

const PREFIX = '/media';
const MOVIES = join(MEDIA, 'movies');
const TV = join(MEDIA, 'tv');
let db;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const FROZEN = JSON.stringify({ update_metadata: false });

/** A movie folder: its video with a current `.info`, plus any extra files. */
async function writeMovie(name, video, extra = {}) {
  const dir = join(MOVIES, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, video), 'x'.repeat(64));
  await fs.writeFile(join(dir, `${video}.info`), JSON.stringify({ version: INFO_VERSION }));
  for (const [file, content] of Object.entries(extra)) await fs.writeFile(join(dir, file), content);
}

async function writeShowFiles(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) await fs.writeFile(join(dir, file), content);
}

async function scanMoviesOnce() {
  return scanMovies(db, MOVIES, PREFIX, MEDIA, {}, INFO_VERSION, false, async () => {});
}
async function scanShowsOnce() {
  return scanTVShows(db, TV, PREFIX, MEDIA, {}, false, async () => {});
}

async function moviePayload() {
  return buildPayloadMap(await getMovies(), buildMoviePayloadEntry);
}
async function tvPayload() {
  return buildPayloadMap(await getTVShows(), buildTvPayloadEntry);
}

/** The manifest hash of each title, over the entry bytes the builders produce. */
async function manifestHashes(kind) {
  const rows = kind === 'movies' ? await getMovies() : await getTVShows();
  const builder = kind === 'movies' ? buildMoviePayloadEntry : buildTvPayloadEntry;
  const { titles } = await serializeKeyedList({ kind, rows, builder, version: 1.0001 });
  return Object.fromEntries(titles.map((t) => [t.name, titleHash(t.hash)]));
}

const MOVIE_CREDITS_V1 = Buffer.from('{"schemaVersion":1,"assets":[{"title":"one"}]}\n');
const FROZEN_CREDITS = Buffer.from('this is { not json, and is published anyway');
const SHOW_CREDITS = Buffer.from('{"schemaVersion":1,"assets":[]}');
const EPISODE_CREDITS = Buffer.from('{"schemaVersion":1,"assets":[{"title":"episode"}]}');

beforeAll(async () => {
  await writeMovie('Credited Movie', 'Credited.mkv', { 'credits.json': MOVIE_CREDITS_V1 });
  await writeMovie('Plain Movie', 'Plain.mkv');
  await writeMovie('Frozen Movie', 'Frozen.mkv', { 'tmdb.config': FROZEN, 'credits.json': FROZEN_CREDITS });
  await writeMovie('Broken Config Movie', 'Broken.mkv', { 'tmdb.config': '{not json', 'credits.json': '{}' });
  await writeMovie('Folder Movie', 'Folder.mkv');
  // Listed, but not a regular file: published as an error, not an absence.
  await fs.mkdir(join(MOVIES, 'Folder Movie', 'credits.json'));

  await writeShowFiles(join(TV, 'Credited Show'), { 'credits.json': SHOW_CREDITS });
  await writeShowFiles(join(TV, 'Credited Show', 'Season 1'), {
    'Credited Show - S01E01.mkv': 'x'.repeat(64),
    '01_credits.json': EPISODE_CREDITS,
    'Credited Show - S01E02.mkv': 'x'.repeat(64),
  });
  // Frozen, so nothing missing on disk brings it back: a scan with nothing
  // changed fast-skips it.
  await writeShowFiles(join(TV, 'Frozen Show'), { 'tmdb.config': FROZEN, 'credits.json': SHOW_CREDITS });
  await writeShowFiles(join(TV, 'Frozen Show', 'Season 1'), {
    'Frozen Show - S01E01.mkv': 'x'.repeat(64),
    '01_credits.json': EPISODE_CREDITS,
  });
  await writeShowFiles(join(TV, 'Plain Show', 'Season 1'), { 'Plain Show - S01E01.mkv': 'x'.repeat(64) });

  await fs.mkdir(DB_DIR, { recursive: true });
  db = await initializeDatabase();
  await scanMoviesOnce();
  await scanShowsOnce();
});

afterAll(async () => {
  if (db) await releaseDatabase(db);
  await sqliteDb.closeAllDatabaseConnections();
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows may still hold the sqlite file; the temp dir is the OS's to reclaim.
  }
});

// ---------------------------------------------------------------- movies

describe('/media/movies credits', () => {
  it('publishes url and hash for a movie with credits.json, the hash of its bytes', async () => {
    const h = sha256(MOVIE_CREDITS_V1);
    expect((await moviePayload())['Credited Movie'].credits).toEqual({
      url: `${PREFIX}/movies/Credited%20Movie/credits.json?hash=${h}`,
      hash: h,
    });
  });

  it('publishes absent for a movie without one', async () => {
    expect((await moviePayload())['Plain Movie'].credits).toEqual({ absent: true });
  });

  it('publishes a frozen movie\'s credits, and an unparseable tmdb.config\'s, without parsing the file', async () => {
    const payload = await moviePayload();
    expect(payload['Frozen Movie'].credits).toEqual({
      url: `${PREFIX}/movies/Frozen%20Movie/credits.json?hash=${sha256(FROZEN_CREDITS)}`,
      hash: sha256(FROZEN_CREDITS),
    });
    expect(payload['Broken Config Movie'].credits.hash).toBe(sha256('{}'));
  });

  it('publishes not-a-file, not an absence, for a credits.json that is not a regular file', async () => {
    expect((await moviePayload())['Folder Movie'].credits).toEqual({ error: 'not-a-file' });
  });

  it('skips every movie on a scan with nothing changed, the not-a-file one included', async () => {
    // Replacing the directory with a file moves the directory hash, so a
    // not-a-file is not read again on its own.
    const before = await moviePayload();
    const { reprocessed } = await scanMoviesOnce();
    expect(reprocessed).toBe(0);
    expect(await moviePayload()).toEqual(before);
  });

  it('moves the hash, the url and the manifest title hash when the file is edited', async () => {
    const hashesBefore = await manifestHashes('movies');
    const before = (await moviePayload())['Credited Movie'].credits;

    const v2 = Buffer.from('{"schemaVersion":1,"assets":[{"title":"one"},{"title":"two"}]}\n');
    await fs.writeFile(join(MOVIES, 'Credited Movie', 'credits.json'), v2);
    await scanMoviesOnce();

    const after = (await moviePayload())['Credited Movie'].credits;
    expect(after.hash).toBe(sha256(v2));
    expect(after.hash).not.toBe(before.hash);
    expect(after.url).toBe(`${PREFIX}/movies/Credited%20Movie/credits.json?hash=${sha256(v2)}`);
    expect(after.url).not.toBe(before.url);

    const hashesAfter = await manifestHashes('movies');
    expect(hashesAfter['Credited Movie']).not.toBe(hashesBefore['Credited Movie']);
    expect(hashesAfter['Plain Movie']).toBe(hashesBefore['Plain Movie']);
  });

  it('reads a stored error again with the directory unchanged, stores url and hash, then stops', async () => {
    // A read that failed on an earlier pass (a transient mount fault, a
    // permission since fixed by chmod, which moves no mtime): the stored value
    // is unreadable, the folder and its file are as they were.
    const good = (await moviePayload())['Frozen Movie'].credits;
    await db.run(`UPDATE movies SET credits = ? WHERE name = ?`, ['{"error":"unreadable"}', 'Frozen Movie']);
    expect((await moviePayload())['Frozen Movie'].credits).toEqual({ error: 'unreadable' });

    const retry = await scanMoviesOnce();
    expect(retry.reprocessed).toBe(1); // Frozen Movie, its directory unchanged
    expect((await moviePayload())['Frozen Movie'].credits).toEqual(good);

    expect((await scanMoviesOnce()).reprocessed).toBe(0);
  });

  it('turns not-a-file into url and hash once a file replaces it, and the title settles', async () => {
    const dir = join(MOVIES, 'Folder Movie');
    await fs.rm(join(dir, 'credits.json'), { recursive: true });
    await fs.writeFile(join(dir, 'credits.json'), MOVIE_CREDITS_V1);
    await scanMoviesOnce();

    expect((await moviePayload())['Folder Movie'].credits).toEqual({
      url: `${PREFIX}/movies/Folder%20Movie/credits.json?hash=${sha256(MOVIE_CREDITS_V1)}`,
      hash: sha256(MOVIE_CREDITS_V1),
    });
    expect((await scanMoviesOnce()).reprocessed).toBe(0);
  });

  it('does not read a too-large file again with the directory unchanged, and does once it is edited', async () => {
    const file = join(MOVIES, 'Credited Movie', 'credits.json');
    await fs.writeFile(file, Buffer.alloc(262144 + 1, 0x61));
    expect((await scanMoviesOnce()).reprocessed).toBe(1); // the write moved the directory
    expect((await moviePayload())['Credited Movie'].credits).toEqual({ error: 'too-large' });

    // The edit that fixes it is what brings it back, not every scan.
    expect((await scanMoviesOnce()).reprocessed).toBe(0);

    await fs.writeFile(file, MOVIE_CREDITS_V1);
    expect((await scanMoviesOnce()).reprocessed).toBe(1);
    expect((await moviePayload())['Credited Movie'].credits.hash).toBe(sha256(MOVIE_CREDITS_V1));
    expect((await scanMoviesOnce()).reprocessed).toBe(0);
  });
});

// ---------------------------------------------------------------- tv

describe('/media/tv credits', () => {
  it('publishes a show\'s credits.json and an episode\'s <NN>_credits.json, and absent for an episode without one', async () => {
    const show = (await tvPayload())['Credited Show'];
    expect(show.credits).toEqual({
      url: `${PREFIX}/tv/Credited%20Show/credits.json?hash=${sha256(SHOW_CREDITS)}`,
      hash: sha256(SHOW_CREDITS),
    });
    const episodes = show.seasons['Season 1'].episodes;
    expect(episodes.S01E01.credits).toEqual({
      url: `${PREFIX}/tv/Credited%20Show/Season%201/01_credits.json?hash=${sha256(EPISODE_CREDITS)}`,
      hash: sha256(EPISODE_CREDITS),
    });
    expect(episodes.S01E02.credits).toEqual({ absent: true });
  });

  it('publishes absent for a show without one, and a frozen show\'s credits all the same', async () => {
    const payload = await tvPayload();
    expect(payload['Plain Show'].credits).toEqual({ absent: true });
    expect(payload['Plain Show'].seasons['Season 1'].episodes.S01E01.credits).toEqual({ absent: true });
    expect(payload['Frozen Show'].credits.hash).toBe(sha256(SHOW_CREDITS));
    expect(payload['Frozen Show'].seasons['Season 1'].episodes.S01E01.credits.hash).toBe(sha256(EPISODE_CREDITS));
  });

  it('moves the hash, the url and the manifest title hash when an episode\'s file is edited', async () => {
    const hashesBefore = await manifestHashes('tv');
    const v2 = Buffer.from('{"schemaVersion":1,"assets":[{"title":"episode, edited"}]}');
    await fs.writeFile(join(TV, 'Frozen Show', 'Season 1', '01_credits.json'), v2);
    await scanShowsOnce();

    const credits = (await tvPayload())['Frozen Show'].seasons['Season 1'].episodes.S01E01.credits;
    expect(credits).toEqual({
      url: `${PREFIX}/tv/Frozen%20Show/Season%201/01_credits.json?hash=${sha256(v2)}`,
      hash: sha256(v2),
    });
    expect((await manifestHashes('tv'))['Frozen Show']).not.toBe(hashesBefore['Frozen Show']);
  });

  it('reads a stored episode error again with the directory unchanged, then clears the flag', async () => {
    const steady = (await scanShowsOnce()).reprocessed;
    const flag = async () =>
      (await sqliteDb.getTVShowNamesAndHashes()).find((s) => s.name === 'Frozen Show').credits_retry;
    expect(await flag()).toBe(0);

    // An episode read that failed on an earlier pass: its stored value is
    // unreadable and the show is flagged, the files on disk are as they were.
    const row = await db.get(`SELECT seasons FROM tv_shows WHERE name = 'Frozen Show'`);
    const seasons = JSON.parse(row.seasons);
    const good = seasons['Season 1'].episodes.S01E01.credits;
    seasons['Season 1'].episodes.S01E01.credits = { error: 'unreadable' };
    await db.run(`UPDATE tv_shows SET seasons = ?, credits_retry = 1 WHERE name = 'Frozen Show'`, [
      JSON.stringify(seasons),
    ]);

    expect((await scanShowsOnce()).reprocessed).toBe(steady + 1);
    expect((await tvPayload())['Frozen Show'].seasons['Season 1'].episodes.S01E01.credits).toEqual(good);
    expect(await flag()).toBe(0);
    expect((await scanShowsOnce()).reprocessed).toBe(steady);
  });

  it('does not flag an empty episode file, nor read it again until it is edited', async () => {
    const season = join(TV, 'Frozen Show', 'Season 1');
    const episode = async () => (await tvPayload())['Frozen Show'].seasons['Season 1'].episodes.S01E01.credits;
    const flag = async () =>
      (await sqliteDb.getTVShowNamesAndHashes()).find((s) => s.name === 'Frozen Show').credits_retry;

    await fs.writeFile(join(season, '01_credits.json'), '');
    const withShow = (await scanShowsOnce()).reprocessed; // the write moved the directory
    expect(await episode()).toEqual({ error: 'empty' });
    expect(await flag()).toBe(0);

    expect((await scanShowsOnce()).reprocessed).toBe(withShow - 1); // skipped, directory unchanged

    await fs.writeFile(join(season, '01_credits.json'), EPISODE_CREDITS);
    expect((await scanShowsOnce()).reprocessed).toBe(withShow); // the edit brings it back
    expect((await episode()).hash).toBe(sha256(EPISODE_CREDITS));
    expect((await scanShowsOnce()).reprocessed).toBe(withShow - 1);
  });
});

// ---------------------------------------------------------------- rows before credits

describe('a row written before credits existed', () => {
  it('publishes no credits key at all, never null', async () => {
    await db.run(`UPDATE movies SET credits = NULL WHERE name = 'Plain Movie'`);
    const movie = (await moviePayload())['Plain Movie'];
    expect(Object.hasOwn(movie, 'credits')).toBe(false);

    const row = await db.get(`SELECT seasons FROM tv_shows WHERE name = 'Plain Show'`);
    const seasons = JSON.parse(row.seasons);
    delete seasons['Season 1'].episodes.S01E01.credits;
    await db.run(`UPDATE tv_shows SET credits = NULL, seasons = ? WHERE name = 'Plain Show'`, [JSON.stringify(seasons)]);
    const show = (await tvPayload())['Plain Show'];
    expect(Object.hasOwn(show, 'credits')).toBe(false);
    expect(Object.hasOwn(show.seasons['Season 1'].episodes.S01E01, 'credits')).toBe(false);
    expect(JSON.stringify(show)).not.toContain('"credits"');
  });
});
