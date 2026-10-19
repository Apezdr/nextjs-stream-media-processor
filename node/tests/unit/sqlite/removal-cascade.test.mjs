/**
 * Branch 5 removal-cascade tests (R-4): when a title is removed, its cooldown
 * row and its per-episode backfill rows are cleared too, so a same-named title
 * re-added later starts clean instead of inheriting a stale retry timestamp.
 * (The stored metadata hashes the cascade also cleared went with their table
 * in P4.)
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

const tmpDir = join(tmpdir(), `removal-cascade-test-${randomUUID()}`);
process.env.MEDIA_DB_DIRECTORY = tmpDir;

let sqliteDb;
let repo;
let db;

beforeAll(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  sqliteDb = await import('../../../sqliteDatabase.mjs');
  repo = await import('../../../components/media-scanner/data-access/scanner-repository.mjs');
  db = await sqliteDb.initializeDatabase('main');
});

afterAll(async () => {
  await sqliteDb.closeAllDatabaseConnections();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const countRows = async (sql, params) => (await db.get(sql, params)).n;

describe('removal cascade (R-4)', () => {
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

  it('the full cascade is idempotent — clearing an already-clean title is a no-op', async () => {
    await repo.clearMissingMediaData('Never Existed');
    await repo.clearEpisodeRetryForShow('Never Existed');
    // No throw = pass; verify the tables are still intact.
    expect(
      await countRows(`SELECT COUNT(*) AS n FROM episode_metadata_missing WHERE show_name = ?`, ['Surviving Show'])
    ).toBe(1);
  });
});
