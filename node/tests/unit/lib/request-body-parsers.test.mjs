/**
 * The request-body wiring app.mjs uses (lib/requestBodyParsers.mjs), mounted
 * the same way on an ephemeral port: the global JSON parser first, then the
 * routes, with a stub auth middleware that records what it saw.
 *
 * What it pins:
 *
 *   - the media entries paths, in any case and with a trailing slash, skip
 *     the global parser and get their body from their own parser, after auth;
 *   - every other route still gets a parsed body, up to the global limit, and
 *     /api/discord/events still gets its raw body;
 *   - a large body without credentials is refused by auth, unread: neither
 *     the 30 MB global parser nor the 8 MB entries parser runs first.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'http';

const express = (await import('express')).default;
const { MediaPayloadCache } = await import('../../../lib/mediaPayloadCache.mjs');
const { tvManifestKeys, ENTRIES_REQUEST_BODY_LIMIT } = await import('../../../lib/mediaManifest.mjs');
const { GLOBAL_JSON_BODY_LIMIT, createGlobalJsonParser, mountMediaEntriesRoute } = await import(
  '../../../lib/requestBodyParsers.mjs'
);

const MB = 1024 * 1024;
const quietLogger = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} };

const tvCache = new MediaPayloadCache({
  kind: 'tv',
  version: 1.0001,
  builder: () => ({ seasons: { 'Season 1': { episodes: { S01E01: {} } } } }),
  describe: tvManifestKeys,
  loadRows: async () => [{ name: 'A Show' }],
});
const movieCache = new MediaPayloadCache({
  kind: 'movies',
  version: 1.0001,
  builder: (row) => ({ name: row.name }),
  loadRows: async () => [{ name: 'A Movie' }],
});

let server;
let baseUrl;
let current;

/** What the stub auth saw, and the status the server sent, per request. */
function record(req, res, next) {
  let closed;
  current = { auth: null, status: null, closed: new Promise((resolve) => (closed = resolve)) };
  const mine = current;
  res.on('close', () => {
    mine.status = res.statusCode;
    closed();
  });
  next();
}

function stubAuth(req, res, next) {
  current.auth = { hasBody: 'body' in req, body: req.body, complete: req.complete };
  if (req.headers['x-test-auth'] !== 'ok') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// A route that says what body it got, without echoing a big one.
function describeBody(req, res) {
  const { body } = req;
  res.json({
    type: Buffer.isBuffer(body) ? 'buffer' : body === undefined ? 'none' : typeof body,
    bytes: Buffer.isBuffer(body) ? body.length : JSON.stringify(body ?? null).length,
    keys: body && !Buffer.isBuffer(body) ? Object.keys(body) : [],
  });
}

/**
 * POST raw bytes. The server may refuse before the body is sent and close the
 * connection, so a reset is an outcome here, not a failure.
 */
function post(path, body, headers = {}) {
  return new Promise((resolve) => {
    let response = null;
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          response = { status: res.statusCode, body: Buffer.concat(chunks) };
          resolve(response);
        });
        res.on('error', (error) => resolve({ status: res.statusCode, error }));
      }
    );
    req.on('error', (error) => resolve(response ?? { status: null, error }));
    req.end(body);
  });
}

const json = (value) => Buffer.from(JSON.stringify(value));
const authed = { 'x-test-auth': 'ok' };

/** A JSON entries request of about `size` bytes: one long title. */
const bigTitlesBody = (size) => Buffer.from(`{"titles":["${'x'.repeat(size)}"]}`);

/** The NDJSON lines of an entries answer, split on 0x0A only. */
const lines = (body) =>
  body
    .toString('utf8')
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line));

