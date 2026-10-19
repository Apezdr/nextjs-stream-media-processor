/**
 * Branch 1 "movies table schema parity" tests (G-5 + F-1 + I-3):
 *
 *  - migration idempotency: an old-schema DB migrated at startup, then
 *    migrated again, ends with the same schema; a from-scratch DB built by
 *    initializeSchema (run twice) converges on the identical schema.
 *  - the metadata fingerprint (F-1): the string the scanner persists is
 *    EXACTLY what getMovieByName and getMovies read back, and both readers
 *    build the metadata URL's ?hash= from it.
 *  - pristine_metadata preservation (G-5): a save without a fresh payload
 *    keeps the prior value, on BOTH the movie change-guard path and the TV
 *    always-rewrite path.
 *  - *_source_url persistence (I-3): per-column COALESCE preservation on both
 *    upserts, plus the movie change-guard's bootstrap escape hatch (a
 *    provenance value for a still-NULL column lands on an unchanged directory).
 *
 * Uses the MEDIA_DB_DIRECTORY test seam so the real node/db files are never
 * touched. The seam must be set BEFORE sqliteDatabase.mjs is imported (the
 * module resolves its file paths at import time), hence the dynamic imports.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// utils/utils.mjs initializes the piscina blurhash worker pool at import time,
// which keeps the Jest process alive after the run (same reason the
// metadata-generator tests mock it). The sqlite import chain only needs
// fileExists — provide a real implementation of just that.
jest.unstable_mockModule('../../../utils/utils.mjs', () => ({
  fileExists: async (p) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
}));

const tmpDir = join(tmpdir(), `schema-parity-test-${randomUUID()}`);
// Must be set before the dynamic import of sqliteDatabase.mjs below.
process.env.MEDIA_DB_DIRECTORY = tmpDir;

// Pre-Branch-1 schema snapshot (hash + focal columns present, parity columns
// absent) — what a live DB looked like before this migration shipped.
const OLD_MOVIES_SQL = `
  CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    file_names TEXT,
    lengths TEXT,
    dimensions TEXT,
    urls TEXT,
    metadata_url TEXT,
    directory_hash TEXT,
    hdr TEXT,
    media_quality TEXT,
    additional_metadata TEXT,
    _id TEXT,
    poster_file_path TEXT,
    backdrop_file_path TEXT,
    logo_file_path TEXT,
    base_path TEXT,
    poster_hash TEXT,
    poster_mtime INTEGER,
    backdrop_hash TEXT,
    backdrop_mtime INTEGER,
    logo_hash TEXT,
    logo_mtime INTEGER,
    backdrop_focal TEXT,
    backdrop_focal_suggested TEXT
  );
`;

const OLD_TV_SHOWS_SQL = `
  CREATE TABLE IF NOT EXISTS tv_shows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    metadata TEXT,
    metadata_path TEXT,
    poster TEXT,
    posterBlurhash TEXT,
    logo TEXT,
    logoBlurhash TEXT,
    backdrop TEXT,
    backdropBlurhash TEXT,
    seasons TEXT,
    directory_hash TEXT,
    poster_file_path TEXT,
    backdrop_file_path TEXT,
    logo_file_path TEXT,
    base_path TEXT,
    poster_hash TEXT,
    poster_mtime INTEGER,
    backdrop_hash TEXT,
    backdrop_mtime INTEGER,
    logo_hash TEXT,
    logo_mtime INTEGER,
    backdrop_focal TEXT,
    backdrop_focal_suggested TEXT
  );
`;

let sqliteDb;       // sqliteDatabase.mjs module namespace
let db;             // singleton "main" handle (backed by the seeded old-schema file)

async function columnSpecs(handle, table) {
  const rows = await handle.all(`PRAGMA table_info(${table})`);
  return rows.map((r) => `${r.name}:${r.type}`).sort();
}

beforeAll(async () => {
  await fs.mkdir(tmpDir, { recursive: true });

  // Seed media.db with the OLD schema so initializeDatabase() below exercises
  // the real startup migration path against a pre-existing database.
  const seed = await open({ filename: join(tmpDir, 'media.db'), driver: sqlite3.Database });
  await seed.exec(OLD_MOVIES_SQL);
  await seed.exec(OLD_TV_SHOWS_SQL);
  await seed.close();

  sqliteDb = await import('../../../sqliteDatabase.mjs');
  db = await sqliteDb.initializeDatabase('main'); // runs initializeSchema + migrations
});

afterAll(async () => {
  await sqliteDb.closeAllDatabaseConnections();
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows can briefly hold the WAL file open; leave the temp dir behind.
  }
});

describe('schema parity migration', () => {
  it('adds the parity columns to a pre-existing old-schema database', async () => {
    const movieCols = await columnSpecs(db, 'movies');
    expect(movieCols).toEqual(expect.arrayContaining([
      'metadata:TEXT',
      'pristine_metadata:TEXT',
      'poster_source_url:TEXT',
      'backdrop_source_url:TEXT',
      'logo_source_url:TEXT',
    ]));

    const tvCols = await columnSpecs(db, 'tv_shows');
    expect(tvCols).toEqual(expect.arrayContaining([
      'pristine_metadata:TEXT',
      'poster_source_url:TEXT',
      'backdrop_source_url:TEXT',
      'logo_source_url:TEXT',
    ]));
    // tv_shows already had metadata TEXT — the migration must not duplicate it.
    expect(tvCols.filter((c) => c === 'metadata:TEXT')).toHaveLength(1);
  });

  it('is idempotent: re-running the migration and the full schema init changes nothing', async () => {
    const moviesBefore = await columnSpecs(db, 'movies');
    const tvBefore = await columnSpecs(db, 'tv_shows');

    await sqliteDb.migrateToSchemaParityColumns(db);
    await sqliteDb.migrateToSchemaParityColumns(db);
    await sqliteDb.initializeSchema('main', db); // full startup path, again

    expect(await columnSpecs(db, 'movies')).toEqual(moviesBefore);
    expect(await columnSpecs(db, 'tv_shows')).toEqual(tvBefore);
  });

  it('a from-scratch database converges on the identical schema as a migrated one', async () => {
    const fresh = await open({ filename: join(tmpDir, 'fresh.db'), driver: sqlite3.Database });
    try {
      await sqliteDb.initializeSchema('main', fresh);
      await sqliteDb.initializeSchema('main', fresh); // fresh-DB idempotency

      expect(await columnSpecs(fresh, 'movies')).toEqual(await columnSpecs(db, 'movies'));
      expect(await columnSpecs(fresh, 'tv_shows')).toEqual(await columnSpecs(db, 'tv_shows'));
    } finally {
      await fresh.close();
    }
  });
});

describe('movie metadata fingerprint (F-1)', () => {
  const NAME = 'Oscillation Movie (2024)';
  // Canonical serialization: compact JSON.stringify of the parsed file — the
  // exact string movie-scanner.mjs produces and persists.
  const FINGERPRINT = JSON.stringify({ id: 4242, title: 'Oscillation Movie', overview: 'x' });
  const URLS = {
    mp4: '/movies/Oscillation%20Movie%20(2024)/movie.mp4',
    metadata: '/movies/Oscillation%20Movie%20(2024)/metadata.json',
    mediaLastModified: '2024-01-01T00:00:00.000Z',
  };

  it('the persisted fingerprint is returned verbatim by the readers, and keys their metadata URL', async () => {
    await sqliteDb.insertOrUpdateMovie(
      NAME, ['movie.mp4'], { 'movie.mp4': 5400 }, { 'movie.mp4': '1920x1080' },
      URLS, URLS.metadata, 'dirhash-1', 'SDR', null, {}, 'tmdb_4242',
      null, null, null, null, null, '{"x":0.5,"y":0.5}', null,
      FINGERPRINT, null
    );

    const byName = await sqliteDb.getMovieByName(NAME);
    const fromList = (await sqliteDb.getMovies()).find((m) => m.name === NAME);

    expect(byName.metadata).toBe(FINGERPRINT);
    expect(fromList.metadata).toBe(FINGERPRINT);
    // lib/metadataUrlHash.mjs: the URL's ?hash= is the sha256 of these bytes.
    const expected = `${URLS.metadata}?hash=${createHash('sha256').update(FINGERPRINT).digest('hex')}`;
    expect(byName.urls.metadata).toBe(expected);
    expect(fromList.urls.metadata).toBe(expected);
  });
});

describe('pristine_metadata preservation (G-5)', () => {
  it('movie: preserved through guard-blocked saves and through updates without a fresh payload', async () => {
    const NAME = 'Pristine Movie (2024)';
    const save = (directoryHash, urls, pristine) => sqliteDb.insertOrUpdateMovie(
      NAME, ['movie.mp4'], {}, {}, urls, '', directoryHash, null, null, {}, 'tmdb_7',
      null, null, null, null, null, '{"x":0.5,"y":0.5}', null,
      '{"id":7}', pristine
    );

    // Initial save carries a genuine-fetch payload.
    await save('h1', { mp4: '/a.mp4' }, '{"raw":"P1"}');
    expect((await sqliteDb.getMovieByName(NAME)).pristineMetadata).toBe('{"raw":"P1"}');

    // Unchanged directory_hash → the change-guard skips the whole update
    // (focal + metadata escape hatches are both satisfied non-NULL above):
    // urls stay stale AND pristine stays put.
    await save('h1', { mp4: '/CHANGED.mp4' }, null);
    let row = await sqliteDb.getMovieByName(NAME);
    expect(row.urls.mp4).toBe('/a.mp4');
    expect(row.pristineMetadata).toBe('{"raw":"P1"}');

    // Changed directory_hash + no fresh payload → the update applies but
    // COALESCE carries the stored pristine payload forward.
    await save('h2', { mp4: '/b.mp4' }, null);
    row = await sqliteDb.getMovieByName(NAME);
    expect(row.urls.mp4).toBe('/b.mp4');
    expect(row.pristineMetadata).toBe('{"raw":"P1"}');

    // A fresh genuine-fetch payload replaces it.
    await save('h3', { mp4: '/c.mp4' }, '{"raw":"P2"}');
    expect((await sqliteDb.getMovieByName(NAME)).pristineMetadata).toBe('{"raw":"P2"}');
  });

  it('movie: metadata backfill escape hatch lets a fingerprint land on an unchanged directory', async () => {
    const NAME = 'Backfill Movie (2024)';
    const save = (urls, metadata) => sqliteDb.insertOrUpdateMovie(
      NAME, [], {}, {}, urls, '', 'h1', null, null, {}, null,
      null, null, null, null, null, '{"x":0.5,"y":0.5}', null,
      metadata, null
    );

    // Simulates a pre-migration row: no fingerprint stored yet.
    await save({ mp4: '/a.mp4' }, null);
    expect((await sqliteDb.getMovieByName(NAME)).metadata).toBeNull();

    // Same directory_hash, but now the scanner has a fingerprint → the
    // (movies.metadata IS NULL AND excluded.metadata IS NOT NULL) hatch fires.
    await save({ mp4: '/a.mp4' }, '{"id":9}');
    expect((await sqliteDb.getMovieByName(NAME)).metadata).toBe('{"id":9}');
  });

  it('tv: the always-rewrite upsert carries the stored payload forward when no fresh payload arrives', async () => {
    const NAME = 'Pristine Show';
    const save = (metadata, pristine) => sqliteDb.insertOrUpdateTVShow(
      NAME, metadata, '/tv/Pristine%20Show/metadata.json',
      null, null, null, null, null, null, {},
      null, null, null, null, 'dirhash-tv', null, null, null,
      pristine
    );

    await save('{"id":11,"name":"v1"}', '{"raw":"P1"}');
    expect((await sqliteDb.getTVShowByName(NAME)).pristineMetadata).toBe('{"raw":"P1"}');

    // No guard on TV — the rewrite must actually happen (metadata moves)
    // while pristine_metadata is carried forward, not nulled.
    await save('{"id":11,"name":"v2"}', null);
    let row = await sqliteDb.getTVShowByName(NAME);
    expect(row.metadata).toBe('{"id":11,"name":"v2"}');
    expect(row.pristineMetadata).toBe('{"raw":"P1"}');

    await save('{"id":11,"name":"v3"}', '{"raw":"P2"}');
    expect((await sqliteDb.getTVShowByName(NAME)).pristineMetadata).toBe('{"raw":"P2"}');
  });
});

describe('image source-url provenance persistence (I-3)', () => {
  const CDN = 'https://image.tmdb.org/t/p/original';

  it('movie: per-column COALESCE — a null update preserves each stored URL independently', async () => {
    const NAME = 'Provenance Movie (2024)';
    const save = (directoryHash, sourceUrls) => sqliteDb.insertOrUpdateMovie(
      NAME, ['movie.mp4'], {}, {}, { mp4: '/a.mp4' }, '', directoryHash, null, null, {}, 'tmdb_21',
      null, null, null, null, null, '{"x":0.5,"y":0.5}', null,
      '{"id":21}', null, sourceUrls
    );

    await save('h1', { poster: `${CDN}/p1.jpg`, backdrop: `${CDN}/b1.jpg`, logo: null });
    let row = await sqliteDb.getMovieByName(NAME);
    expect(row.posterSourceUrl).toBe(`${CDN}/p1.jpg`);
    expect(row.backdropSourceUrl).toBe(`${CDN}/b1.jpg`);
    expect(row.logoSourceUrl).toBeNull();

    // Changed directory, no new provenance at all → both stored URLs survive.
    await save('h2', null);
    row = await sqliteDb.getMovieByName(NAME);
    expect(row.posterSourceUrl).toBe(`${CDN}/p1.jpg`);
    expect(row.backdropSourceUrl).toBe(`${CDN}/b1.jpg`);

    // Per-kind update: only the poster re-downloaded this pass — the backdrop
    // column must not be nulled by the poster's update.
    await save('h3', { poster: `${CDN}/p2.jpg`, backdrop: null, logo: null });
    row = await sqliteDb.getMovieByName(NAME);
    expect(row.posterSourceUrl).toBe(`${CDN}/p2.jpg`);
    expect(row.backdropSourceUrl).toBe(`${CDN}/b1.jpg`);
  });

  it('movie: bootstrap escape hatch lands adoption on an UNCHANGED directory, and converged rows stop rewriting', async () => {
    const NAME = 'Adoption Movie (2024)';
    const save = (urls, sourceUrls) => sqliteDb.insertOrUpdateMovie(
      NAME, [], {}, {}, urls, '', 'h1', null, null, {}, null,
      null, null, null, null, null, '{"x":0.5,"y":0.5}', null,
      '{"id":22}', null, sourceUrls
    );

    // Pre-I-3-shaped row: no provenance stored.
    await save({ mp4: '/a.mp4' }, null);
    expect((await sqliteDb.getMovieByName(NAME)).posterSourceUrl).toBeNull();

    // Same directory_hash, but this pass adopted a URL for the NULL column →
    // the (poster_source_url IS NULL AND excluded IS NOT NULL) hatch fires.
    await save({ mp4: '/a.mp4' }, { poster: `${CDN}/adopted.jpg`, backdrop: null, logo: null });
    expect((await sqliteDb.getMovieByName(NAME)).posterSourceUrl).toBe(`${CDN}/adopted.jpg`);

    // Converged: same hash, same adoption value → no hatch is satisfied, the
    // guard blocks the whole update (urls stay stale), and provenance holds.
    await save({ mp4: '/CHANGED.mp4' }, { poster: `${CDN}/adopted.jpg`, backdrop: null, logo: null });
    const row = await sqliteDb.getMovieByName(NAME);
    expect(row.urls.mp4).toBe('/a.mp4');
    expect(row.posterSourceUrl).toBe(`${CDN}/adopted.jpg`);
  });

  it('tv: the always-rewrite upsert COALESCE-preserves each stored URL independently', async () => {
    const NAME = 'Provenance Show';
    const save = (metadata, sourceUrls) => sqliteDb.insertOrUpdateTVShow(
      NAME, metadata, '/tv/Provenance%20Show/metadata.json',
      null, null, null, null, null, null, {},
      null, null, null, null, 'dirhash-tv', null, null, null,
      null, sourceUrls
    );

    await save('{"id":31,"name":"v1"}', { poster: `${CDN}/p1.jpg`, backdrop: null, logo: `${CDN}/l1.svg` });
    let row = await sqliteDb.getTVShowByName(NAME);
    expect(row.posterSourceUrl).toBe(`${CDN}/p1.jpg`);
    expect(row.logoSourceUrl).toBe(`${CDN}/l1.svg`);

    // The rewrite happens (metadata moves), provenance carries forward.
    await save('{"id":31,"name":"v2"}', null);
    row = await sqliteDb.getTVShowByName(NAME);
    expect(row.metadata).toBe('{"id":31,"name":"v2"}');
    expect(row.posterSourceUrl).toBe(`${CDN}/p1.jpg`);
    expect(row.logoSourceUrl).toBe(`${CDN}/l1.svg`);

    // Per-kind replacement leaves the other columns alone.
    await save('{"id":31,"name":"v3"}', { poster: `${CDN}/p2.jpg`, backdrop: null, logo: null });
    row = await sqliteDb.getTVShowByName(NAME);
    expect(row.posterSourceUrl).toBe(`${CDN}/p2.jpg`);
    expect(row.logoSourceUrl).toBe(`${CDN}/l1.svg`);
  });
});
