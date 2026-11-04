/**
 * The intake's HTTP surface (integrations/alert-intake/routes.mjs), mounted
 * on a bare app as routes/index.mjs mounts it, with Discord stubbed and an
 * app-level error handler that records anything reaching it (the processor's
 * own logs it at error level, which the alert rules count). Real requests on
 * an ephemeral port.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import net from 'net';
import http from 'http';
import express from 'express';
import { setupAlertIntakeRoutes } from '../../../../integrations/alert-intake/routes.mjs';
import { createAlertIntake } from '../../../../integrations/alert-intake/index.mjs';
import { KEY, fixtureFetch } from '../../../helpers/alertIntake.mjs';

const lines = [];
const keep = (level) => (message) => lines.push(`${level} ${message}`);
const log = { info: keep('info'), warn: keep('warn'), error: keep('error'), debug: keep('debug') };
const setupLines = [];
const setupLog = { info: (m) => setupLines.push(`info ${m}`), warn: (m) => setupLines.push(`warn ${m}`), error: (m) => setupLines.push(`error ${m}`), debug() {} };

const sink = {
  targets: true,
  next: null,
  sent: [],
  hasTargets() {
    return this.targets;
  },
  async deliver(embeds) {
    this.sent.push(embeds);
    return this.next ?? { ok: true, delivered: 1, failed: 0 };
  },
};

const appErrors = [];
const servers = [];

async function mount(intake) {
  const app = express();
  app.use('/api/alert-intake', setupAlertIntakeRoutes({ intake }));
  app.use((error, req, res, next) => {
    appErrors.push(error);
    res.status(500).end();
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

let base;
let intake;
const bearer = { authorization: `Bearer ${KEY}` };

beforeAll(async () => {
  intake = createAlertIntake({ env: { ALERT_INTAKE_KEYS: `signoz:${KEY}`, FILE_SERVER_NODE_URL: 'https://tower.example.com' }, log, setupLog, sink, relayOptions: { breakerMs: 200 } });
  base = await mount(intake);
});

afterAll(async () => {
  await intake.relay.drain();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

beforeEach(() => {
  sink.next = null;
});

// Past the 200 ms breaker a refused send leaves open.
const breakerClosed = () => new Promise((resolve) => setTimeout(resolve, 250));

/** A raw request, so the body and its headers are exactly as written. */
function rawRequest(text) {
  return new Promise((resolve) => {
    const socket = net.connect(Number(new URL(base).port), '127.0.0.1', () => socket.end(text));
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
  });
}

