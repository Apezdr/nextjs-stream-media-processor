/**
 * Branch 12 (M-1 + M-2 + M-3) contract tests for node/database.mjs:
 * - closeMongoConnection() exists and closes the shared client. app.mjs's
 *   graceful shutdown resolves it by name behind a typeof guard, so a
 *   missing/renamed export silently skips the close — this suite pins it.
 * - getUsersDb() resolves the same database Better Auth uses
 *   (MONGODB_AUTH_DB, falling back to "Users").
 * - initializeIndexes() provisions only app_config — the legacy Media/Cache
 *   collections are no longer touched on startup.
 * - getClient() connects on every call, so a refused attempt during a boot
 *   that raced mongod is not the answer for the life of the process.
 */

import { describe, it, expect, jest, beforeAll, beforeEach, afterEach } from '@jest/globals';

const dbNamesRequested = [];
let closeCalls = 0;
const mockConnect = jest.fn();

// lib/mongo.mjs constructs a real MongoClient at import time; substitute a
// recording fake so no connection is attempted.
jest.unstable_mockModule('../../lib/mongo.mjs', () => ({
  mongoClient: {
    connect: (...args) => mockConnect(...args),
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

beforeEach(() => {
  mockConnect.mockReset();
  mockConnect.mockResolvedValue(undefined);
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

describe('getClient (boot race)', () => {
  it('connects on every call, so a refused attempt is retried, not replayed', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 172.19.0.7:27017'), {
      name: 'MongoServerSelectionError',
    });
    mockConnect.mockRejectedValueOnce(refused);

    await expect(database.getClient()).rejects.toThrow('ECONNREFUSED');

    const client = await database.getClient();
    expect(client.db('Media').databaseName).toBe('Media');
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });
});

describe('ensureIndex', () => {
  it("creates the index on a collection that doesn't exist yet (listIndexes answers NamespaceNotFound)", async () => {
    const createIndex = jest.fn().mockResolvedValue('ok');
    const missing = {
      collectionName: 'log_fingerprints',
      indexes: async () => {
        throw Object.assign(new Error('ns does not exist: app_config.log_fingerprints'), { code: 26 });
      },
      createIndex,
    };
    await database.ensureIndex(missing, { lastSeen: 1 }, { name: 'log_fingerprints_ttl', expireAfterSeconds: 60 });
    expect(createIndex).toHaveBeenCalledWith({ lastSeen: 1 }, { name: 'log_fingerprints_ttl', expireAfterSeconds: 60 });
  });

  it('still fails on any other error', async () => {
    const broken = { collectionName: 'x', indexes: async () => { throw new Error('connection reset'); }, createIndex: jest.fn() };
    await expect(database.ensureIndex(broken, { a: 1 }, { name: 'a' })).rejects.toThrow('connection reset');
  });
});
