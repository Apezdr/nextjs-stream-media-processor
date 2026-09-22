/**
 * Shared base for the *arr family (Radarr, Sonarr, and any clone with the
 * same v3 API shape: X-Api-Key auth, a list endpoint returning items with
 * `path`, `tmdbId`, `year`, `title`, and a Webhook connection type whose
 * payload carries `eventType` plus a subject object).
 *
 * Everything provider-specific is a handful of overrides on the subclass:
 * which endpoint lists items, which key the webhook subject lives under, how
 * to read "has a file", and the event-type names. See radarr.mjs / sonarr.mjs.
 *
 * Path mapping. The arr reports paths in ITS namespace (`/processed_movies/X`
 * inside its container). The processor addresses folders as `movies/X`. With
 * no root map configured, the basename of the arr path is the folder and the
 * subclass's default library root is the root — the standard topology. A root
 * map (`<PREFIX>_ROOT_MAP=/processed_movies=movies;/anime=movies`) handles arr
 * instances whose root folders do not all map onto one library root; items
 * under an unmapped root are skipped and counted, never guessed.
 */

import { IdentityProvider, EVENT_KINDS, LIBRARY_ROOTS, normalizeLibraryRelativePath } from '../provider.mjs';

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Parse `<PREFIX>_ROOT_MAP`: `providerRoot=libraryRoot` pairs separated by
 * `;` or `,`. Library roots must be one of LIBRARY_ROOTS' values.
 * @param {string|undefined} raw
 * @returns {Array<{providerRoot: string, libraryRoot: string}>} longest providerRoot first
 */
export function parseRootMap(raw) {
  if (!raw || !String(raw).trim()) return [];
  const validRoots = new Set(Object.values(LIBRARY_ROOTS));
  const entries = [];
  for (const pair of String(raw).split(/[;,]/)) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`Root map entry must be <providerRoot>=<libraryRoot>: '${trimmed}'`);
    const providerRoot = normalizeArrPath(trimmed.slice(0, eq));
    const libraryRoot = trimmed.slice(eq + 1).trim().replace(/^\/+|\/+$/g, '');
    if (!validRoots.has(libraryRoot)) {
      throw new Error(`Root map library root must be one of ${[...validRoots].join(', ')}: '${libraryRoot}'`);
    }
    entries.push({ providerRoot, libraryRoot });
  }
  // Longest prefix wins when roots nest.
  return entries.sort((a, b) => b.providerRoot.length - a.providerRoot.length);
}

/** Forward slashes, no trailing slash, keep a leading slash if present. */
export function normalizeArrPath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/');
  if (s === '/') return s;
  return s.replace(/\/+$/, '');
}

/**
 * Read the standard *arr env block for a prefix (e.g. 'RADARR').
 * @param {Object} env
 * @param {string} prefix
 * @returns {{baseUrl: string, apiKey: string, rootMap: Array, timeoutMs: number}|null} null when unset
 */