describe('state', () => {
  it('logs its state at startup under the setup category, naming sources, never keys', () => {
    expect(setupLines).toEqual(['info Alert intake on at /api/alert-intake for 1 source(s): signoz; formats generic, alertmanager, gotify, ntfy']);
  });

  it('answers 404 when off and 503 when misconfigured, logging each problem loudly at startup', async () => {
    const offLines = [];
    const off = createAlertIntake({ env: {}, log, setupLog: { ...setupLog, info: (m) => offLines.push(m) }, sink });
    const offBase = await mount(off);
    const res = await fetch(`${offBase}/api/alert-intake/gotify/message?token=${KEY}`, { method: 'POST', body: '{"message":"x"}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ errorCode: 404, errorDescription: 'alert intake is not enabled on this server' });
    expect(offLines).toEqual(['Alert intake is off: ALERT_INTAKE_KEYS is not set']);

    const errors = [];
    const bad = createAlertIntake({ env: { ALERT_INTAKE_KEYS: 'signoz:short' }, log, setupLog: { ...setupLog, error: (m) => errors.push(m) }, sink });
    const badBase = await mount(bad);
    expect((await fetch(`${badBase}/api/alert-intake/generic`, { method: 'POST', headers: bearer })).status).toBe(503);
    expect(errors[0]).toContain('entry 1 (signoz): the key must be');
    expect(errors.at(-1)).toContain('refusing every request (503)');
    expect(errors.join()).not.toContain('short');
  });

  it('says loudly at startup when there is no Discord channel to relay to', () => {
    const errors = [];
    sink.targets = false;
    createAlertIntake({ env: { ALERT_INTAKE_KEYS: `signoz:${KEY}` }, log, setupLog: { ...setupLog, error: (m) => errors.push(m) }, sink });
    sink.targets = true;
    expect(errors).toEqual([expect.stringContaining('has no Discord channel to relay to')]);
  });
});

describe('keys and bodies', () => {
  it('refuses a large body without a key unread, and closes the connection on a 401', async () => {
    const before = sink.sent.length;
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const result = await new Promise((resolve) => {
      const req = http.request(`${base}/api/alert-intake/alertmanager`, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': big.length } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, challenge: res.headers['www-authenticate'] }));
      });
      req.on('error', () => resolve({ status: null }));
      req.end(big);
    });
    if (result.status !== null) expect(result).toEqual({ status: 401, connection: 'close', challenge: 'Bearer realm="alert-intake"' });
    expect(sink.sent.length).toBe(before);
  });

  it('answers 413 past the format\'s limit, with Connection: close', async () => {
    const res = await fetch(`${base}/api/alert-intake/generic`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: `{"title":"${'x'.repeat(70 * 1024)}"}` });
    expect(res.status).toBe(413);
    expect(res.headers.get('connection')).toBe('close');
  });

  it('reads a request with no Content-Length as an empty body (Sonarr\'s query-only ntfy publish)', async () => {
    const response = await rawRequest(
      `POST /api/alert-intake/ntfy/sonarr?message=from+the+query&title=Health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${KEY}\r\nConnection: close\r\n\r\n`
    );
    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
    expect(response).toContain('"message":"from the query"');
  });

  it('answers 405 with Allow, 415 for a wrong type, and 404 in the format\'s shape for unknown paths', async () => {
    const get = await fetch(`${base}/api/alert-intake/ntfy/topic`, { headers: bearer });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, PUT');
    expect((await fetch(`${base}/api/alert-intake/alertmanager`, { method: 'POST', headers: { ...bearer, 'content-type': 'text/xml' }, body: '<x/>' })).status).toBe(415);
    const unknown = await fetch(`${base}/api/alert-intake/gotify/version?token=${KEY}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ errorCode: 404 });
    expect((await (await fetch(`${base}/api/alert-intake/ntfy/a/b`, { method: 'POST' })).json()).code).toBe(40401);
  });
});

describe('errors never leave the intake router', () => {
  it('answers a malformed %-escape in a param itself, in the format\'s shape', async () => {
    const res = await fetch(`${base}/api/alert-intake/ntfy/%ZZ`, { method: 'POST', headers: bearer, body: 'x' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 40001, http: 400, error: 'the request URL could not be decoded' });
    expect(appErrors).toEqual([]);
  });

  it('answers a throwing relay with a 500 in shape, logging the error\'s name and place, not its message', async () => {
    const broken = createAlertIntake({ env: { ALERT_INTAKE_KEYS: `signoz:${KEY}` }, log, setupLog, sink });
    broken.relay.deliver = async () => {
      throw new TypeError(`boom with ${KEY} in it`);
    };
    const brokenBase = await mount(broken);
    const res = await fetch(`${brokenBase}/api/alert-intake/generic`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{"title":"t"}' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, message: 'the alert intake failed on this request' });
    expect(appErrors).toEqual([]);
    const line = lines.find((entry) => entry.includes('An alert intake request failed'));
    expect(line).toMatch(/^warn An alert intake request failed: TypeError at /);
    expect(line).not.toContain('boom');
  });
});

describe('outcomes', () => {
  it('answers 200 with the outcome header when delivered, then as a duplicate', async () => {
    const first = await fixtureFetch('signoz-firing', base);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-alert-intake-outcome')).toBe('delivered');
    expect(first.headers.get('cache-control')).toBe('no-store');
    const again = await fixtureFetch('signoz-firing', base);
    expect(again.headers.get('x-alert-intake-outcome')).toBe('duplicate');
  });

  it('answers 502 when Discord refuses, then 503 with Retry-After while the breaker is open', async () => {
    sink.next = { ok: false, reason: 'rejected', detail: 'Cannot send messages to this user' };
    const refused = await fetch(`${base}/api/alert-intake/generic`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{"title":"refused one"}' });
    expect(refused.status).toBe(502);
    const paused = await fetch(`${base}/api/alert-intake/generic`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{"title":"another"}' });
    expect(paused.status).toBe(503);
    expect(Number(paused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(lines.some((line) => line.startsWith('warn Relay to Discord failed for signoz: Discord refused it'))).toBe(true);
  });

  it('answers 503 when there is no Discord target, without opening the breaker', async () => {
    await breakerClosed();
    sink.next = { ok: false, reason: 'no-target' };
    const res = await fetch(`${base}/api/alert-intake/generic`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{"title":"nowhere"}' });
    expect(res.status).toBe(503);
    expect((await res.json()).message).toBe('this server has no Discord channel to relay to');
    // No Discord call was made, so nothing pauses: the next request goes through.
    sink.next = null;
    const next = await fetch(`${base}/api/alert-intake/generic`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{"title":"right after"}' });
    expect(next.status).toBe(200);
  });
});

describe('what is logged', () => {
  it('logs a refusal with the route and socket address only, once a minute, never the caller\'s headers', async () => {
    // Its own intake: the refusals above already used this minute's line.
    const fresh = createAlertIntake({ env: { ALERT_INTAKE_KEYS: `signoz:${KEY}` }, log, setupLog, sink });
    const freshBase = await mount(fresh);
    const before = lines.length;
    const spoofed = { 'user-agent': 'Bearer AAAAAAAAAAAAAAAAAAAAAAAA', 'x-forwarded-for': '?token=abcdefgh', authorization: 'Bearer not-the-key-not-the-key-not-the' };
    for (let index = 0; index < 3; index += 1) {
      await fetch(`${freshBase}/api/alert-intake/ntfy/topic?auth=bad&token=abcdefgh`, { method: 'POST', headers: spoofed, body: 'x' });
    }
    const refusals = lines.slice(before).filter((line) => line.includes('Refused an alert intake request'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/^warn Refused an alert intake request \(malformed key\): POST \/api\/alert-intake\/ntfy\/:topic from [\d.:a-f]+$/);
    // The two folded into it are reported with the next line written.
    expect(lines.slice(before).join('\n')).not.toContain('AAAAAAAA');
  });

  it('never logs a key, a payload string or a query', () => {
    const all = [...lines, ...setupLines].join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('Indexers unavailable');
    expect(all).not.toContain('abcdefgh');
    expect(all).not.toContain('AAAAAAAAAAAA');
    expect(lines.filter((line) => line.startsWith('error '))).toEqual([]);
  });
});
