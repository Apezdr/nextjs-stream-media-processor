/**
 * Branch 7 (T-1 + T-6) tests for the tmdb_cache data layer, on a real SQLite
 * file via the MEDIA_DB_DIRECTORY seam:
 *  - the etag column exists (fresh CREATE) and setTmdbCache persists it
 *  - getTmdbCache returns the stored etag alongside the data
 *  - getTmdbCacheEntryAnyAge returns expired rows (the revalidation lookup)
 *  - setTmdbCache returns an explicit boolean (T-6 telemetry contract)
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

// The sqlite import chain reaches lib/mongo.mjs, which constructs a real
// MongoClient at import time and requires MONGODB_URI.
jest.unstable_mockModule('../../../lib/mongo.mjs', () => ({
  mongoClient: {
    db: () => {
      throw new Error('Mongo is not available in tmdb-cache-etag tests');
    },
  },
}));

const tmpDir = join(tmpdir(), `tmdb-cache-etag-test-${randomUUID()}`);
process.env.MEDIA_DB_DIRECTORY = tmpDir;

let sqliteDb;
let db;

beforeAll(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  sqliteDb = await import('../../../sqliteDatabase.mjs');
  db = await sqliteDb.initializeDatabase('tmdbCache');
});

afterAll(async () => {
  await sqliteDb.closeAllDatabaseConnections();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('setTmdbCache / getTmdbCache etag round-trip (T-1)', () => {
  it('persists the etag and returns it on read, with an explicit true return (T-6)', async () => {
    const ok = await sqliteDb.setTmdbCache('/movie/42', { language: 'en' }, { id: 42 }, 1440, null, 'W/"abc123"');
    expect(ok).toBe(true);

    const cached = await sqliteDb.getTmdbCache('/movie/42', { language: 'en' });
    expect(cached).not.toBe(null);
    expect(cached.data).toEqual({ id: 42 });
    expect(cached.etag).toBe('W/"abc123"');
  });

  it('a write without an etag stores null and the upsert overwrites a previous etag', async () => {
    await sqliteDb.setTmdbCache('/movie/43', {}, { id: 43, v: 1 }, 1440, null, 'W/"old"');
    const ok = await sqliteDb.setTmdbCache('/movie/43', {}, { id: 43, v: 2 }, 1440, null, null);
    expect(ok).toBe(true);

    const cached = await sqliteDb.getTmdbCache('/movie/43', {});
    expect(cached.data).toEqual({ id: 43, v: 2 });
    expect(cached.etag).toBe(null);
  });
});

describe('getTmdbCacheEntryAnyAge (T-1 revalidation lookup)', () => {
  it('returns an expired row — with its etag — that getTmdbCache hides', async () => {
    // Insert a row that is already expired.
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.run(
      `INSERT INTO tmdb_cache (cache_key, endpoint, request_params, response_data, created_at, expires_at, last_accessed, etag)
       VALUES ('expired-key', '/tv/7', '{}', '{"id":7}', ?, ?, ?, 'W/"stale"')`,
      [past, past, past]
    );

    expect(await sqliteDb.getTmdbCache('/tv/7', {}, 'expired-key')).toBe(null);

    const anyAge = await sqliteDb.getTmdbCacheEntryAnyAge('/tv/7', {}, 'expired-key');
    expect(anyAge).not.toBe(null);
    expect(anyAge.data).toEqual({ id: 7 });
    expect(anyAge.etag).toBe('W/"stale"');
    expect(anyAge.expired).toBe(true);
  });

  it('reports expired: false for a live row and null for a missing one', async () => {
    await sqliteDb.setTmdbCache('/tv/8', {}, { id: 8 }, 1440, null, 'W/"live"');
    const live = await sqliteDb.getTmdbCacheEntryAnyAge('/tv/8', {});
    expect(live.expired).toBe(false);
    expect(live.etag).toBe('W/"live"');

    expect(await sqliteDb.getTmdbCacheEntryAnyAge('/tv/999', {})).toBe(null);
  });
});