export function readArrEnv(env, prefix) {
  const url = (env[`${prefix}_URL`] ?? '').trim();
  const apiKey = (env[`${prefix}_API_KEY`] ?? '').trim();
  if (!url && !apiKey) return null;
  if (!url || !apiKey) {
    throw new Error(`${prefix}_URL and ${prefix}_API_KEY must both be set to enable the ${prefix.toLowerCase()} identity provider`);
  }
  let baseUrl;
  try {
    baseUrl = new URL(url).toString().replace(/\/+$/, '');
  } catch {
    throw new Error(`${prefix}_URL is not a valid URL: '${url}'`);
  }
  const timeoutRaw = env[`${prefix}_TIMEOUT_MS`];
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${prefix}_TIMEOUT_MS must be a positive integer: '${timeoutRaw}'`);
  }
  return { baseUrl, apiKey, rootMap: parseRootMap(env[`${prefix}_ROOT_MAP`]), timeoutMs };
}

/** Radarr and Sonarr share these event-type names. Subclasses add their own. */
const COMMON_EVENT_KINDS = Object.freeze({
  Test: EVENT_KINDS.TEST,
  Download: EVENT_KINDS.IMPORTED, // becomes UPGRADED when isUpgrade is set
  Rename: EVENT_KINDS.RENAMED,
  Grab: EVENT_KINDS.IGNORED,
  Health: EVENT_KINDS.IGNORED,
  HealthRestored: EVENT_KINDS.IGNORED,
  ApplicationUpdate: EVENT_KINDS.IGNORED,
  ManualInteractionRequired: EVENT_KINDS.IGNORED,
});

export class ArrProvider extends IdentityProvider {
  /**
   * @param {Object} options
   * @param {string} options.name
   * @param {'movie'|'tv'} options.mediaType
   * @param {string} options.baseUrl
   * @param {string} options.apiKey
   * @param {Array<{providerRoot: string, libraryRoot: string}>} [options.rootMap]
   * @param {number} [options.timeoutMs]
   * @param {Function} [options.fetchImpl] injectable fetch for tests
   * @param {Object} [options.logger]
   */
  constructor({ name, mediaType, baseUrl, apiKey, rootMap = [], timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = null, logger = null }) {
    super({ name, mediaTypes: [mediaType], logger });
    this.mediaType = mediaType;
    this.baseUrl = baseUrl;
    this.rootMap = rootMap;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    // Non-enumerable so a careless JSON.stringify(provider) never leaks the key.
    Object.defineProperty(this, 'apiKey', { value: apiKey, enumerable: false, writable: false });
  }

  // ---- subclass hooks -----------------------------------------------------

  /** implement — e.g. '/api/v3/movie' */
  get listEndpoint() {
    throw new Error(`${this.name}: listEndpoint not implemented`);
  }

  /** implement — key of the subject object in webhook payloads, e.g. 'movie' */
  get webhookSubjectKey() {
    throw new Error(`${this.name}: webhookSubjectKey not implemented`);
  }

  /** implement — provider-specific event types merged over the common ones */
  get eventKinds() {
    return COMMON_EVENT_KINDS;
  }

  /** implement — the path field on a list item and on a webhook subject */
  itemPath(item) {
    return item?.path ?? null;
  }

  /** implement — whether the item has media on disk, or null when unknowable */
  // eslint-disable-next-line no-unused-vars
  itemHasFile(item) {
    return null;
  }

  /** implement — external ids beyond TMDB, e.g. { imdb, tvdb } */
  itemExternalIds(item) {
    const ids = {};
    if (item?.imdbId) ids.imdb = item.imdbId;
    return ids;
  }

  // ---- HTTP ---------------------------------------------------------------

  /**
   * GET a JSON endpoint with the API key header and a timeout.
   * @param {string} pathname
   * @returns {Promise<any>}
   */
  async request(pathname) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`${this.name}: GET ${pathname} → HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`${this.name}: GET ${pathname} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck() {
    try {
      const status = await this.request('/api/v3/system/status');
      return { ok: true, detail: `${status?.appName ?? this.name} ${status?.version ?? ''}`.trim() };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }

  // ---- path mapping -------------------------------------------------------

  /**
   * Map a provider path onto a library-relative path.
   * @param {string} providerPath
   * @returns {string|null} null when a root map is configured and nothing matches
   */
  mapPath(providerPath) {
    const normalized = normalizeArrPath(providerPath);
    if (!normalized) return null;
    if (this.rootMap.length === 0) {
      const base = normalized.slice(normalized.lastIndexOf('/') + 1);
      return base ? `${LIBRARY_ROOTS[this.mediaType]}/${base}` : null;
    }
    for (const { providerRoot, libraryRoot } of this.rootMap) {
      const prefix = providerRoot.endsWith('/') ? providerRoot : `${providerRoot}/`;
      if (normalized.startsWith(prefix)) {
        const rest = normalizeLibraryRelativePath(normalized.slice(prefix.length));
        return rest ? `${libraryRoot}/${rest}` : null;
      }
    }
    return null;
  }

  // ---- claims -------------------------------------------------------------

  /**
   * Turn one list item (or webhook subject) into a claim.
   * @param {Object} item
   * @returns {IdentityClaim|null} null when the item has no usable id or path
   */
  claimFromItem(item) {
    const tmdbId = Number(item?.tmdbId);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
    const providerPath = this.itemPath(item);
    const libraryRelativePath = providerPath ? this.mapPath(providerPath) : null;
    if (!libraryRelativePath) return null;
    return this.makeClaim({
      mediaType: this.mediaType,
      libraryRelativePath,
      tmdbId,
      year: Number.isInteger(item?.year) ? item.year : null,
      title: item?.title ?? null,
      externalIds: this.itemExternalIds(item),
      hasFile: this.itemHasFile(item),
      providerPath,
    });
  }

  async fetchClaims() {
    const started = Date.now();
    const items = await this.request(this.listEndpoint);
    if (!Array.isArray(items)) {
      throw new Error(`${this.name}: ${this.listEndpoint} did not return an array`);
    }
    const claims = [];
    let unmapped = 0;
    let noId = 0;
    for (const item of items) {
      const claim = this.claimFromItem(item);
      if (claim) {
        claims.push(claim);
      } else if (Number.isInteger(Number(item?.tmdbId)) && Number(item?.tmdbId) > 0) {
        unmapped++;
      } else {
        noId++;
      }
    }
    this.lastFetch = {
      ok: true,
      at: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      items: items.length,
      claims: claims.length,
      unmapped,
      noId,
    };
    if (unmapped > 0 && this.logger) {
      this.logger.warn(`${this.name}: ${unmapped} item(s) under roots not in the root map were skipped`);
    }
    return claims;
  }

  // ---- webhooks -----------------------------------------------------------

  /**
   * Webhook payloads carry the same ids as the list endpoint, so a claim is
   * built from the subject object with no extra request. The subject's path
   * field differs per app (Radarr: movie.folderPath; Sonarr: series.path) —
   * subclasses normalize it in `webhookSubjectPath`.
   */
  // eslint-disable-next-line no-unused-vars
  parseWebhook(body, headers = {}) {
    if (!body || typeof body !== 'object') return [];
    const rawType = body.eventType;
    if (!rawType) return [];
    let kind = this.eventKinds[rawType] ?? EVENT_KINDS.IGNORED;
    if (kind === EVENT_KINDS.IMPORTED && body.isUpgrade === true) kind = EVENT_KINDS.UPGRADED;

    const subject = body[this.webhookSubjectKey];
    let claim = null;
    if (subject && typeof subject === 'object') {
      const path = this.webhookSubjectPath(subject);
      claim = this.claimFromItem({ ...subject, path });
    }
    const details = {};
    if (body.isUpgrade !== undefined) details.isUpgrade = body.isUpgrade === true;
    if (body.deletedFiles) details.deletedFiles = body.deletedFiles.length ?? 0;
    return [this.makeEvent(kind, rawType, claim, details)];
  }

  /** implement when the webhook subject's path field differs from the list item's */
  webhookSubjectPath(subject) {
    return this.itemPath(subject);
  }

  describe() {
    return {
      ...super.describe(),
      baseUrl: this.baseUrl,
      rootMap: this.rootMap,
      timeoutMs: this.timeoutMs,
    };
  }
}
