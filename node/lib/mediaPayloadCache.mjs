// lib/mediaPayloadCache.mjs
//
// GET /media/tv and GET /media/movies serve the whole library, and the
// frontend sync asks for both on every tick (every 3 minutes, from every
// frontend that reads this server). The TV body alone is tens of megabytes.
//
// Before this, every request read every row, injected the caption stubs and
// serialized the lot, and Express hashed the result for its ETag — so even a
// conditional request that ended in a 304 paid for the whole body (about 1.1 s
// on the production library). Worse, it never ended in a 304: Node's fetch adds
// `Cache-Control: no-cache` to any request carrying If-None-Match, and Express's
// freshness check answers no-cache with a full 200.
//
// So each route keeps its body, built once per scan:
//
//   - the body bytes, and their gzip copy (compressed off the event loop);
//   - per title, where its serialized entry sits in the body and the hash of
//     that entry. The library ETag is a hash over the ordered title hashes, so
//     a manifest of title hashes is already here for whoever needs one;
//   - the autoCaptions settings it was built under, because the caption stubs
//     are injected at build time from those settings, not from the rows.
//
// The cache is dropped when the rows can have changed — the end of a scan
// tick, POST /media/scan — and when the autoCaptions settings change (they
// live in Mongo, written by the frontend; watchPayloadContext polls them). A
// body older than PAYLOAD_CACHE_MAX_AGE_MS is rebuilt on the next request
// whatever happened, as a backstop for any change nothing told us about.
//
// The handler answers If-None-Match itself, before any other work, and ignores
// the request's Cache-Control. A 200 sends the cached bytes as they are; the
// compression middleware must skip them (compressionFilter), or it would
// compress the identity body again on every request.

import { createHash } from 'crypto';
import { gzip as gzipCallback } from 'zlib';
import { promisify } from 'util';
import compression from 'compression';

const gzip = promisify(gzipCallback);

/** The backstop: a body this old is rebuilt on the next request. */
export const PAYLOAD_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

/** How often watchPayloadContext re-reads the autoCaptions settings. */
export const PAYLOAD_CONTEXT_POLL_MS = 30 * 1000;

/** Serialization hands the event loop back at least this often. */
const SERIALIZE_SLICE_MS = 20;

const PRECOMPRESSED = Symbol('mediaPayloadPrecompressed');

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

