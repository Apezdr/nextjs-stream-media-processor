/**
 * The identity service end to end through its HTTP surface: disabled is a
 * clean no-op, a webhook reconciles its one folder and asks for an early
 * scan, the Basic-auth password doubles as the webhook id, and the status /
 * report endpoints answer.
 *
 * Runs the real router on an ephemeral port. Auth is injected: the shared
 * middleware pulls in the session manager (Mongo) at import time.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import express from 'express';

jest.unstable_mockModule('../../../../middleware/auth.mjs', () => ({
  authenticateWebhookOrUser: (req, res, next) => {
    if (req.headers['x-webhook-id'] === 'hook-secret') return next();
    return res.status(401).json({ error: 'nope' });
  },
}));

const { createIdentityService } = await import('../../../../integrations/identity/index.mjs');
const { setupIdentityRoutes } = await import('../../../../integrations/identity/routes.mjs');
const { loadTmdbConfig, saveTmdbConfig } = await import('../../../../utils/tmdbConfig.mjs');

const radarrList = [
  { id: 1, title: 'The Professor', year: 2018, path: '/processed_movies/The Professor', tmdbId: 467956, hasFile: true },
];

function fakeFetch() {
  return async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/v3/movie') return { ok: true, status: 200, json: async () => radarrList };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

describe('identity service: disabled', () => {
  it('every entry point is a no-op that says so', async () => {
    const service = createIdentityService({ env: {}, basePath: '/nowhere' });
    expect(service.enabled).toBe(false);
    expect(await service.reconcileForTick()).toEqual({ enabled: false, reason: 'scan-tick' });
    expect(await service.handleWebhook('radarr', { eventType: 'Test' })).toMatchObject({ accepted: false, status: 404 });
    expect(service.getStatus()).toMatchObject({ enabled: false, providers: [], lastReport: null });
  });

  it('a misconfigured provider leaves the service disabled and names the problem', () => {
    const service = createIdentityService({ env: { RADARR_URL: 'http://r' }, basePath: '/nowhere' });
    expect(service.enabled).toBe(false);
    expect(service.getStatus().configErrors).toEqual([{ provider: 'radarr', error: expect.stringMatching(/RADARR_API_KEY/) }]);
  });
});

describe('identity service + routes: enabled with Radarr', () => {
  const basePath = join(tmpdir(), `identity-service-${randomUUID()}`);
  const professorDir = join(basePath, 'movies', 'The Professor');
  const requestScan = jest.fn(async () => {});
  let service;
  let server;
  let base;

  beforeAll(async () => {
    await fs.mkdir(professorDir, { recursive: true });
    await saveTmdbConfig(join(professorDir, 'tmdb.config'), { tmdb_id: 9327, tmdb_id_source: 'auto' });

    service = createIdentityService({
      env: { RADARR_URL: 'http://radarr:7878', RADARR_API_KEY: 'k' },
      basePath,
      requestScan,
      fetchImpl: fakeFetch(),
    });
    const app = express();
    app.use(express.json());
    app.use('/api', setupIdentityRoutes(service));
    ({ server, base } = await listen(app));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(basePath, { recursive: true, force: true });
  });

  it('report before any reconcile → 202 pending; status shows the provider without its key', async () => {
    const pending = await fetch(`${base}/api/identity/report`, { headers: { 'x-webhook-id': 'hook-secret' } });
    expect(pending.status).toBe(202);

    const status = await (await fetch(`${base}/api/identity/status`, { headers: { 'x-webhook-id': 'hook-secret' } })).json();
    expect(status).toMatchObject({ enabled: true, unsourcedPinTreatment: 'manual' });
    expect(status.providers[0]).toMatchObject({ name: 'radarr', mediaTypes: ['movie'], supportsWebhook: true, baseUrl: 'http://radarr:7878' });
    expect(JSON.stringify(status)).not.toContain('"k"');
  });

  it('unauthenticated requests are refused', async () => {
    expect((await fetch(`${base}/api/identity/status`)).status).toBe(401);
    expect((await fetch(`${base}/api/identity/webhook/radarr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"eventType":"Test"}' })).status).toBe(401);
  });

  it('the Basic-auth password authenticates a provider webhook (Radarr/Sonarr have no custom headers)', async () => {
    const auth = `Basic ${Buffer.from('radarr:hook-secret').toString('base64')}`;
    const res = await fetch(`${base}/api/identity/webhook/radarr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ eventType: 'Test' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true, provider: 'radarr', events: [{ kind: 'test' }], scanRequested: false });
    expect(requestScan).not.toHaveBeenCalled();
  });

  it('a Download webhook repairs the folder it names and requests an early scan', async () => {
    const res = await fetch(`${base}/api/identity/webhook/radarr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-id': 'hook-secret' },
      body: JSON.stringify({
        eventType: 'Download',
        isUpgrade: false,
        movie: { title: 'The Professor', year: 2018, folderPath: '/processed_movies/The Professor', tmdbId: 467956 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      accepted: true,
      scanRequested: true,
      events: [{ kind: 'imported', libraryRelativePath: 'movies/The Professor', outcome: 'write', decision: { action: 'write', tmdbId: 467956 } }],
    });
    expect(await loadTmdbConfig(join(professorDir, 'tmdb.config'))).toMatchObject({ tmdb_id: 467956, tmdb_id_source: 'radarr' });
    await new Promise((r) => setTimeout(r, 10)); // requestScan is fire-and-forget
    expect(requestScan).toHaveBeenCalledWith('radarr-webhook');
  });

  it('a webhook for a folder that is not on disk writes nothing but still triggers the scan', async () => {
    const res = await fetch(`${base}/api/identity/webhook/radarr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-id': 'hook-secret' },
      body: JSON.stringify({ eventType: 'MovieAdded', movie: { folderPath: '/processed_movies/Coming Soon', tmdbId: 1 } }),
    });
    const body = await res.json();
    expect(body.events[0]).toMatchObject({ kind: 'added', outcome: 'missing-folder' });
    expect(body.scanRequested).toBe(true);
    await expect(fs.access(join(basePath, 'movies', 'Coming Soon'))).rejects.toBeDefined();
  });

  it('unknown provider → 404, unrecognized payload → 400', async () => {
    const headers = { 'content-type': 'application/json', 'x-webhook-id': 'hook-secret' };
    expect((await fetch(`${base}/api/identity/webhook/plex`, { method: 'POST', headers, body: '{"eventType":"Test"}' })).status).toBe(404);
    expect((await fetch(`${base}/api/identity/webhook/radarr`, { method: 'POST', headers, body: '{"hello":"world"}' })).status).toBe(400);
  });

  it('POST /reconcile runs a full pass and GET /report returns it', async () => {
    const run = await fetch(`${base}/api/identity/reconcile`, { method: 'POST', headers: { 'x-webhook-id': 'hook-secret' } });
    expect(run.status).toBe(200);
    const report = await run.json();
    expect(report).toMatchObject({ reason: 'manual', totals: expect.objectContaining({ claimed: 1, keep: 1 }) });
    expect(report.index.providers[0]).toMatchObject({ name: 'radarr', ok: true, claims: 1 });

    const fetched = await (await fetch(`${base}/api/identity/report`, { headers: { 'x-webhook-id': 'hook-secret' } })).json();
    expect(fetched.at).toBe(report.at);
    expect(service.getStatus().lastReport).toMatchObject({ reason: 'manual', totals: expect.any(Object) });
    expect(service.getStatus().recentEvents.length).toBeGreaterThan(0);
  });

  it('concurrent tick reconciles share one run', async () => {
    const [a, b] = await Promise.all([service.reconcileForTick(), service.reconcileForTick()]);
    expect(a).toBe(b);
  });

  it('when the provider is down the library is left untouched and the report says why', async () => {
    const down = createIdentityService({
      env: { RADARR_URL: 'http://radarr:7878', RADARR_API_KEY: 'k' },
      basePath,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const report = await down.reconcileForTick();
    expect(report).toMatchObject({ skipped: 'no-provider-data' });
    expect(report.index.providers[0]).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 503/) });
  });
});
