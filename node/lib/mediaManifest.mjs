// lib/mediaManifest.mjs
//
// GET /media/<kind>/manifest and POST /media/<kind>/entries: the cached
// /media/tv and /media/movies bodies (lib/mediaPayloadCache.mjs), one title at
// a time.
//
// Every sync tick downloads each server's whole library (about 31 MB on the
// production library), though between two ticks a handful of titles change at
// most. These routes let the frontend fetch only those: the manifest says what
// each title's entry is (a hash) and, for TV, which seasons and episodes it
// has; the entries route sends the entries asked for. Both read the same cache
// generation as GET /media/<kind>, so nothing here builds or reads a row.
//
// THE MANIFEST (GET /media/tv/manifest, GET /media/movies/manifest)
//
//   {
//     "format": 2,                     MANIFEST_FORMAT_VERSION
//     "kind": "tv",                    or "movies"
//     "version": 1.0001,               the list version GET /media/<kind> ends with
//     "titles": {
//       "<folder name>": {
//         "hash": "0123456789abcdef",  the first 16 hex digits of the SHA-1 of the
//                                      title's entry, byte for byte as it sits in
//                                      the GET /media/<kind> body
//         "seasons": {                 TV only: every season key with its episode
//           "Season 1": ["S01E01", "S01E02"]   keys, as the GET body has them
//         }
//       }
//     }
//   }
//
// Titles are keyed by title: the folder name, the key of the GET body. Never by
// mediaId, which can be null or differ between servers. They come in the body's
// order (by name). A season without an episodes map lists []. On the production
// library the manifest is about 130 KB.
//
// Its ETag is a weak tag over the manifest bytes, so it moves whenever a title
// hash, the title set, a season or episode key set, the list version or the
// format moves. It is answered like GET /media/<kind>: If-None-Match is compared
// first and a match is a bodyless 304 whatever the request's Cache-Control says
// (Node's fetch adds no-cache to every conditional request); the bytes and
// their gzip copy are built once per cache generation.
//
// MANIFEST_FORMAT_VERSION versions both routes: raise it when this shape, the
// hash or the entries lines below change. A frontend that sees a format it did
// not store fetches everything. Format 2 added the entries' closing line;
// format 1 had none.
//
// THE ENTRIES (POST /media/tv/entries, POST /media/movies/entries)
//
//   Request:  {"titles": ["<folder name>", ...]}   or   {"all": true}
//   Response: application/x-ndjson, one title per line: in the order asked
//             (a name asked twice is sent once), or in body order for `all`;
//             then the closing line.
//
//     {"title":"<folder name>","hash":"0123456789abcdef","entry":{...}}
//     {"title":"<folder name>","missing":true}
//     {"end":true,"count":2}
//
// Lines end with a single 0x0A byte, and a reader splits them on 0x0A only.
// A line is JSON.stringify output, which leaves U+2028 and U+2029 raw inside
// strings, and a folder name may hold either. Node's readline also ends a line
// at U+2028 and U+2029, so it cuts such a line in two: never read these
// responses with readline.
//
// The closing line, {"end":true,"count":N}, follows the last title line, and
// nothing follows it. N is the number of title lines sent, `missing` lines
// included; an empty list is answered with {"end":true,"count":0} alone. No
// title line has an `end` key. A reader treats a response without the closing
// line, or with a count that does not match the title lines it read, as
// failed: a stream that fails part-way is cut off and never gets one, however
// whole the lines before the cut look.
//
// `entry` is the title's bytes cut from the cached body, the very bytes the
// manifest hash covers. A line's `hash` covers exactly the bytes of its
// `entry`: from the byte after `"entry":` to the byte before the line's final
// `}`. Re-serializing the parsed entry gives the same bytes, so a reader can
// check the hash itself. The hash comes from the same generation as the bytes.
// A title the library does not have (any more) gets a `missing` line.
//
// Two headers name the generation the lines come from, on every 200, before
// the first line: X-Manifest-ETag is the ETag GET /media/<kind>/manifest has
// for it, X-Library-ETag the ETag GET /media/<kind> has for it. Neither is
// exposed to browsers through CORS: read them from a server-side fetch.
//
// The frontend stores the line's hash with what it applied. If the cache was
// rebuilt between its manifest and entries requests, the line's hash (and
// X-Manifest-ETag) differ from the manifest's: the new entry is stored under
// its own hash, never under the old one, and the next tick sees the mismatch.
//
// One response is cut from one generation: the handler holds the body it
// started with, so an invalidation mid-stream cannot mix two. It streams with
// backpressure, gzip when the client takes it. A stream that fails part-way is
// cut off, not ended, and so has no closing line.
//
// The request body is parsed by createEntriesBodyParser, mounted after the auth
// middleware with ENTRIES_REQUEST_BODY_LIMIT; the global JSON parser leaves
// these paths alone. Both are wired in lib/requestBodyParsers.mjs.

