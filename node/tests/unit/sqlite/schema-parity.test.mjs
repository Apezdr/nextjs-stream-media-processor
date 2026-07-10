/**
 * Branch 1 "movies table schema parity" tests (G-5 + F-1 + I-3):
 *
 *  - migration idempotency: an old-schema DB migrated at startup, then
 *    migrated again, ends with the same schema; a from-scratch DB built by
 *    initializeSchema (run twice) converges on the identical schema.
 *  - oscillation guard (F-1): the metadata fingerprint string the scanner
 *    persists is EXACTLY what both hash writers read back — the column value
 *    via getMovieByName (scanner inline rehash) and via getMovies (scheduled
 *    sweep) hash to the same stored movie hash.
 *  - pristine_metadata preservation (G-5): a save without a fresh payload
 *    keeps the prior value, on BOTH the movie change-guard path and the TV
 *    always-rewrite path.
 *
 * Uses the MEDIA_DB_DIRECTORY test seam so the real node/db files are never
 * touched. The seam must be set BEFORE sqliteDatabase.mjs is imported (the
 * module resolves its file paths at import time), hence the dynamic imports.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
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

// metadataHashes.mjs transitively imports lib/mongo.mjs, which constructs a
// real MongoClient at import time — the client's internal resources keep the
// Jest worker alive after the run (force-exit warning). Nothing in these
// tests touches Mongo, so stub the module out entirely.
jest.unstable_mockModule('../../../lib/mongo.mjs', () => ({
  mongoClient: {
    db: () => {
      throw new Error('Mongo is not available in schema-parity tests');
    },
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
let metadataHashes; // sqlite/metadataHashes.mjs module namespace
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
  metadataHashes = await import('../../../sqlite/metadataHashes.mjs');
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

describe('movie metadata fingerprint (F-1 oscillation guard)', () => {
  const NAME = 'Oscillation Movie (2024)';
  // Canonical serialization: compact JSON.stringify of the parsed file — the
  // exact string movie-scanner.mjs produces and persists.
  const FINGERPRINT = JSON.stringify({ id: 4242, title: 'Oscillation Movie', overview: 'x' });
  const URLS = {
    mp4: '/movies/Oscillation%20Movie%20(2024)/movie.mp4',
    metadata: '/movies/Oscillation%20Movie%20(2024)/metadata.json',
    mediaLastModified: '2024-01-01T00:00:00.000Z',
  };

  async function storedMovieHash() {
    const row = await db.get(
      `SELECT hash FROM metadata_hashes WHERE media_type = 'movies' AND title = ?`,
      [NAME]
    );
    return row?.hash;
  }

  it('the persisted fingerprint is returned verbatim by both hash-writer read paths', async () => {
    await sqliteDb.insertOrUpdateMovie(
      NAME, ['movie.mp4'], { 'movie.mp4': 5400 }, { 'movie.mp4': '1920x1080' },
      URLS, URLS.metadata, 'dirhash-1', 'SDR', null, {}, 'tmdb_4242',
      null, null, null, null, null, '{"x":0.5,"y":0.5}', null,
      FINGERPRINT, null
    );

    const byName = await sqliteDb.getMovieByName(NAME);      // scanner inline rehash view
    const fromList = (await sqliteDb.getMovies()).find((m) => m.name === NAME); // sweep view

    expect(byName.metadata).toBe(FINGERPRINT);
    expect(fromList.metadata).toBe(FINGERPRINT);
  });

  it('scanner inline path and scheduled sweep produce the same stored hash', async () => {
    const byName = await sqliteDb.getMovieByName(NAME);
    await metadataHashes.generateMovieHashes(db, byName); // scanner inline writer
    const inlineHash = await storedMovieHash();
    expect(inlineHash).toBeTruthy();

    const fromList = (await sqliteDb.getMovies()).find((m) => m.name === NAME);
    await metadataHashes.generateMovieHashes(db, fromList); // scheduled sweep writer
    const sweepHash = await storedMovieHash();

    expect(sweepHash).toBe(inlineHash);
  });

  it('the stored hash is content-aware: a fingerprint change moves it, an identical one does not', async () => {
    const CA_NAME = 'Content Aware Movie (2024)';
    // Deliberately NO `metadata`/poster/backdrop/logo URL keys: the read-side
    // getters cache-bust those with directory_hash, which would move the hash
    // on ANY row rewrite and mask a content-blindness regression. With them
    // absent, the fingerprint is the only hash input that differs between the
    // saves below.
    const caUrls = {
      mp4: '/movies/Content%20Aware%20Movie%20(2024)/movie.mp4',
      mediaLastModified: '2024-01-01T00:00:00.000Z',
    };
    const save = (directoryHash, fingerprint) => sqliteDb.insertOrUpdateMovie(
      CA_NAME, ['movie.mp4'], {}, {}, caUrls, '', directoryHash, null, null, {}, 'tmdb_1',
      null, null, null, null, null, '{"x":0.5,"y":0.5}', null,
      fingerprint, null
    );
    const regenViaSweep = async () => {
      const row = (await sqliteDb.getMovies()).find((m) => m.name === CA_NAME);
      await metadataHashes.generateMovieHashes(db, row);
      const stored = await db.get(
        `SELECT hash FROM metadata_hashes WHERE media_type = 'movies' AND title = ?`,
        [CA_NAME]
      );
      return stored?.hash;
    };

    await save('h1', '{"id":1,"title":"v1"}');
    const hash1 = await regenViaSweep();
    expect(hash1).toBeTruthy();

    // directory_hash moves but the fingerprint is identical → the row rewrite
    // happens, yet no hash input changed, so the stored hash must not move.
    await save('h2', '{"id":1,"title":"v1"}');
    expect(await regenViaSweep()).toBe(hash1);

    // Fingerprint changes (a metadata.json content edit) → the stored hash
    // MUST move. This is the exact F-1 regression guard: drop `metadata` from
    // generateMovieHashes' hashableData and this assertion fails.
    await save('h3', '{"id":1,"title":"v2 (tmdb edit)"}');
    expect(await regenViaSweep()).not.toBe(hash1);
  });

  it('rows without a media mtime hash deterministically (stable lastModified fallback)', async () => {
    const NM_NAME = 'No Media Movie (2024)';
    await sqliteDb.insertOrUpdateMovie(
      NM_NAME, [], {}, {}, {}, '', 'h1', null, null, {}, null,
      null, null, null, null, null, '{"x":0.5,"y":0.5}', null,
      '{"id":2}', null
    );
    const readStored = () => db.get(
      `SELECT hash FROM metadata_hashes WHERE media_type = 'movies' AND title = ?`,
      [NM_NAME]
    );

    const row = await sqliteDb.getMovieByName(NM_NAME); // no urls.mediaLastModified
    await metadataHashes.generateMovieHashes(db, row);
    const first = await readStored();

    // A per-call timestamp fallback would move the hash between regenerations;
    // the stable null fallback must not. (Delay so a wall-clock-derived input
    // could not accidentally collide within the same millisecond.)
    await new Promise((resolve) => setTimeout(resolve, 5));
    await metadataHashes.generateMovieHashes(db, await sqliteDb.getMovieByName(NM_NAME));
    const second = await readStored();

    expect(second.hash).toBe(first.hash);
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
