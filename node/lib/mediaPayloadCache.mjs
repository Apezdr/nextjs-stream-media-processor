// lib/mediaPayloadCache.mjs
//
// The TV and movie libraries, serialized once per change. The frontend sync
// reads them on every tick (every 3 minutes, from every frontend that reads
// this server) through GET /media/<kind>/manifest and POST
// /media/<kind>/entries (lib/mediaManifest.mjs), which are cut from this body.
// The TV body alone is tens of megabytes, and building it reads every row and
// injects the caption stubs, so it is built only when what it is made of
// changes. (The whole-library GET /media/tv and /media/movies that this cache
// was first built for were removed in P4.)
//
// So each kind keeps its body, built once per change:
//
//   - the body bytes;
//   - per title, where its serialized entry sits in the body and the hash of
//     that entry: the manifest is made of these, and single entries are cut
//     from the body by them;
//   - the autoCaptions settings it was built under, because the caption stubs
//     are injected at build time from those settings, not from the rows.
//
// A body is dropped only when what it was built from changed:
//
//   - the rows. The writers of each table count the writes that changed a row
//     (getMediaTableGeneration in sqliteDatabase.mjs), and a body keeps the
//     count its build started at. The end of a scan tick and POST /media/scan
//     drop a body whose count moved since (clearPayloadsAfterScan), and keep it
//     otherwise, so after a tick that changed nothing the next conditional
//     manifest request is a 304 straight away. A scan that failed drops both
//     bodies whatever the counts say. A write made anywhere else is seen by
//     the next of these clear points.
//   - the autoCaptions settings (they live in Mongo, written by the frontend;
//     watchPayloadContext polls them).
//
// Nothing else goes into a body: the rows are read from the one table, the
// caption stubs come from the rows and the settings, and everything else the
// build reads (the language map, the track URL prefix from the env, the list
// versions) is fixed for the life of the process. A body older than
// PAYLOAD_CACHE_MAX_AGE_MS is rebuilt on the next request whatever happened,
// as a backstop for any change nothing told us about.
//
// The manifest and entries handlers send their own encoding (a cached gzip
// copy of the manifest, a gzip stream of the entries), so the compression
// middleware must skip them (compressionFilter, markPrecompressed).

import { createHash } from 'crypto';
import compression from 'compression';

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
 * Serialize a keyed list — `{ <name>: entry, ..., "version": v }` — from rows
 * already in their final order.
 *
 * The body parses to `{ ...buildPayloadMap(rows, builder), version }`: the same
 * entries, each serialized by JSON.stringify, and `version` last. Only the
 * byte order of integer-like names can differ (an object literal lists those
 * first), and JSON.parse puts them first again.
 *
 * @param {Object} params
 * @param {Array<Object>} params.rows - Rows with a `name`, in body order
 * @param {(row: Object) => Object} params.builder - Row to wire entry
 * @param {number} params.version - The list version appended as `version`
 * @param {(entry: Object, row: Object) => *} [params.describe] - Optional: what
 *   to keep about each built entry besides its bytes (the manifest's season and
 *   episode keys; lib/mediaManifest.mjs). Kept as `titles[i].keys`. A describe
 *   that throws leaves `keys` unset and records `describeError` instead: it
 *   can fail the manifest, never the body.
 * @returns {Promise<{body: Buffer, titles: Array<{name: string, hash: string, start: number, end: number, keys?: *, describeError?: string}>}>}
 *   `titles[i]` is the i-th entry: `body.subarray(start, end)` is its JSON and
 *   `hash` is the SHA-1 of those bytes.
 */
