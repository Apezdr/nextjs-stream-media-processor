/**
 * Branch 5 removal-cascade tests (R-4 + F-3): when a title is removed, its
 * cooldown row, its per-episode backfill rows, and its stored metadata hashes
 * are cleared too, so a same-named title re-added later starts clean instead
 * of inheriting a stale retry timestamp or serving a frozen hash.
 *
 * Uses the MEDIA_DB_DIRECTORY test seam (set BEFORE sqliteDatabase.mjs is
 * imported — the module resolves its file paths at import time, hence the
 * dynamic imports), same as the schema-parity suite.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// utils/utils.mjs initializes the piscina blurhash worker pool at import time;
// the sqlite import chain only needs fileExists.
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
// real MongoClient at import time and keeps the Jest worker alive.
jest.unstable_mockModule('../../../lib/mongo.mjs', () => ({
  mongoClient: {
    db: () => {
      throw new Error('Mongo is not available in removal-cascade tests');
    },
  },
}));

const tmpDir = join(tmpdir(), `removal-cascade-test-${randomUUID()}`);
process.env.MEDIA_DB_DIRECTORY = tmpDir;

let sqliteDb;
let repo;
let hashes;
let db;

beforeAll(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  sqliteDb = await import('../../../sqliteDatabase.mjs');
  repo = await import('../../../components/media-scanner/data-access/scanner-repository.mjs');
  hashes = await import('../../../sqlite/metadataHashes.mjs');
  db = await sqliteDb.initializeDatabase('main');
  await hashes.initializeMetadataHashesTable(db);
});

afterAll(async () => {
  await sqliteDb.closeAllDatabaseConnections();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const countRows = async (sql, params) => (await db.get(sql, params)).n;

describe('removal cascade (R-4 + F-3)', () => {
  it('clearMissingMediaData removes the cooldown row for a departed title', async () => {
    await repo.markMediaAsMissingData('Departed Movie (2001)');
    expect(
      await countRows(`SELECT COUNT(*) AS n FROM missing_data_media WHERE name = ?`, ['Departed Movie (2001)'])
    ).toBe(1);

    await repo.clearMissingMediaData('Departed Movie (2001)');
    expect(
      await countRows(`SELECT COUNT(*) AS n FROM missing_data_media WHERE name = ?`, ['Departed Movie (2001)'])
    ).toBe(0);
  });

  it('clearEpisodeRetryForShow removes every episode row for exactly that show', async () => {
    await repo.recordEpisodeAttempt('Departed Show', 1, 1, '2024-01-01');
    await repo.recordEpisodeAttempt('Departed Show', 1, 2, '2024-01-08');
    await repo.recordEpisodeAttempt('Departed Show', 2, 1, '2024-06-01');
    await repo.recordEpisodeAttempt('Surviving Show', 1, 1, '2024-01-01');

    await repo.clearEpisodeRetryForShow('Departed Show');

    expect(
      await countRows(`SELECT COUNT(*) AS n FROM episode_metadata_missing WHERE show_name = ?`, ['Departed Show'])
    ).toBe(0);
    // Other shows' rows are untouched.
    expect(
      await countRows(`SELECT COUNT(*) AS n FROM episode_metadata_missing WHERE show_name = ?`, ['Surviving Show'])
    ).toBe(1);
  });

  it('deleteHashesForMedia removes all hash rows for exactly that title and media type', async () => {
    // Seed show-level + season-level rows for the departed show, plus a
    // same-named movie and a different show, which must both survive.
    await db.run(
      `INSERT INTO metadata_hashes (media_type, title, season_number, episode_key, hash, last_modified, data_version)
       VALUES ('tv', 'Departed Show', NULL, NULL, 'hash-show', '2024-01-01', 1),
              ('tv', 'Departed Show', 1, 'S1E1', 'hash-ep', '2024-01-01', 1),
              ('tv', 'Surviving Show', NULL, NULL, 'hash-other', '2024-01-01', 1),
              ('movies', 'Departed Show', NULL, NULL, 'hash-movie-same-name', '2024-01-01', 1)`
    );

    await hashes.deleteHashesForMedia(db, 'tv', 'Departed Show');

    expect(
      await countRows(`SELECT COUNT(*) AS n FROM metadata_hashes WHERE media_type = 'tv' AND title = ?`, ['Departed Show'])
    ).toBe(0);
    expect(
      await countRows(`SELECT COUNT(*) AS n FROM metadata_hashes WHERE media_type = 'tv' AND title = ?`, ['Surviving Show'])
    ).toBe(1);
    expect(
      await countRows(`SELECT COUNT(*) AS n FROM metadata_hashes WHERE media_type = 'movies' AND title = ?`, ['Departed Show'])
    ).toBe(1);
  });

  it('the full cascade is idempotent — clearing an already-clean title is a no-op', async () => {
    await repo.clearMissingMediaData('Never Existed');
    await repo.clearEpisodeRetryForShow('Never Existed');
    await hashes.deleteHashesForMedia(db, 'tv', 'Never Existed');
    // No throw = pass; verify the tables are still intact.
    expect(
      await countRows(`SELECT COUNT(*) AS n FROM episode_metadata_missing WHERE show_name = ?`, ['Surviving Show'])
    ).toBe(1);
  });
});