import { createHash } from 'crypto';
import { createGzip, gzip as gzipCallback } from 'zlib';
import { promisify } from 'util';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import express from 'express';
import { ifNoneMatchMatches, markPrecompressed } from './mediaPayloadCache.mjs';

const gzip = promisify(gzipCallback);

/**
 * The manifest's shape and hash, and the entries lines. Raise it when any of
 * them changes.
 */
export const MANIFEST_FORMAT_VERSION = 2;

/** Hex digits of the entry's SHA-1 a manifest or entries line carries. */
export const TITLE_HASH_LENGTH = 16;

/**
 * The entries request body limit. `{"all": true}` is the way to ask for the
 * whole library, but a list of every title must fit too: 8 MB holds 30,000
 * names at the 255-byte maximum a folder name can have, and about 180,000 at a
 * typical 45 bytes (the production library has about 1,250 titles).
 */
export const ENTRIES_REQUEST_BODY_LIMIT = '8mb';

/** Lines are sent in chunks of about this size. */
const ENTRIES_CHUNK_BYTES = 64 * 1024;

const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';
const ENTRY_LINE_END = Buffer.from('}\n', 'utf8');

/** The line that closes an entries response of `count` title lines. */
function closingLine(count) {
  return Buffer.from(`{"end":true,"count":${count}}\n`, 'utf8');
}