beforeAll(async () => {
  const app = express();
  app.use(record);
  // As app.mjs: the global parser before every route.
  app.use(createGlobalJsonParser());

  app.post('/api/discord/events', express.raw({ type: 'application/json' }), describeBody);
  app.post('/media/scan', stubAuth, describeBody);
  mountMediaEntriesRoute(app, { kind: 'tv', authenticate: stubAuth, cache: tvCache, logger: quietLogger, errorLabel: 'tv' });
  mountMediaEntriesRoute(app, { kind: 'movies', authenticate: stubAuth, cache: movieCache, logger: quietLogger, errorLabel: 'movies' });
  // Paths next to the entries routes are not theirs.
  app.post('/media/tv/entries/more', describeBody);
  app.post('/media/tv/entries-old', describeBody);
  app.post('/upload', describeBody);

  // As app.mjs's error handler: a body-parser error keeps its status.
  app.use((err, req, res, next) => {
    res.status(Number.isInteger(err?.status) ? err.status : 500).json({ error: err?.type ?? 'error' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

describe('the global JSON parser', () => {
  it('leaves the entries paths, in any case and with a trailing slash, to their own parser after auth', async () => {
    for (const [path, title] of [
      ['/media/tv/entries', 'A Show'],
      ['/MEDIA/TV/ENTRIES', 'A Show'],
      ['/media/tv/Entries/', 'A Show'],
      ['/media/tv/entries?from=test', 'A Show'],
      ['/media/movies/entries', 'A Movie'],
      ['/Media/Movies/Entries/', 'A Movie'],
    ]) {
      const res = await post(path, json({ titles: [title] }), authed);
      await current.closed;
      // Nothing had read the body when auth ran...
      expect([path, current.auth.hasBody, current.auth.body]).toEqual([path, false, undefined]);
      // ...and the handler got it parsed, from the entries' own parser.
      expect([path, res.status]).toEqual([path, 200]);
      const [line, end] = lines(res.body);
      expect([path, line.title, Object.keys(line)]).toEqual([path, title, ['title', 'hash', 'entry']]);
      expect(end).toEqual({ end: true, count: 1 });
    }
  });

  it('parses every other route\'s body before the route runs, up to its own limit', async () => {
    expect(GLOBAL_JSON_BODY_LIMIT).toBe('30mb');

    const scan = await post('/media/scan', json({ movies: true }), authed);
    await current.closed;
    expect(current.auth).toEqual({ hasBody: true, body: { movies: true }, complete: true });
    expect(JSON.parse(scan.body)).toEqual({ type: 'object', bytes: 15, keys: ['movies'] });

    // Paths next to the entries routes are not theirs.
    for (const path of ['/media/tv/entries/more', '/media/tv/entries-old', '/upload', '/UPLOAD/']) {
      const res = await post(path, json({ a: 1 }));
      expect([path, JSON.parse(res.body)]).toEqual([path, { type: 'object', bytes: 7, keys: ['a'] }]);
    }

    // 10 MB: past the entries' 8 MB, within the global 30 MB.
    const big = await post('/upload', bigTitlesBody(10 * MB));
    expect(big.status).toBe(200);
    expect(JSON.parse(big.body)).toEqual({ type: 'object', bytes: 10 * MB + 15, keys: ['titles'] });
  });

  it('leaves /api/discord/events its raw body', async () => {
    const res = await post('/api/discord/events', json({ type: 1 }));
    expect(JSON.parse(res.body)).toEqual({ type: 'buffer', bytes: 10, keys: [] });
  });
});

describe('the entries routes', () => {
  it('refuse a large body without credentials at auth, without reading it', async () => {
    // Past both limits: had the global parser or the entries parser run before
    // auth, the answer would be a 413.
    const body = bigTitlesBody(32 * MB);
    for (const path of ['/media/tv/entries', '/MEDIA/MOVIES/ENTRIES/']) {
      const res = await post(path, body);
      await current.closed;
      expect([path, current.status]).toEqual([path, 401]);
      expect([path, current.auth]).toEqual([path, { hasBody: false, body: undefined, complete: false }]);
      // The client hears the 401, or the connection closing on the rest of its
      // body; never another status.
      if (res.status !== null) expect([path, res.status]).toEqual([path, 401]);
    }
  });

  it('parse an authenticated body after auth, with their own limit', async () => {
    expect(ENTRIES_REQUEST_BODY_LIMIT).toBe('8mb');
    const res = await post('/media/tv/entries', bigTitlesBody(9 * MB), authed);
    await current.closed;
    expect(current.auth.hasBody).toBe(false);
    expect(current.status).toBe(413);
    if (res.status !== null) expect(res.status).toBe(413);
  });
});

describe('mountMediaEntriesRoute', () => {
  it('will not mount an entries route without auth, for another kind, or with the other kind\'s cache', () => {
    const app = express();
    const options = { logger: quietLogger, errorLabel: 'entries' };
    expect(() => mountMediaEntriesRoute(app, { kind: 'tv', cache: tvCache, ...options })).toThrow(/auth/);
    expect(() =>
      mountMediaEntriesRoute(app, { kind: 'music', authenticate: stubAuth, cache: tvCache, ...options })
    ).toThrow(/"music"/);
    expect(() =>
      mountMediaEntriesRoute(app, { kind: 'tv', authenticate: stubAuth, cache: movieCache, ...options })
    ).toThrow(/needs the tv cache/);
  });
});
