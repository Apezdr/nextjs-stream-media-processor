/**
 * GET /api/alerts is for this server's own admins (a session from its own
 * Users database), like /api/logs: a paired webhook ID is refused. Real
 * router and auth middleware on an ephemeral port; the session lookup and the
 * alert manager are stand-ins.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';

process.env.WEBHOOK_ID_1 = 'test-webhook-id';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017';

const USERS = {
  'admin-token': { id: 'a', email: 'admin@test', admin: true, approved: true },
  'viewer-token': { id: 'v', email: 'viewer@test', admin: false, approved: true },
};
jest.unstable_mockModule('../../../middleware/sessionCache.mjs', () => ({
  sessionManager: { getSession: async (token) => USERS[token] ?? null },
}));

let manager = null;
let server;
let baseUrl;

beforeAll(async () => {
  const { setupAlertsRoutes } = await import('../../../routes/alerts.mjs');
  const express = (await import('express')).default;
  const app = express();
  app.use('/api', setupAlertsRoutes({ getAlerts: () => manager }));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const get = (headers = {}) => fetch(`${baseUrl}/api/alerts`, { headers });
const admin = { Authorization: 'Bearer admin-token' };

describe('GET /api/alerts', () => {
  it('refuses no credentials, a non-admin, and a paired webhook ID', async () => {
    manager = { list: async () => ({}) };
    expect((await get()).status).toBe(401);
    expect((await get({ Authorization: 'Bearer viewer-token' })).status).toBe(403);
    expect((await get({ 'x-webhook-id': 'test-webhook-id' })).status).toBe(401);
  });

  it('answers 503 until the alert manager has started', async () => {
    manager = null;
    expect((await get(admin)).status).toBe(503);
  });

  it("answers an admin with the manager's list, uncached", async () => {
    const list = { processorId: 'proc-1', active: [{ key: 'heartbeat:library-scan' }], recent: [], checkedAt: 'now' };
    manager = { list: async () => list };
    const res = await get(admin);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(list);
  });
});
