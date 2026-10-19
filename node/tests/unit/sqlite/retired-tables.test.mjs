/**
 * dropRetiredTables: the startup schema setup drops blurhash_hashes, the
 * bookkeeping table of the removed /api/blurhash* routes and blurhash sweeps
 * (P2), and metadata_hashes, the table behind the removed
 * /api/metadata-hashes route, its scheduled update and the scanners' rehash
 * (P4).
 *
 *  - a media.db that still has the tables (with their indexes and rows) loses
 *    them the first time initializeDatabase('main') runs, and nothing else in
 *    the file changes;
 *  - running it again, alone or through the full schema setup, is a no-op;
 *  - a fresh database never gets either table.
 *
 * Same harness as schema-parity.test.mjs: the MEDIA_DB_DIRECTORY seam keeps
 * the real node/db files out of reach, so it is set before the dynamic import.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// utils/utils.mjs starts the blurhash worker pool at import time; the sqlite
// import chain only needs fileExists.
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

const tmpDir = join(tmpdir(), `retired-tables-test-${randomUUID()}`);
process.env.MEDIA_DB_DIRECTORY = tmpDir;

// The table as the removed sqlite/blurhashHashes.mjs created it.
const BLURHASH_HASHES_SQL = `
  CREATE TABLE IF NOT EXISTS blurhash_hashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_type TEXT NOT NULL,
    media_id TEXT NOT NULL,
    title TEXT NOT NULL,
    season_number TEXT,
    episode_key TEXT,
    image_type TEXT NOT NULL,
    hash TEXT NOT NULL,
    last_modified TIMESTAMP,
    hash_generated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_version INTEGER NOT NULL,
    generation_version INTEGER DEFAULT 1,
    UNIQUE(media_type, media_id, season_number, episode_key, image_type)
  );
  CREATE INDEX IF NOT EXISTS idx_blurhash_hashes_lookup ON blurhash_hashes(media_type, media_id, season_number, episode_key);
  CREATE INDEX IF NOT EXISTS idx_blurhash_hashes_modified ON blurhash_hashes(last_modified);
`;

// The table as the removed sqlite/metadataHashes.mjs created it.
const METADATA_HASHES_SQL = `
  CREATE TABLE IF NOT EXISTS metadata_hashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_type TEXT NOT NULL,
    title TEXT NOT NULL,
    season_number TEXT,
    episode_key TEXT,
    hash TEXT NOT NULL,
    content_hash TEXT,
    last_modified TIMESTAMP,
    hash_generated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_version INTEGER NOT NULL,
    UNIQUE(media_type, title, season_number, episode_key)
  );
  CREATE INDEX IF NOT EXISTS idx_metadata_hashes_lookup ON metadata_hashes(media_type, title, season_number, episode_key);
  CREATE INDEX IF NOT EXISTS idx_metadata_hashes_modified ON metadata_hashes(last_modified);
`;

const RETIRED = ['blurhash_hashes', 'metadata_hashes'];

let sqliteDb;
let db;

/** Every table and index of a retired table, from sqlite_master. */
async function retiredObjects(handle) {
  const rows = await handle.all(
    `SELECT type, name FROM sqlite_master WHERE name IN (?, ?) OR tbl_name IN (?, ?)`,
    [...RETIRED, ...RETIRED]
  );
  return rows.map((row) => `${row.type}:${row.name}`).sort();
}

/** The schema of everything else in the file, to show the drop touches nothing more. */
async function otherSchema(handle) {
  const rows = await handle.all(
    `SELECT type, name, sql FROM sqlite_master WHERE tbl_name NOT IN (?, ?) ORDER BY type, name`,
    RETIRED
  );
  return rows;
}

beforeAll(async () => {
  await fs.mkdir(tmpDir, { recursive: true });

  // A media.db from before P2: the startup sweep had created and filled
  // blurhash_hashes, and the scanners and the scheduled update metadata_hashes.
  const seed = await open({ filename: join(tmpDir, 'media.db'), driver: sqlite3.Database });
  await seed.exec(BLURHASH_HASHES_SQL);
  await seed.exec(METADATA_HASHES_SQL);
  await seed.run(
    `INSERT INTO blurhash_hashes (media_type, media_id, title, image_type, hash, data_version, generation_version)
     VALUES ('movies', 'm1', 'Some Movie', 'poster', 'abc', 1, 2)`
  );
  await seed.run(
    `INSERT INTO metadata_hashes (media_type, title, season_number, episode_key, hash, content_hash, data_version)
     VALUES ('movies', 'Some Movie', NULL, NULL, 'h1', NULL, 1), ('tv', 'Some Show', '1', 'S01E01', 'h2', 'c2', 1)`
  );
  expect(await retiredObjects(seed)).toEqual([
    'index:idx_blurhash_hashes_lookup',
    'index:idx_blurhash_hashes_modified',
    'index:idx_metadata_hashes_lookup',
    'index:idx_metadata_hashes_modified',
    'index:sqlite_autoindex_blurhash_hashes_1',
    'index:sqlite_autoindex_metadata_hashes_1',
    'table:blurhash_hashes',
    'table:metadata_hashes',
  ]);
  await seed.close();

  sqliteDb = await import('../../../sqliteDatabase.mjs');
  db = await sqliteDb.initializeDatabase('main');
});

afterAll(async () => {
  await sqliteDb?.closeAllDatabaseConnections();
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows can briefly hold the WAL file open; leave the temp dir behind.
  }
});

describe('dropRetiredTables', () => {
  it('drops blurhash_hashes, metadata_hashes and their indexes from an existing media.db at startup', async () => {
    expect(await retiredObjects(db)).toEqual([]);
  });

  it('leaves the live tables in place', async () => {
    const tables = (await db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(['movies', 'tv_shows', 'media_identity_index', 'missing_data_media']));
  });

  it('is idempotent: running it again, alone or through the schema setup, changes nothing', async () => {
    const before = await otherSchema(db);

    await sqliteDb.dropRetiredTables(db);
    await sqliteDb.dropRetiredTables(db);
    await sqliteDb.initializeSchema('main', db);

    expect(await retiredObjects(db)).toEqual([]);
    expect(await otherSchema(db)).toEqual(before);
  });

  it('touches only the retired tables: the rest of a database keeps its schema and rows', async () => {
    const file = await open({ filename: join(tmpDir, 'other.db'), driver: sqlite3.Database });
    try {
      await sqliteDb.initializeSchema('main', file);
      await file.run(`INSERT INTO movies (name) VALUES ('Kept Movie')`);
      await file.exec(BLURHASH_HASHES_SQL);
      await file.exec(METADATA_HASHES_SQL);
      const before = await otherSchema(file);

      await sqliteDb.dropRetiredTables(file);

      expect(await retiredObjects(file)).toEqual([]);
      expect(await otherSchema(file)).toEqual(before);
      expect(await file.all(`SELECT name FROM movies`)).toEqual([{ name: 'Kept Movie' }]);
    } finally {
      await file.close();
    }
  });

  it('a fresh database never gets either table', async () => {
    const fresh = await open({ filename: join(tmpDir, 'fresh.db'), driver: sqlite3.Database });
    try {
      await sqliteDb.initializeSchema('main', fresh);
      expect(await retiredObjects(fresh)).toEqual([]);
    } finally {
      await fresh.close();
    }
  });
});
