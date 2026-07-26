/**
 * The identity index's only active job is duplicate detection, and getting its
 * scope wrong silently destroys the property the whole design exists for.
 *
 * A FOLDER RENAME and a COPIED FOLDER look identical if you compare the
 * presented name against the STORED one: in both cases they differ. The
 * difference is time. A rename means the old name is gone; a copy means both
 * folders are present in the same pass. Comparing against the stored row treats
 * every rename as a duplicate and repoints the identity on the very next scan.
 *
 * These tests run against a real temp SQLite database.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// utils/utils.mjs starts the piscina blurhash pool at import time, which keeps
// the Jest worker alive; the sqlite chain only needs fileExists.
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

// metadataHashes.mjs transitively constructs a real MongoClient at import time.
jest.unstable_mockModule('../../../lib/mongo.mjs', () => ({
  mongoClient: {
    db: () => {
      throw new Error('Mongo is not available in identity-index tests');
    },
  },
}));

const tmpDir = join(tmpdir(), `identity-index-test-${randomUUID()}`);
process.env.MEDIA_DB_DIRECTORY = tmpDir;

const sqliteDb = await import('../../../sqliteDatabase.mjs');
const { initializeDatabase, releaseDatabase } = sqliteDb;
const { recordMediaIdentity, createIdentityClaims } = await import(
  '../../../components/media-scanner/data-access/scanner-repository.mjs'
);

let db;

beforeAll(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  db = await initializeDatabase();
});

afterAll(async () => {
  if (db) await releaseDatabase(db);
  await sqliteDb.closeAllDatabaseConnections();
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the sqlite file briefly after close; the temp dir
    // is the OS's to reclaim and its removal is not what this suite asserts.
  }
});

beforeEach(async () => {
  await db.run('DELETE FROM media_identity_index');
});

const ID = 'mid:a91c04f7e2b6d558';

describe('recordMediaIdentity', () => {
  it('records a first claim without conflict', async () => {
    const claims = createIdentityClaims();
    const r = await recordMediaIdentity(db, claims, {
      mediaId: ID,
      mediaType: 'movie',
      mediaName: 'Dune 2021',
    });
    expect(r).toEqual({ conflict: false, ownedBy: null });

    const row = await db.get('SELECT * FROM media_identity_index WHERE media_id = ?', [ID]);
    expect(row.media_name).toBe('Dune 2021');
  });

  it('FOLLOWS A RENAME rather than calling it a duplicate', async () => {
    // Scan 1: original folder name.
    await recordMediaIdentity(db, createIdentityClaims(), {
      mediaId: ID,
      mediaType: 'movie',
      mediaName: 'Dune 2021',
    });

    // Scan 2 (fresh run): folder renamed, sidecar travelled with it, so the
    // SAME id arrives under a DIFFERENT name. This is the case the sidecar
    // exists to make survivable — it must not be reported as a conflict.
    const r = await recordMediaIdentity(db, createIdentityClaims(), {
      mediaId: ID,
      mediaType: 'movie',
      mediaName: 'Dune (2021)',
    });

    expect(r.conflict).toBe(false);

    const row = await db.get('SELECT * FROM media_identity_index WHERE media_id = ?', [ID]);
    expect(row.media_name).toBe('Dune (2021)');
  });

  it('DETECTS a duplicate when two folders claim one id in the SAME scan', async () => {
    const claims = createIdentityClaims();

    const first = await recordMediaIdentity(db, claims, {
      mediaId: ID,
      mediaType: 'movie',
      mediaName: 'Dune (2021)',
    });
    expect(first.conflict).toBe(false);

    // A copied folder carrying a cloned sidecar, seen in the same pass.
    const second = await recordMediaIdentity(db, claims, {
      mediaId: ID,
      mediaType: 'movie',
      mediaName: 'Copy of Dune',
    });

    expect(second.conflict).toBe(true);
    // The full name, not a prefix — media names contain spaces.
    expect(second.ownedBy).toBe('Dune (2021)');

    // The loser must NOT have overwritten the winner's row.
    const row = await db.get('SELECT * FROM media_identity_index WHERE media_id = ?', [ID]);
    expect(row.media_name).toBe('Dune (2021)');
  });

  it('is idempotent for the same title within one scan', async () => {
    const claims = createIdentityClaims();
    const a = await recordMediaIdentity(db, claims, {
      mediaId: ID,
      mediaType: 'movie',
      mediaName: 'Dune (2021)',
    });
    const b = await recordMediaIdentity(db, claims, {
      mediaId: ID,
      mediaType: 'movie',
      mediaName: 'Dune (2021)',
    });
    expect(a.conflict).toBe(false);
    expect(b.conflict).toBe(false);
  });

  it('treats episodes of one show as distinct claimants', async () => {
    const claims = createIdentityClaims();
    const e1 = await recordMediaIdentity(db, claims, {
      mediaId: `${ID}:s01e01`,
      mediaType: 'episode',
      mediaName: 'Breaking Bad',
      seasonKey: '01',
      episodeKey: 'S01E01',
    });
    const e2 = await recordMediaIdentity(db, claims, {
      mediaId: `${ID}:s01e02`,
      mediaType: 'episode',
      mediaName: 'Breaking Bad',
      seasonKey: '01',
      episodeKey: 'S01E02',
    });
    expect(e1.conflict).toBe(false);
    expect(e2.conflict).toBe(false);
  });

  it('detects two episodes of the same show colliding on one id', async () => {
    const claims = createIdentityClaims();
    await recordMediaIdentity(db, claims, {
      mediaId: `${ID}:s01e01`,
      mediaType: 'episode',
      mediaName: 'Breaking Bad',
      seasonKey: '01',
      episodeKey: 'S01E01',
    });
    const dup = await recordMediaIdentity(db, claims, {
      mediaId: `${ID}:s01e01`,
      mediaType: 'episode',
      mediaName: 'Breaking Bad',
      seasonKey: '01',
      episodeKey: 'S01E02',
    });
    expect(dup.conflict).toBe(true);
  });

  it('follows an episode-level rename across scans', async () => {
    await recordMediaIdentity(db, createIdentityClaims(), {
      mediaId: `${ID}:s01e01`,
      mediaType: 'episode',
      mediaName: 'Breaking Bad',
      seasonKey: '01',
      episodeKey: 'S01E01',
    });
    // Show folder renamed between scans.
    const r = await recordMediaIdentity(db, createIdentityClaims(), {
      mediaId: `${ID}:s01e01`,
      mediaType: 'episode',
      mediaName: 'Breaking Bad (2008)',
      seasonKey: '01',
      episodeKey: 'S01E01',
    });
    expect(r.conflict).toBe(false);
  });

  it('ignores a null id', async () => {
    const r = await recordMediaIdentity(db, createIdentityClaims(), {
      mediaId: null,
      mediaType: 'movie',
      mediaName: 'Nothing',
    });
    expect(r).toEqual({ conflict: false, ownedBy: null });
  });

  it('rebuilds cleanly after the index is dropped — it is a cache', async () => {
    await recordMediaIdentity(db, createIdentityClaims(), {
      mediaId: ID,
      mediaType: 'movie',
      mediaName: 'Dune (2021)',
    });
    await db.run('DELETE FROM media_identity_index');

    const r = await recordMediaIdentity(db, createIdentityClaims(), {
      mediaId: ID,
      mediaType: 'movie',
      mediaName: 'Dune (2021)',
    });
    expect(r.conflict).toBe(false);

    const row = await db.get('SELECT * FROM media_identity_index WHERE media_id = ?', [ID]);
    expect(row.media_name).toBe('Dune (2021)');
  });
});
