/**
 * Branch 12 (M-1 + M-2 + M-3) contract tests for node/database.mjs:
 * - closeMongoConnection() exists and closes the shared client. app.mjs's
 *   graceful shutdown resolves it by name behind a typeof guard, so a
 *   missing/renamed export silently skips the close — this suite pins it.
 * - getUsersDb() resolves the same database Better Auth uses
 *   (MONGODB_AUTH_DB, falling back to "Users").
 * - initializeIndexes() provisions only app_config — the legacy Media/Cache
 *   collections are no longer touched on startup.
 */

import { describe, it, expect, jest, beforeAll, afterEach } from '@jest/globals';

const dbNamesRequested = [];
let closeCalls = 0;

// lib/mongo.mjs constructs a real MongoClient at import time; substitute a
// recording fake so no connection is attempted.
jest.unstable_mockModule('../../lib/mongo.mjs', () => ({
  mongoClient: {
    db: (name) => {
      dbNamesRequested.push(name);
      return {
        databaseName: name,
        collection: (collectionName) => ({
          collectionName,
          indexes: async () => [],
          createIndex: async () => 'ok',
        }),
      };
    },
    close: async () => {
      closeCalls += 1;
    },
  },
}));

let database;

beforeAll(async () => {
  delete process.env.MONGODB_AUTH_DB;
  database = await import('../../database.mjs');
});

afterEach(() => {
  delete process.env.MONGODB_AUTH_DB;
});

describe('closeMongoConnection (M-1)', () => {
  it('is exported and closes the shared MongoClient', async () => {
    expect(typeof database.closeMongoConnection).toBe('function');
    await database.closeMongoConnection();
    expect(closeCalls).toBe(1);
  });
});

describe('getUsersDb (M-2)', () => {
  it('honors MONGODB_AUTH_DB, matching lib/auth.mjs', async () => {
    process.env.MONGODB_AUTH_DB = 'CustomAuthDb';
    const db = await database.getUsersDb();
    expect(db.databaseName).toBe('CustomAuthDb');
  });

  it('falls back to "Users" when MONGODB_AUTH_DB is unset', async () => {
    const db = await database.getUsersDb();
    expect(db.databaseName).toBe('Users');
  });
});

describe('startup provisioning (M-3)', () => {
  it('no longer exports the dead-collection provisioning', () => {
    expect(database.initializeMongoDatabase).toBeUndefined();
  });

  it('initializeIndexes touches only app_config', async () => {
    dbNamesRequested.length = 0;
    await database.initializeIndexes();
    expect([...new Set(dbNamesRequested)]).toEqual(['app_config']);
  });
});