function sha1Hex(data) {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * Serialize a keyed list response — `{ <name>: entry, ..., "version": v }` —
 * from rows already in their final order.
 *
 * The body parses to exactly what `res.json({ ...buildPayloadMap(rows, builder),
 * version })` sent: the same entries, each serialized by JSON.stringify, and
 * `version` last. Only the byte order of integer-like names can differ (an
 * object literal lists those first), and JSON.parse puts them first again.
 *
 * @param {Object} params
 * @param {string} params.kind - 'tv' | 'movies'; part of the ETag
 * @param {Array<Object>} params.rows - Rows with a `name`, in body order
 * @param {(row: Object) => Object} params.builder - Row to wire entry
 * @param {number} params.version - The list version appended as `version`
 * @returns {Promise<{body: Buffer, titles: Array<{name: string, hash: string, start: number, end: number}>, etag: string}>}
 *   `titles[i]` is the i-th entry: `body.subarray(start, end)` is its JSON and
 *   `hash` is the SHA-1 of those bytes.
 */
export async function serializeKeyedList({ kind, rows, builder, version }) {
  const parts = [Buffer.from('{')];
  const titles = [];
  let offset = 1;
  let sliceStart = performance.now();

  for (const row of rows) {
    const name = String(row.name);
    const entryBytes = Buffer.from(JSON.stringify(builder(row)), 'utf8');
    const prefix = Buffer.from(`${titles.length ? ',' : ''}${JSON.stringify(name)}:`, 'utf8');
    const start = offset + prefix.length;
    const end = start + entryBytes.length;
    parts.push(prefix, entryBytes);
    titles.push({ name, hash: sha1Hex(entryBytes), start, end });
    offset = end;

    if (performance.now() - sliceStart >= SERIALIZE_SLICE_MS) {
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
  }

  parts.push(Buffer.from(`${titles.length ? ',' : ''}"version":${JSON.stringify(version)}}`, 'utf8'));
  const body = Buffer.concat(parts);

  return { body, titles, etag: libraryEtag(kind, version, titles) };
}

/**
 * The library ETag: a hash over the version and the ordered (name, entry hash)
 * pairs, which is everything the body is made of. Weak, because the same tag
 * names the identity and the gzip bytes.
 *
 * @param {string} kind
 * @param {number} version
 * @param {Array<{name: string, hash: string}>} titles
 * @returns {string}
 */
export function libraryEtag(kind, version, titles) {
  const hash = createHash('sha1');
  hash.update(`media-list:${kind}\nversion:${JSON.stringify(version)}\n`);
  for (const { name, hash: entryHash } of titles) {
    hash.update(`${JSON.stringify(name)}:${entryHash}\n`);
  }
  return `W/"${kind}-${hash.digest('hex')}"`;
}

/**
 * Whether an If-None-Match header matches `etag`: weak comparison (a `W/` on
 * either side is ignored), any tag in a comma-separated list, or `*`.
 *
 * @param {string|undefined} header
 * @param {string} etag
 * @returns {boolean}
 */
export function ifNoneMatchMatches(header, etag) {
  if (typeof header !== 'string' || !etag) return false;
  const opaque = (tag) => (tag.startsWith('W/') ? tag.slice(2) : tag);
  const ours = opaque(etag);
  // Quoted tags may hold commas, so match tags rather than split on commas.
  const tags = header.match(/(?:W\/)?"[^"]*"|\*/g) ?? [];
  return tags.some((tag) => tag === '*' || opaque(tag) === ours);
}

/**
 * The autoCaptions settings as far as the stubs see them: none (off, unset or
 * unreadable — addCaptionStubs injects nothing in all three), or the enabled
 * languages in their configured order (the order the stubs are added in).
 *
 * @param {Object|null|undefined} config - app_config.settings autoCaptions value
 * @returns {string}
 */
export function autoCaptionsContextKey(config) {
  if (!config || !config.enabled || !Array.isArray(config.languages)) return 'stubs:none';
  return `stubs:${JSON.stringify(config.languages)}`;
}

/**
 * One route's cached body.
 */
export class MediaPayloadCache {
  #kind;
  #version;
  #builder;
  #loadRows;
  #readContext;
  #maxAgeMs;
  #now;
  #logger;
  #entry = null;
  #inflight = null;
  #generation = 0;

  /**
   * @param {Object} options
   * @param {string} options.kind - 'tv' | 'movies'
   * @param {number} options.version - TV_LIST_VERSION / MOVIE_LIST_VERSION
   * @param {(row: Object) => Object} options.builder - buildTvPayloadEntry / buildMoviePayloadEntry
   * @param {() => Promise<Array<Object>>} options.loadRows - The rows, in name
   *   order, with the caption stubs already injected
   * @param {() => Promise<string>} [options.readContext] - The current
   *   autoCaptions context key; must not throw
   * @param {number} [options.maxAgeMs]
   * @param {() => number} [options.now]
   * @param {Object} [options.logger]
   */
  constructor({
    kind,
    version,
    builder,
    loadRows,
    readContext = async () => '',
    maxAgeMs = PAYLOAD_CACHE_MAX_AGE_MS,
    now = Date.now,
    logger = null,
  }) {
    this.#kind = kind;
    this.#version = version;
    this.#builder = builder;
    this.#loadRows = loadRows;
    this.#readContext = readContext;
    this.#maxAgeMs = maxAgeMs;
    this.#now = now;
    this.#logger = logger;
  }

  get kind() {
    return this.#kind;
  }

  /**
   * The current body, or null when there is none, it was invalidated, or it is
   * past the backstop age. Synchronous: this is the whole cost of a 304.
   */
  peek() {
    const entry = this.#entry;
    if (!entry) return null;
    if (this.#now() - entry.builtAt >= this.#maxAgeMs) return null;
    return entry;
  }

  /**
   * The current body, building it when there is none. Concurrent callers share
   * one build. A build that an invalidation overtook still answers the requests
   * that were waiting for it, but is not kept.
   */
  get() {
    const current = this.peek();
    if (current) return Promise.resolve(current);
    if (this.#inflight && this.#inflight.generation === this.#generation) {
      return this.#inflight.promise;
    }

    const generation = this.#generation;
    const promise = this.#build(generation).finally(() => {
      if (this.#inflight?.promise === promise) this.#inflight = null;
    });
    this.#inflight = { generation, promise };
    return promise;
  }

  /**
   * Drop the body; the next request builds a new one.
   * @param {string} reason - For the log
   */
  invalidate(reason) {
    this.#generation += 1;
    this.#entry = null;
    this.#logger?.debug?.(`/media/${this.#kind} payload cache invalidated (${reason})`);
  }

  /**
   * Re-read the autoCaptions settings and drop the body if it was built under
   * different ones.
   *
   * @returns {Promise<boolean>} whether it was dropped
   */
  async checkContext() {
    const entry = this.#entry;
    if (!entry) return false;
    const current = await this.#readContext();
    if (this.#entry !== entry || current === entry.contextKey) return false;
    this.invalidate('autoCaptions settings changed');
    return true;
  }

  async #build(generation) {
    const started = performance.now();
    // Read before the rows: the stubs injected while loading them come from
    // the same settings cache, which only moves forward. A change landing
    // mid-build is caught by the next checkContext.
    const contextKey = await this.#readContext();
    const rows = await this.#loadRows();
    const { body, titles, etag } = await serializeKeyedList({
      kind: this.#kind,
      rows,
      builder: this.#builder,
      version: this.#version,
    });
    const gzipBody = await gzip(body);

    const entry = {
      etag,
      body,
      gzipBody,
      titles,
      contextKey,
      builtAt: this.#now(),
      buildMs: Math.round(performance.now() - started),
    };
    if (generation === this.#generation) this.#entry = entry;

    this.#logger?.info?.(
      `/media/${this.#kind} payload built: ${titles.length} titles, ` +
        `${(body.length / 1048576).toFixed(1)} MB (${(gzipBody.length / 1048576).toFixed(1)} MB gzip) ` +
        `in ${entry.buildMs} ms`
    );
    return entry;
  }
}

/**
 * Poll the autoCaptions settings and drop every cache built under other ones.
 *
 * @param {MediaPayloadCache[]} caches
 * @param {Object} [options]
 * @param {number} [options.intervalMs]
 * @param {Object} [options.logger]
 * @returns {() => void} stops the polling
 */
export function watchPayloadContext(caches, { intervalMs = PAYLOAD_CONTEXT_POLL_MS, logger = null } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      for (const cache of caches) {
        if (await cache.checkContext()) {
          logger?.info?.(`/media/${cache.kind} payload rebuilt on next request: autoCaptions settings changed`);
        }
      }
    } catch (error) {
      logger?.error?.(`Payload context check failed: ${error?.message ?? error}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * The `compression` filter for the app: everything the default filter
 * compresses, except a cached media list, which carries its own encoding.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean}
 */
export function compressionFilter(req, res) {
  if (res[PRECOMPRESSED]) return false;
  return compression.filter(req, res);
}

/**
 * The GET handler for one cached list route. Mount it after the auth
 * middleware.
 *
 * @param {MediaPayloadCache} cache
 * @param {Object} options
 * @param {Object} options.logger
 * @param {string} options.errorLabel - Log prefix for a failed build
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<void>}
 */
export function createMediaListHandler(cache, { logger, errorLabel }) {
  return async function mediaListHandler(req, res) {
    res[PRECOMPRESSED] = true;

    let entry = cache.peek();
    if (!entry) {
      try {
        entry = await cache.get();
      } catch (error) {
        logger.error(`${errorLabel}: ${error}`);
        res.status(500).send('Internal server error');
        return;
      }
    }

    res.setHeader('ETag', entry.etag);
    res.vary('Accept-Encoding');

    // Before anything else, and regardless of the request's Cache-Control:
    // a client that sends a tag it got from us wants to know if it is current.
    if (ifNoneMatchMatches(req.headers['if-none-match'], entry.etag)) {
      res.status(304).end();
      return;
    }

    const useGzip = req.acceptsEncodings('gzip') === 'gzip';
    const body = useGzip ? entry.gzipBody : entry.body;
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (useGzip) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', body.length);
    res.end(body);
  };
}
