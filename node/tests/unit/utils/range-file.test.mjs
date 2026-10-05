/**
 * utils/rangeFile.mjs, against a real file and a real HTTP server.
 *
 * Safari and AVPlayer decide whether a file is playable from how the server
 * answers ranges: an opening `bytes=0-1`, then the index and the tail, the tail
 * often as a suffix range. The two helpers this replaces answered a suffix
 * range with 416 (one of them) and a last byte past the end with 416 (both).
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../lib/logger.mjs', () => ({
  createCategoryLogger: () => logger,
}));

const { resolveByteRange, sendFileWithRanges } = await import('../../../utils/rangeFile.mjs');

describe('resolveByteRange', () => {
  const SIZE = 1000;

  it('sends the whole file when there is no usable Range header', () => {
    expect(resolveByteRange(undefined, SIZE)).toBeNull();
    expect(resolveByteRange('', SIZE)).toBeNull();
    expect(resolveByteRange('bytes=-', SIZE)).toBeNull();
    expect(resolveByteRange('bytes=abc-def', SIZE)).toBeNull();
    expect(resolveByteRange('items=0-5', SIZE)).toBeNull();
    // Several ranges would need a multipart reply; a server may ignore the header instead.
    expect(resolveByteRange('bytes=0-1,5-9', SIZE)).toBeNull();
    // last < first is not a range at all.
    expect(resolveByteRange('bytes=500-100', SIZE)).toBeNull();
  });

  it('resolves first-last, open-ended and single-byte ranges', () => {
    expect(resolveByteRange('bytes=0-1', SIZE)).toEqual({ start: 0, end: 1 });
    expect(resolveByteRange('bytes=0-', SIZE)).toEqual({ start: 0, end: 999 });
    expect(resolveByteRange('bytes=200-299', SIZE)).toEqual({ start: 200, end: 299 });
    expect(resolveByteRange('bytes=999-999', SIZE)).toEqual({ start: 999, end: 999 });
    expect(resolveByteRange(' bytes=10-20 ', SIZE)).toEqual({ start: 10, end: 20 });
  });

  it('resolves a suffix range to the last N bytes', () => {
    expect(resolveByteRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
    // Asking for more than there is gets all of it.
    expect(resolveByteRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('clamps a last byte past the end instead of refusing it', () => {
    expect(resolveByteRange('bytes=900-1999', SIZE)).toEqual({ start: 900, end: 999 });
    expect(resolveByteRange('bytes=0-1000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('is unsatisfiable only when the range starts past the end, or asks for no bytes', () => {
    expect(resolveByteRange('bytes=1000-', SIZE)).toBe('unsatisfiable');
    expect(resolveByteRange('bytes=1000-1100', SIZE)).toBe('unsatisfiable');
    expect(resolveByteRange('bytes=-0', SIZE)).toBe('unsatisfiable');
  });
});

describe('sendFileWithRanges', () => {
  const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  let dir;
  let filePath;
  let server;
  let origin;
  let options;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'range-file-'));
    filePath = path.join(dir, 'clip.mp4');
    await fs.writeFile(filePath, BODY);

    options = { contentType: 'video/mp4', cacheControl: 'public, max-age=31536000' };
    server = http.createServer((req, res) => {
      const target = req.url.startsWith('/missing') ? path.join(dir, 'nope.mp4') : filePath;
      sendFileWithRanges(req, res, target, options).catch((error) => {
        res.writeHead(500, { 'X-Error': error.code ?? 'unknown' });
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const get = (headers = {}, init = {}) => fetch(`${origin}/clip`, { headers, ...init });
  const bytes = async (response) => Buffer.from(await response.arrayBuffer());

  it('sends the whole file, and says it accepts ranges', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-length')).toBe('1000');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000');
    expect(response.headers.get('etag')).toMatch(/^"1000-\d+"$/);
    expect((await bytes(response)).equals(BODY)).toBe(true);
  });

  it('answers the probe a media element opens with: bytes=0-1', async () => {
    const response = await get({ Range: 'bytes=0-1' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-1/1000');
    expect(response.headers.get('content-length')).toBe('2');
    expect((await bytes(response)).equals(BODY.subarray(0, 2))).toBe(true);
  });

  it('serves a middle range and an open-ended one', async () => {
    const middle = await get({ Range: 'bytes=200-299' });
    expect(middle.status).toBe(206);
    expect(middle.headers.get('content-range')).toBe('bytes 200-299/1000');
    expect((await bytes(middle)).equals(BODY.subarray(200, 300))).toBe(true);

    const tail = await get({ Range: 'bytes=990-' });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect((await bytes(tail)).equals(BODY.subarray(990))).toBe(true);
  });

  it('serves a suffix range, which is how a player fetches the end of a file', async () => {
    const response = await get({ Range: 'bytes=-100' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 900-999/1000');
    expect((await bytes(response)).equals(BODY.subarray(900))).toBe(true);
  });

  it('clamps a range that runs past the end', async () => {
    const response = await get({ Range: 'bytes=900-4999' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 900-999/1000');
    expect(response.headers.get('content-length')).toBe('100');
  });

  it('answers 416 with the real size for a range that starts past the end', async () => {
    const response = await get({ Range: 'bytes=1000-' });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */1000');
  });

  it('answers 304 to a matching If-None-Match, in any of its forms', async () => {
    const etag = (await get()).headers.get('etag');

    for (const value of [etag, `W/${etag}`, `"something-else", ${etag}`, '*']) {
      const response = await get({ 'If-None-Match': value });
      expect(response.status).toBe(304);
      expect(response.headers.get('etag')).toBe(etag);
    }

    expect((await get({ 'If-None-Match': '"other"' })).status).toBe(200);
  });

  it('answers 304 to a matching If-Modified-Since, unless If-None-Match disagrees', async () => {
    const first = await get();
    const lastModified = first.headers.get('last-modified');

    expect((await get({ 'If-Modified-Since': lastModified })).status).toBe(304);
    expect((await get({ 'If-Modified-Since': lastModified, 'If-None-Match': '"other"' })).status).toBe(200);
  });

  it('honours If-Range: a range of the same file, the whole file if it has changed', async () => {
    const etag = (await get()).headers.get('etag');

    const same = await get({ Range: 'bytes=0-9', 'If-Range': etag });
    expect(same.status).toBe(206);

    // The client holds part of an older clip. A slice of the new one would be
    // spliced into it; the whole new file replaces it.
    const changed = await get({ Range: 'bytes=0-9', 'If-Range': '"999-1"' });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('content-length')).toBe('1000');
  });

  it('answers HEAD with the headers and no body', async () => {
    const response = await get({}, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('1000');
    expect((await bytes(response)).length).toBe(0);
  });

  it('throws before writing anything when the file is not there', async () => {
    const response = await fetch(`${origin}/missing`);
    expect(response.status).toBe(500);
    expect(response.headers.get('x-error')).toBe('ENOENT');
  });

  it('stamps the access time when asked, and leaves the modification time alone', async () => {
    const past = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(filePath, past, past);
    const etagBefore = (await get()).headers.get('etag');

    options = { ...options, touchAccessTime: true };
    try {
      const response = await get();
      await response.arrayBuffer();
      const stat = await fs.stat(filePath);
      expect(stat.mtime.getTime()).toBe(past.getTime());
      expect(response.headers.get('etag')).toBe(etagBefore);
      // Recent, where it was 2020 a moment ago.
      expect(Date.now() - stat.atime.getTime()).toBeLessThan(60_000);
    } finally {
      options = { contentType: 'video/mp4', cacheControl: 'public, max-age=31536000' };
    }
  });

  it('keeps the same ETag from one serve to the next while stamping access times', async () => {
    // A modification time with a sub-millisecond part, as a freshly written file
    // has. Writing it back while touching the access time must not move the
    // validator, or a player's second range request stops matching its first.
    await fs.utimes(filePath, new Date(), 1600000000.123789);

    options = { ...options, touchAccessTime: true };
    try {
      const etags = [];
      for (let request = 0; request < 3; request += 1) {
        const response = await get({ Range: 'bytes=0-1' });
        expect(response.status).toBe(206);
        etags.push(response.headers.get('etag'));
        await response.arrayBuffer();
      }
      expect(new Set(etags).size).toBe(1);

      const ranged = await get({ Range: 'bytes=2-9', 'If-Range': etags[0] });
      expect(ranged.status).toBe(206);
    } finally {
      options = { contentType: 'video/mp4', cacheControl: 'public, max-age=31536000' };
    }
  });

  it('does not log a client that stops listening as an error', async () => {
    logger.error.mockClear();
    const big = path.join(dir, 'big.mp4');
    await fs.writeFile(big, Buffer.alloc(8 * 1024 * 1024));

    const bigServer = http.createServer((req, res) => {
      sendFileWithRanges(req, res, big, options).catch(() => res.destroy());
    });
    await new Promise((resolve) => bigServer.listen(0, '127.0.0.1', resolve));

    try {
      await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${bigServer.address().port}/`, (response) => {
          response.once('data', () => {
            request.destroy(); // walk away mid-body, as a seeking player does
          });
          response.once('close', resolve);
        });
        request.on('error', (error) => (error.code === 'ECONNRESET' ? resolve() : reject(error)));
      });
      // Give the server side a moment to notice and finish its pipeline.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await new Promise((resolve) => bigServer.close(resolve));
    }

    expect(logger.error).not.toHaveBeenCalled();
  });
});
