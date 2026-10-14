/**
 * lib/mongo.mjs must keep retrying its boot connect until one succeeds.
 * After a failed connect() the driver keeps the closed topology and its
 * auto-connect never replaces it, so a boot that raced mongod's startup
 * would leave better-auth (which holds this client directly) throwing
 * "Topology is closed" until the process restarts.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';

const mockConnect = jest.fn();
jest.unstable_mockModule('mongodb', () => ({
  MongoClient: class MongoClient {
    constructor(uri, options) {
      this.uri = uri;
      this.options = options;
    }
    connect() {
      return mockConnect(this);
    }
  },
}));

const refused = () =>
  Object.assign(new Error('connect ECONNREFUSED 172.19.0.7:27017'), {
    name: 'MongoServerSelectionError',
  });

describe('boot connect', () => {
  beforeAll(() => jest.useFakeTimers());
  afterAll(() => jest.useRealTimers());

  it('retries every 5 s until an attempt succeeds, then stops', async () => {
    mockConnect
      .mockRejectedValueOnce(refused()) // boot
      .mockRejectedValueOnce(refused()) // first retry: mongod still starting
      .mockImplementation(async (client) => client);

    const { mongoClient } = await import('../../../lib/mongo.mjs');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenLastCalledWith(mongoClient);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockConnect).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockConnect).toHaveBeenCalledTimes(3);

    // Connected: the retries stop.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockConnect).toHaveBeenCalledTimes(3);
  });
});