export async function serializeKeyedList({ rows, builder, version, describe = null }) {
  const parts = [Buffer.from('{')];
  const titles = [];
  let offset = 1;
  let sliceStart = performance.now();

  for (const row of rows) {
    const name = String(row.name);
    const entry = builder(row);
    const entryBytes = Buffer.from(JSON.stringify(entry), 'utf8');
    const prefix = Buffer.from(`${titles.length ? ',' : ''}${JSON.stringify(name)}:`, 'utf8');
    const start = offset + prefix.length;
    const end = start + entryBytes.length;
    parts.push(prefix, entryBytes);
    const title = { name, hash: sha1Hex(entryBytes), start, end };
    if (describe) {
      try {
        title.keys = describe(entry, row);
      } catch (error) {
        title.describeError = String(error?.message ?? error);
      }
    }
    titles.push(title);
    offset = end;

    if (performance.now() - sliceStart >= SERIALIZE_SLICE_MS) {
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
  }

  parts.push(Buffer.from(`${titles.length ? ',' : ''}"version":${JSON.stringify(version)}}`, 'utf8'));
  const body = Buffer.concat(parts);

  return { body, titles };
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
 * One kind's cached body.
 */
export class MediaPayloadCache {
  #kind;
  #version;
  #builder;
  #describe;
  #loadRows;
  #readContext;
  #dataGeneration;
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
   * @param {(entry: Object, row: Object) => *} [options.describe] - Kept per
   *   title as `keys` (see serializeKeyedList); the TV cache passes
   *   tvManifestKeys from lib/mediaManifest.mjs
   * @param {() => Promise<Array<Object>>} options.loadRows - The rows, in name
   *   order, with the caption stubs already injected
   * @param {() => Promise<string>} [options.readContext] - The current
   *   autoCaptions context key; must not throw
   * @param {() => number} [options.dataGeneration] - The generation of the
   *   rows loadRows reads (getMediaTableGeneration of its table). Without it,
   *   invalidateIfDataChanged always drops the body.
   * @param {number} [options.maxAgeMs]
   * @param {() => number} [options.now]
   * @param {Object} [options.logger]
   */
  constructor({
    kind,
    version,
    builder,
    describe = null,
    loadRows,
    readContext = async () => '',
    dataGeneration = null,
    maxAgeMs = PAYLOAD_CACHE_MAX_AGE_MS,
    now = Date.now,
    logger = null,
  }) {
    this.#kind = kind;
    this.#version = version;
    this.#builder = builder;
    this.#describe = describe;
    this.#loadRows = loadRows;
    this.#readContext = readContext;
    this.#dataGeneration = dataGeneration;
    this.#maxAgeMs = maxAgeMs;
    this.#now = now;
    this.#logger = logger;
  }

  get kind() {
    return this.#kind;
  }

  /** The list version the body ends with (TV_LIST_VERSION / MOVIE_LIST_VERSION). */
  get version() {
    return this.#version;
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
   *
   * Only the HTTP manifest and entries handlers may call this
   * (tests/unit/payload-cache-callers.test.mjs): a build can wait for a
   * MEDIA_SCAN task, so a task holding the scan group that joined a request's
   * build would wait on a scan queued behind itself.
   */
  get() {
    const current = this.peek();
    if (current) return Promise.resolve(current);
    if (this.#inflight && this.#inflight.generation === this.#generation) {
      return this.#inflight.promise;
    }

    const generation = this.#generation;
    // Read before the build reads any row: a write that lands after this is
    // newer than the body, whether or not the build happened to see it.
    const dataGeneration = this.#readDataGeneration();
    const promise = this.#build(generation, dataGeneration).finally(() => {
      if (this.#inflight?.promise === promise) this.#inflight = null;
    });
    this.#inflight = { generation, dataGeneration, promise };
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
   * Drop the body only if its rows changed: the data generation moved since its
   * build began. A build still running is judged the same way, so one that
   * began before a write is not kept. Without a data generation to compare
   * (none given, or it could not be read), the body is dropped.
   *
   * @param {string} reason - For the log
   * @returns {boolean} whether it was dropped
   */
  invalidateIfDataChanged(reason) {
    const current = this.#readDataGeneration();
    const inflight = this.#inflight?.generation === this.#generation ? this.#inflight : null;
    const outdated = (built) => Boolean(built) && built.dataGeneration !== current;
    if (current === null || outdated(this.#entry) || outdated(inflight)) {
      this.invalidate(reason);
      return true;
    }
    this.#logger?.debug?.(`/media/${this.#kind} payload cache kept (${reason}): its rows did not change`);
    return false;
  }

  /** The current data generation, or null when there is none to read. */
  #readDataGeneration() {
    if (!this.#dataGeneration) return null;
    try {
      const value = this.#dataGeneration();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
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

  async #build(generation, dataGeneration) {
    const started = performance.now();
    // Read before the rows: the stubs injected while loading them come from
    // the same settings cache, which only moves forward. A change landing
    // mid-build is caught by the next checkContext.
    const contextKey = await this.#readContext();
    const rows = await this.#loadRows();
    const { body, titles } = await serializeKeyedList({
      rows,
      builder: this.#builder,
      version: this.#version,
      describe: this.#describe,
    });

    const entry = {
      body,
      titles,
      contextKey,
      dataGeneration,
      builtAt: this.#now(),
      buildMs: Math.round(performance.now() - started),
    };
    if (generation === this.#generation) this.#entry = entry;

    this.#logger?.info?.(
      `/media/${this.#kind} payload built: ${titles.length} titles, ` +
        `${(body.length / 1048576).toFixed(1)} MB in ${entry.buildMs} ms`
    );
    return entry;
  }
}

/**
 * The clear point after a scan: drop each body whose rows changed, and keep
 * the others. When the scan failed, drop every body whatever the generations
 * say: it may have stopped anywhere, and dropping is the conservative choice.
 *
 * @param {MediaPayloadCache[]} caches
 * @param {Object} options
 * @param {string} options.reason - For the log
 * @param {boolean} [options.failed] - The scan threw, or stopped on an error
 * @returns {string[]} the kinds whose body was dropped
 */
export function clearPayloadsAfterScan(caches, { reason, failed = false }) {
  const dropped = [];
  for (const cache of caches) {
    if (failed) {
      cache.invalidate(`${reason}, failed`);
      dropped.push(cache.kind);
    } else if (cache.invalidateIfDataChanged(reason)) {
      dropped.push(cache.kind);
    }
  }
  return dropped;
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
 * compresses, except a response marked with markPrecompressed (the media
 * manifests and entries), which carries its own encoding.
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
 * Tell compressionFilter to leave this response alone: the handler sends its
 * own encoding (a cached gzip copy, or its own gzip stream).
 *
 * @param {import('express').Response} res
 */
export function markPrecompressed(res) {
  res[PRECOMPRESSED] = true;
}
