// utils/rangeFile.mjs
//
// Send a file over HTTP with byte-range and conditional-request support, the
// way a media element expects. Safari and AVPlayer will not play a file whose
// server gets ranges wrong: they open with `Range: bytes=0-1`, then ask for the
// index and the tail (often as a suffix range, `bytes=-N`), and give up on a
// reply that does not match the request.

import { promises as fs } from 'fs';
import { pipeline } from 'stream';
import { createCategoryLogger } from '../lib/logger.mjs';

const logger = createCategoryLogger('range-file');

// What a client that stopped listening looks like from this side. Routine for
// media: a player abandons a range request whenever it seeks.
const CLIENT_ABORT_CODES = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'EPIPE', 'ERR_STREAM_DESTROYED']);

/**
 * Resolve a Range header against a file of `size` bytes (RFC 9110 section 14).
 *
 * @param {string|undefined} header - The Range request header
 * @param {number} size - File size in bytes (> 0)
 * @returns {{ start: number, end: number } | 'unsatisfiable' | null}
 *   A byte range (inclusive); 'unsatisfiable' for a well-formed range that
 *   selects nothing (answer 416); null to send the whole file — no header, or
 *   one this server does not act on (malformed, another unit, several ranges).
 */
export function resolveByteRange(header, size) {
  if (typeof header !== 'string') return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, first, last] = match;
  if (first === '' && last === '') return null;

  if (first === '') {
    // Suffix range: the last N bytes.
    const suffixLength = Number(last);
    if (suffixLength === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(first);
  if (start >= size) return 'unsatisfiable';

  if (last === '') return { start, end: size - 1 };

  const end = Number(last);
  if (end < start) return null; // not a valid range, so the header is ignored
  // A last byte past the end means "to the end", not an error.
  return { start, end: Math.min(end, size - 1) };
}

/** Whether an If-None-Match header names this ETag (weak comparison). */
function matchesEtag(header, etag) {
  if (typeof header !== 'string') return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag);
}

/**
 * Whether an If-Range precondition holds, i.e. the client's partial copy is of
 * this exact file. When it does not, the Range is ignored and the client gets
 * the whole new file instead of a slice it would splice into the old one.
 */
function ifRangeHolds(header, etag, lastModified) {
  if (typeof header !== 'string') return true;
  const value = header.trim();
  return value === etag || value === lastModified;
}

/**
 * Send `filePath` in answer to a GET or HEAD.
 *
 * The file is opened first and everything else (size, validators, the bytes)
 * comes from that open handle, so a cache sweep or an atomic replace that hits
 * the path mid-request cannot make the headers and the body disagree.
 *
 * Throws only before any header is written (the file is missing or unreadable).
 * After that, a failure ends the response and is logged, unless it is just the
 * client going away.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} filePath
 * @param {Object} options
 * @param {string} options.contentType
 * @param {string} options.cacheControl
 * @param {boolean} [options.touchAccessTime=false] - Stamp the file's access time
 *   with now. For caches evicted by access time: most filesystems are mounted
 *   relatime or noatime, where a read does not record one.
 * @returns {Promise<void>} Resolves when the response has ended
 */
export async function sendFileWithRanges(req, res, filePath, { contentType, cacheControl, touchAccessTime = false }) {
  const handle = await fs.open(filePath, 'r');

  let stat;
  try {
    stat = await handle.stat();
    if (touchAccessTime) {
      // Best effort: failing to extend a cache entry's life is not a reason to
      // fail the request. By path, because a read-only handle may not set times.
      await fs.utimes(filePath, new Date(), stat.mtime).catch((error) => {
        logger.debug(`Could not update access time of ${filePath}: ${error.message}`);
      });
    }
  } catch (error) {
    await handle.close();
    throw error;
  }

  const size = stat.size;
  // From stat.mtime (whole milliseconds), not mtimeMs: touching the access time
  // has to write the modification time back, and can only write back the
  // millisecond it read. A validator built from the finer value would change
  // the first time a file is served, mid-way through a player's range requests.
  const etag = `"${size}-${stat.mtime.getTime()}"`;
  const lastModified = stat.mtime.toUTCString();

  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', lastModified);
  res.setHeader('Cache-Control', cacheControl);

  // If-None-Match wins over If-Modified-Since when both are sent.
  const ifNoneMatch = req.headers['if-none-match'];
  const notModified = ifNoneMatch !== undefined
    ? matchesEtag(ifNoneMatch, etag)
    : req.headers['if-modified-since'] === lastModified;
  if (notModified) {
    await handle.close();
    res.writeHead(304);
    res.end();
    return;
  }

  const range = ifRangeHolds(req.headers['if-range'], etag, lastModified)
    ? resolveByteRange(req.headers.range, size)
    : null;

  if (range === 'unsatisfiable') {
    await handle.close();
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;

  res.setHeader('Content-Length', end - start + 1);
  if (range) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.writeHead(range ? 206 : 200);

  if (req.method === 'HEAD') {
    await handle.close();
    res.end();
    return;
  }

  // pipeline, not pipe: it closes the file when the client disconnects, where
  // pipe would leave the descriptor open until garbage collection.
  await new Promise((resolve) => {
    pipeline(handle.createReadStream({ start, end }), res, (error) => {
      if (error && !CLIENT_ABORT_CODES.has(error.code)) {
        logger.error(`Error streaming ${filePath}: ${error.message}`);
      }
      resolve();
    });
  });
}
