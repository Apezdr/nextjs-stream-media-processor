/**
 * GET /api/logs is admin only. It used to answer anyone on the public
 * processor URL, guarded by nothing but a browser CORS header. Runs the real
 * router and the real auth middleware on an ephemeral port; only the session
 * lookup is mocked.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

process.env.WEBHOOK_ID_1 = 'test-webhook-id';

const USERS = {
  'admin-token': { id: 'a', email: 'admin@test', admin: true, approved: true },
  'viewer-token': { id: 'v', email: 'viewer@test', admin: false, approved: true },
};

jest.unstable_mockModule('../../../middleware/sessionCache.mjs', () => ({
  sessionManager: { getSession: async (token) => USERS[token] ?? null },
}));

const logDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'logs-route-'));
await fs.writeFile(
  path.join(logDirectory, 'application-2026-10-19.log.22'),
  `${JSON.stringify({ category: 'main', level: 'info', message: 'scan started', timestamp: '2026-10-19 17:00:00' })}\n`
);

let server;
let baseUrl;

beforeAll(async () => {
  const { setupLogsRoutes } = await import('../../../routes/logs.mjs');
  const express = (await import('express')).default;
  const app = express();
  app.use('/api', setupLogsRoutes({ logDirectory }));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(logDirectory, { recursive: true, force: true });
});

const get = (query = '', headers = {}) => fetch(`${baseUrl}/api/logs${query}`, { headers });

describe('GET /api/logs auth', () => {
  it('refuses a request with no credentials, and sends no log lines', async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty('entries');
  });

  it('refuses a wrong webhook ID and a signed-in user who is not an admin', async () => {
    expect((await get('', { 'x-webhook-id': 'not-the-id' })).status).toBe(401);
    expect((await get('', { Authorization: 'Bearer viewer-token' })).status).toBe(403);
  });

  it.each([
    ['the webhook ID', { 'x-webhook-id': 'test-webhook-id' }],
    ['an admin session', { Authorization: 'Bearer admin-token' }],
  ])('answers %s with the log, uncached and with no CORS header', async (_name, headers) => {
    const res = await get('', headers);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();

    const body = await res.json();
    expect(body.entries.map((entry) => entry.message)).toEqual(['scan started']);
    expect(body.newer).toMatch(/^2026-10-19\.22:\d+$/);
    expect(Array.isArray(body.categories)).toBe(true);
  });
});

describe('GET /api/logs query checks', () => {
  const admin = { Authorization: 'Bearer admin-token' };

  it.each([
    ['?limit=0', 'limit'],
    ['?limit=2001', 'limit'],
    ['?limit=ten', 'limit'],
    ['?level=loud', 'level'],
    ['?before=../../etc/passwd', 'before'],
    ['?after=2026-10-19.1:0&before=2026-10-19.1:0', 'before and after'],
    ['?category=a&category=b', 'category'],
  ])('answers %s with a 400 naming %s', async (query, field) => {
    const res = await get(query, admin);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(field);
  });
});