function sha1Hex(data) {
  return createHash('sha1').update(data).digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The hash a manifest and an entries line carry for a title.
 *
 * @param {string} entryHash - The title's SHA-1 hex, as the cache keeps it
 * @returns {string}
 */
export function titleHash(entryHash) {
  return entryHash.slice(0, TITLE_HASH_LENGTH);
}

/**
 * A built TV entry's season keys, each with its episode keys, in the order the
 * body has them. The TV cache keeps this per title (its `describe` option).
 * A key whose value is undefined is not in the body, so it is not here either.
 *
 * @param {Object} entry - buildTvPayloadEntry's output
 * @returns {Object<string, string[]>} null-prototype, so any key is a key
 */
export function tvManifestKeys(entry) {
  const keys = Object.create(null);
  const seasons = entry?.seasons;
  if (!isPlainObject(seasons)) return keys;
  for (const [seasonKey, season] of Object.entries(seasons)) {
    if (season === undefined) continue;
    const episodes = isPlainObject(season) ? season.episodes : undefined;
    keys[seasonKey] = isPlainObject(episodes)
      ? Object.keys(episodes).filter((episodeKey) => episodes[episodeKey] !== undefined)
      : [];
  }
  return keys;
}

/**
 * Build a manifest from one cache generation's titles.
 *
 * @param {Object} params
 * @param {string} params.kind - 'tv' | 'movies'
 * @param {number} params.version - The list version
 * @param {Array<{name: string, hash: string, keys?: Object, describeError?: string}>} params.titles
 * @returns {Promise<{etag: string, body: Buffer, gzipBody: Buffer, index: Map<string, Object>}>}
 *   `index` maps a name to its title in `titles`.
 * @throws when a TV title has no season keys: a manifest that left a show's
 *   seasons out would read as a show without seasons.
 */
export async function buildManifest({ kind, version, titles }) {
  const parts = [
    `{"format":${MANIFEST_FORMAT_VERSION},"kind":${JSON.stringify(kind)},` +
      `"version":${JSON.stringify(version)},"titles":{`,
  ];
  const index = new Map();
  titles.forEach((title, i) => {
    let record = `{"hash":"${titleHash(title.hash)}"`;
    if (kind === 'tv') {
      if (!isPlainObject(title.keys)) {
        const why = title.describeError ? `: ${title.describeError}` : '';
        throw new Error(`no season keys for TV title ${JSON.stringify(title.name)}${why}`);
      }
      record += `,"seasons":${JSON.stringify(title.keys)}`;
    }
    parts.push(`${i ? ',' : ''}${JSON.stringify(title.name)}:${record}}`);
    index.set(title.name, title);
  });
  parts.push('}}');

  const body = Buffer.from(parts.join(''), 'utf8');
  return {
    etag: `W/"${kind}-manifest-${sha1Hex(body)}"`,
    body,
    gzipBody: await gzip(body),
    index,
  };
}

// One manifest per cache entry (generation); it goes when the entry goes.
const manifests = new WeakMap();

/**
 * The manifest of a cache entry, if it is built. Synchronous: with peek(), the
 * whole cost of a manifest 304.
 *
 * @param {Object} entry - From MediaPayloadCache.peek() / get()
 * @returns {Object|null}
 */
export function peekManifest(entry) {
  return manifests.get(entry)?.value ?? null;
}

/**
 * The manifest of a cache entry, built on first use. Concurrent callers share
 * one build; a failed build is not kept.
 *
 * @param {import('./mediaPayloadCache.mjs').MediaPayloadCache} cache
 * @param {Object} entry - From cache.peek() / cache.get()
 * @returns {Promise<{etag: string, body: Buffer, gzipBody: Buffer, index: Map<string, Object>}>}
 */
export function getManifest(cache, entry) {
  let slot = manifests.get(entry);
  if (!slot) {
    slot = { value: null, promise: null };
    const built = slot;
    slot.promise = buildManifest({ kind: cache.kind, version: cache.version, titles: entry.titles }).then(
      (manifest) => {
        built.value = manifest;
        return manifest;
      },
      (error) => {
        if (manifests.get(entry) === built) manifests.delete(entry);
        throw error;
      }
    );
    manifests.set(entry, slot);
  }
  return slot.promise;
}

/** The cache's current entry and its manifest, building either if needed. */
async function currentGeneration(cache) {
  const entry = cache.peek() ?? (await cache.get());
  const manifest = peekManifest(entry) ?? (await getManifest(cache, entry));
  return { entry, manifest };
}

/**
 * Read an entries request body.
 *
 * @param {*} body - The parsed JSON body (undefined when there was none)
 * @returns {{all: true}|{titles: string[]}|{error: string}} `titles` without
 *   repeats, in the order first asked
 */
export function parseEntriesRequest(body) {
  const usage = 'Send {"titles": ["<folder name>", ...]} or {"all": true} as application/json';
  if (!isPlainObject(body)) return { error: usage };
  const hasAll = Object.hasOwn(body, 'all');
  const hasTitles = Object.hasOwn(body, 'titles');
  if (hasAll && hasTitles) return { error: `Send "titles" or "all", not both. ${usage}` };
  if (hasAll) return body.all === true ? { all: true } : { error: `"all" must be true. ${usage}` };
  if (!hasTitles) return { error: usage };
  if (!Array.isArray(body.titles) || !body.titles.every((name) => typeof name === 'string')) {
    return { error: `"titles" must be an array of strings. ${usage}` };
  }
  return { titles: [...new Set(body.titles)] };
}

/**
 * The NDJSON lines for `picks`, then the closing line, in chunks of about
 * `chunkBytes`. Pulled one chunk at a time, so it runs only as fast as the
 * client reads; a stream cut off part-way never pulls the closing line.
 *
 * @param {Buffer} body - The cache entry's body
 * @param {Array<{name: string, title: Object|null}>} picks
 * @param {number} chunkBytes
 */
function* entryLineChunks(body, picks, chunkBytes) {
  let parts = [];
  let size = 0;
  for (const { name, title } of picks) {
    if (title) {
      const head = Buffer.from(
        `{"title":${JSON.stringify(name)},"hash":"${titleHash(title.hash)}","entry":`,
        'utf8'
      );
      parts.push(head, body.subarray(title.start, title.end), ENTRY_LINE_END);
      size += head.length + (title.end - title.start) + ENTRY_LINE_END.length;
    } else {
      const line = Buffer.from(`{"title":${JSON.stringify(name)},"missing":true}\n`, 'utf8');
      parts.push(line);
      size += line.length;
    }
    if (size >= chunkBytes) {
      yield Buffer.concat(parts, size);
      parts = [];
      size = 0;
    }
  }
  // One line per pick was sent above, missing ones included.
  const end = closingLine(picks.length);
  parts.push(end);
  size += end.length;
  yield Buffer.concat(parts, size);
}

/**
 * The GET handler for /media/<kind>/manifest. Mount it after the auth
 * middleware.
 *
 * @param {import('./mediaPayloadCache.mjs').MediaPayloadCache} cache
 * @param {Object} options
 * @param {Object} options.logger
 * @param {string} options.errorLabel - Log prefix for a failed build
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<void>}
 */
export function createManifestHandler(cache, { logger, errorLabel }) {
  return async function mediaManifestHandler(req, res) {
    markPrecompressed(res);

    let manifest;
    try {
      ({ manifest } = await currentGeneration(cache));
    } catch (error) {
      logger.error(`${errorLabel}: ${error}`);
      res.status(500).send('Internal server error');
      return;
    }

    res.setHeader('ETag', manifest.etag);
    res.vary('Accept-Encoding');

    // Before anything else, and regardless of the request's Cache-Control.
    if (ifNoneMatchMatches(req.headers['if-none-match'], manifest.etag)) {
      res.status(304).end();
      return;
    }

    const useGzip = req.acceptsEncodings('gzip') === 'gzip';
    const body = useGzip ? manifest.gzipBody : manifest.body;
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (useGzip) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', body.length);
    res.end(body);
  };
}

/**
 * The JSON body parser for the entries routes, with their own limit. Mount it
 * after the auth middleware.
 *
 * @returns {import('express').RequestHandler}
 */
export function createEntriesBodyParser() {
  return express.json({ limit: ENTRIES_REQUEST_BODY_LIMIT });
}

/**
 * The POST handler for /media/<kind>/entries. Mount it after the auth
 * middleware and createEntriesBodyParser.
 *
 * @param {import('./mediaPayloadCache.mjs').MediaPayloadCache} cache
 * @param {Object} options
 * @param {Object} options.logger
 * @param {string} options.errorLabel - Log prefix for a failed build or stream
 * @param {number} [options.chunkBytes]
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<void>}
 */
export function createEntriesHandler(cache, { logger, errorLabel, chunkBytes = ENTRIES_CHUNK_BYTES }) {
  return async function mediaEntriesHandler(req, res) {
    markPrecompressed(res);

    const request = parseEntriesRequest(req.body);
    if (request.error) {
      res.status(400).json({ error: 'Bad request', message: request.error });
      return;
    }

    let entry;
    let manifest;
    try {
      ({ entry, manifest } = await currentGeneration(cache));
    } catch (error) {
      logger.error(`${errorLabel}: ${error}`);
      res.status(500).send('Internal server error');
      return;
    }

    // Everything below reads `entry`, never the cache again: one generation.
    const picks = request.all
      ? entry.titles.map((title) => ({ name: title.name, title }))
      : request.titles.map((name) => ({ name, title: manifest.index.get(name) ?? null }));

    const useGzip = req.acceptsEncodings('gzip') === 'gzip';
    res.status(200);
    res.setHeader('Content-Type', NDJSON_CONTENT_TYPE);
    res.setHeader('X-Manifest-ETag', manifest.etag);
    res.setHeader('X-Library-ETag', entry.etag);
    res.vary('Accept-Encoding');
    if (useGzip) res.setHeader('Content-Encoding', 'gzip');

    const source = Readable.from(entryLineChunks(entry.body, picks, chunkBytes), { objectMode: false });
    try {
      if (useGzip) await pipeline(source, createGzip(), res);
      else await pipeline(source, res);
      logger.debug?.(
        `/media/${cache.kind}/entries: ${picks.length} titles, ` +
          `${picks.filter((pick) => !pick.title).length} missing`
      );
    } catch (error) {
      // The response is cut off, not ended, so the client sees the failure.
      if (error?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.debug?.(`${errorLabel}: the client went away mid-stream`);
        return;
      }
      logger.error(`${errorLabel}: ${error}`);
    }
  };
}
