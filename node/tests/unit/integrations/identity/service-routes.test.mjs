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

  it('a webhook that touches a folder refreshes the report before answering', async () => {
    const res = await fetch(`${base}/api/identity/webhook/radarr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-id': 'hook-secret' },
      body: JSON.stringify({ eventType: 'Rename', movie: { folderPath: '/processed_movies/The Professor', tmdbId: 467956 } }),
    });
    const body = await res.json();
    expect(body).toMatchObject({ accepted: true, reportRefreshed: true, scanRequested: true });
    const report = service.getLastReport();
    expect(report.reason).toBe('radarr-webhook');
    expect(report.checkedReason).toBe('radarr-webhook');
    expect(report.unchanged).toBe(false);
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

/**
 * Freshness on the processor's own initiative: the job path pulls the
 * providers every interval, and the change detector makes a quiet pass cost
 * nothing on disk. Measured against the production case of 2026-09-22: Radarr
 * repointed and rescanned a movie during a ten-minute scan tick, and the
 * report kept describing the tick's start for nine minutes.
 */
describe('identity job and change detector', () => {
  const basePath = join(tmpdir(), `identity-job-${randomUUID()}`);
  const endDir = join(basePath, 'movies', 'The End (2017)');
  const duneDir = join(basePath, 'movies', 'Dune (2021)');

  // Mutable provider state the fake fetch serves.
  let radarrItems;
  let radarrFails = false;
  let sonarrFails = false;
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/v3/movie') {
      if (radarrFails) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => radarrItems };
    }
    if (pathname === '/api/v3/series') {
      if (sonarrFails) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  // Deterministic clock: every call is one second later.
  let tick = Date.parse('2026-09-22T05:21:00Z');
  const now = () => new Date((tick += 1000));

  const requestScan = jest.fn(async () => {});
  const timers = [];
  const setIntervalImpl = jest.fn((fn, ms) => { const t = { fn, ms, unref: jest.fn() }; timers.push(t); return t; });
  const clearIntervalImpl = jest.fn();
  let service;

  const mtime = async (p) => (await fs.stat(p)).mtimeMs;

  beforeAll(async () => {
    await fs.mkdir(endDir, { recursive: true });
    await fs.mkdir(duneDir, { recursive: true });
    // Dune: correct auto pin. The End (2017): Radarr filed it under a different folder name with no file (the production case was ? vs !, which Windows cannot create here).
    await saveTmdbConfig(join(duneDir, 'tmdb.config'), { tmdb_id: 438631, tmdb_id_source: 'auto' });
    radarrItems = [
      { id: 1, title: 'Dune', year: 2021, path: '/processed_movies/Dune (2021)', tmdbId: 438631, hasFile: true, monitored: true },
      { id: 795, title: 'The End?', year: 2017, path: '/processed_movies/The End 2017', tmdbId: 464737, hasFile: false, monitored: true },
    ];
    service = createIdentityService({
      env: { RADARR_URL: 'http://radarr:7878', RADARR_API_KEY: 'k', SONARR_URL: 'http://sonarr:8989', SONARR_API_KEY: 'k' },
      basePath,
      requestScan,
      fetchImpl,
      intervalMs: 60000,
      now,
      setIntervalImpl,
      clearIntervalImpl,
    });
  });

  afterAll(async () => {
    service.stop();
    await fs.rm(basePath, { recursive: true, force: true });
  });

  it('publishes its cadence: staleAfterMs is three times the job interval', () => {
    expect(service.reconcileIntervalMs).toBe(60000);
    expect(service.staleAfterMs).toBe(180000);
    expect(service.getStatus()).toMatchObject({ reconcileIntervalMs: 60000, staleAfterMs: 180000, jobRunning: false });
  });

  it('start() schedules the job once and stop() clears it', () => {
    expect(service.start()).toBe(true);
    expect(service.start()).toBe(false);
    expect(setIntervalImpl).toHaveBeenCalledTimes(1);
    expect(timers[0].ms).toBe(60000);
    expect(timers[0].unref).toHaveBeenCalled();
    expect(service.getStatus().jobRunning).toBe(true);
    service.stop();
    expect(clearIntervalImpl).toHaveBeenCalledWith(timers[0]);
    expect(service.getStatus().jobRunning).toBe(false);
  });

  it('first job run reconciles: the on-disk folder is unmanaged, the Radarr folder is provider-only with no file', async () => {
    const report = await service.reconcileForTick({ reason: 'identity-tick' });
    expect(report).toMatchObject({ reason: 'identity-tick', checkedReason: 'identity-tick', unchanged: false, staleAfterMs: 180000 });
    expect(report.checkedAt).toBe(report.at);
    expect(report.totals).toMatchObject({ stamp: 1, providerOnly: 1, unmanaged: 1, write: 0 });
    expect(report.unmanaged.items).toEqual(['movies/The End (2017)']);
    expect(report.providerOnly.items[0]).toMatchObject({ libraryRelativePath: 'movies/The End 2017', hasFile: false });
  });

  it('a quiet job run keeps `at`, advances `checkedAt`, says unchanged, and writes nothing', async () => {
    const before = service.getLastReport();
    const duneMtime = await mtime(join(duneDir, 'tmdb.config'));
    const report = await service.reconcileForTick({ reason: 'identity-tick' });
    expect(report.unchanged).toBe(true);
    expect(report.at).toBe(before.at);
    expect(report.reason).toBe('identity-tick');
    expect(Date.parse(report.checkedAt)).toBeGreaterThan(Date.parse(before.checkedAt));
    expect(report.totals).toEqual(before.totals);
    expect(await mtime(join(duneDir, 'tmdb.config'))).toBe(duneMtime);
    expect(service.getStatus().lastReport).toMatchObject({ unchanged: true, checkedReason: 'identity-tick', at: before.at });
  });

  it('a change outside the fingerprint (monitored, quality profile) is still a quiet run', async () => {
    const before = service.getLastReport();
    radarrItems = radarrItems.map((i) => ({ ...i, monitored: false, qualityProfileId: 7 }));
    const report = await service.reconcileForTick({ reason: 'identity-tick' });
    expect(report.unchanged).toBe(true);
    expect(report.at).toBe(before.at);
  });

  it('the production case: Radarr repointed to the real folder, so the next job run pins and reports it', async () => {
    const before = service.getLastReport();
    radarrItems = radarrItems.map((i) => (i.id === 795 ? { ...i, path: '/processed_movies/The End (2017)', hasFile: true } : i));
    const report = await service.reconcileForTick({ reason: 'identity-tick' });
    expect(report.unchanged).toBe(false);
    expect(Date.parse(report.at)).toBeGreaterThan(Date.parse(before.at));
    expect(report.totals).toMatchObject({ write: 1, providerOnly: 0, unmanaged: 0 });
    expect(report.written.items[0]).toMatchObject({ libraryRelativePath: 'movies/The End (2017)', tmdbId: 464737, source: 'radarr', replacedId: null });
    expect(await loadTmdbConfig(join(endDir, 'tmdb.config'))).toMatchObject({ tmdb_id: 464737, tmdb_id_source: 'radarr' });
    // A new pin (not a repair) does not by itself request an early scan.
    expect(requestScan).not.toHaveBeenCalled();
  });

  it('a repair found by the job requests an early scan so the title regenerates now', async () => {
    // Radarr corrects Dune's id; the stored pin is auto, so this is a repair.
    radarrItems = radarrItems.map((i) => (i.id === 1 ? { ...i, tmdbId: 438632 } : i));
    const report = await service.reconcileForTick({ reason: 'identity-tick' });
    expect(report.written.items).toEqual([expect.objectContaining({ libraryRelativePath: 'movies/Dune (2021)', tmdbId: 438632, replacedId: 438631 })]);
    await new Promise((r) => setTimeout(r, 10));
    expect(requestScan).toHaveBeenCalledWith('identity-repair');
  });

  it('a scan tick is forced: it reconciles even when nothing changed', async () => {
    const before = service.getLastReport();
    const report = await service.reconcileForTick({ reason: 'scan-tick' });
    expect(report.unchanged).toBe(false);
    expect(report.reason).toBe('scan-tick');
    expect(Date.parse(report.at)).toBeGreaterThan(Date.parse(before.at));
    expect(report.totals).toMatchObject({ keep: 2, write: 0 });
  });

  it('one provider failing on the job path leaves the last good report untouched', async () => {
    const before = service.getLastReport();
    sonarrFails = true;
    const result = await service.reconcileForTick({ reason: 'identity-tick' });
    expect(result).toMatchObject({ deferred: 'provider-failure', failedProviders: ['sonarr'] });
    const after = service.getLastReport();
    expect(after).toBe(before); // same object, not even checkedAt moved
    const status = service.getStatus();
    expect(status.providers.find((p) => p.name === 'sonarr').lastFetch).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 503/) });
    expect(status.lastReport.skipped).toBeNull();
    sonarrFails = false;
  });

  it('after the provider recovers, the next job run reconciles again rather than trusting the old fingerprint', async () => {
    const before = service.getLastReport();
    const report = await service.reconcileForTick({ reason: 'identity-tick' });
    expect(report.unchanged).toBe(false);
    expect(Date.parse(report.at)).toBeGreaterThan(Date.parse(before.at));
  });

  it('every provider failing still yields the skipped report (the page shows a banner for that)', async () => {
    radarrFails = true;
    sonarrFails = true;
    const report = await service.reconcileForTick({ reason: 'identity-tick' });
    expect(report).toMatchObject({ skipped: 'no-provider-data', checkedReason: 'identity-tick' });
    radarrFails = false;
    sonarrFails = false;
  });

  it('a new folder on disk moves the library fingerprint', async () => {
    await service.reconcileForTick({ reason: 'identity-tick' }); // recover from the skipped state
    const before = service.getLastReport();
    expect(before.skipped).toBeUndefined();
    await fs.mkdir(join(basePath, 'movies', 'Home Video'), { recursive: true });
    const report = await service.reconcileForTick({ reason: 'identity-tick' });
    expect(report.unchanged).toBe(false);
    expect(report.unmanaged.items).toEqual(['movies/Home Video']);
  });

  it('parseReconcileIntervalMs: default, off, floor, garbage', async () => {
    const { parseReconcileIntervalMs } = await import('../../../../integrations/identity/index.mjs');
    expect(parseReconcileIntervalMs(undefined)).toBe(60000);
    expect(parseReconcileIntervalMs('0')).toBe(0);
    expect(parseReconcileIntervalMs('5')).toBe(15000);
    expect(parseReconcileIntervalMs('120')).toBe(120000);
    expect(parseReconcileIntervalMs('soon')).toBe(60000);
  });

  it('with the job off, staleAfterMs falls back to three scan ticks and start() is a no-op', () => {
    const off = createIdentityService({
      env: { RADARR_URL: 'http://radarr:7878', RADARR_API_KEY: 'k', IDENTITY_RECONCILE_INTERVAL_SECONDS: '0' },
      basePath,
      fetchImpl,
    });
    expect(off.reconcileIntervalMs).toBe(0);
    expect(off.staleAfterMs).toBe(540000);
    expect(off.start()).toBe(false);
  });
});
