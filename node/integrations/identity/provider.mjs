/**
 * The identity-provider contract.
 *
 * An identity provider is any external system that already knows WHICH TMDB
 * entity a library folder is — a media manager (Radarr, Sonarr), a media
 * server (Plex, Jellyfin), a sidecar format (Kodi .nfo), anything. The
 * processor asks each configured provider for its claims once per scan tick,
 * folds them into one index keyed by library-relative folder, and lets the
 * precedence rule in `utils/tmdbConfig.mjs` decide what to do with each one.
 *
 * A provider knows nothing about tmdb.config, the scanner, or precedence. It
 * turns its own API into claims and (optionally) its own webhook payloads into
 * events. That is the whole surface a new integration has to implement:
 *
 *   1. subclass IdentityProvider (or the ArrProvider base for *arr clones)
 *   2. implement `fromEnv`, `fetchClaims`, and optionally `parseWebhook`
 *   3. add the class to PROVIDER_CLASSES in ./registry.mjs
 *
 * Claims are addressed by library-relative path — `movies/<folder>` or
 * `tv/<folder>` — the same string the identity sidecar derives `mid:` ids from
 * (`utils/mediaIdentity.mjs`) and the scanners build their rows around.
 */

/** Library root per media type, matching the scanners' path construction. */
export const LIBRARY_ROOTS = Object.freeze({ movie: 'movies', tv: 'tv' });

export const MEDIA_TYPES = Object.freeze(Object.keys(LIBRARY_ROOTS));

/**
 * What a provider webhook told us happened. Only the kinds in
 * SCAN_TRIGGER_KINDS make the processor scan early; the rest are recorded.
 */
export const EVENT_KINDS = Object.freeze({
  TEST: 'test',            // connection test from the provider UI
  ADDED: 'added',          // title added to the manager (a folder may not exist yet)
  IMPORTED: 'imported',    // a file landed in the library
  UPGRADED: 'upgraded',    // a file replaced a previous one
  RENAMED: 'renamed',      // files or folder renamed
  DELETED: 'deleted',      // the title left the manager (never acted on)
  FILE_DELETED: 'file-deleted',
  IGNORED: 'ignored',      // known payload we deliberately do nothing with
});

export const SCAN_TRIGGER_KINDS = Object.freeze(new Set([
  EVENT_KINDS.ADDED,
  EVENT_KINDS.IMPORTED,
  EVENT_KINDS.UPGRADED,
  EVENT_KINDS.RENAMED,
]));

/**
 * @typedef {Object} IdentityClaim
 * @property {'movie'|'tv'} mediaType
 * @property {string} libraryRelativePath  e.g. 'movies/The Professor' — the join key
 * @property {number|null} tmdbId           null = the provider manages the folder but cannot name the TMDB entity
 *                                           ("unidentified"); externalIds must then be non-empty
 * @property {string|null} resolvedVia      'imdb' | 'tvdb' when the index builder filled tmdbId from externalIds
 * @property {string} source                the provider's `name`
 * @property {number|null} year
 * @property {string|null} title
 * @property {Object<string,string|number>} externalIds  e.g. { imdb: 'tt…', tvdb: 123 }
 * @property {boolean|null} hasFile         whether the provider believes a file exists; null = unknown
 * @property {string|null} providerPath     the path as the provider sees it (diagnostics only)
 * @property {boolean|null} released        the provider considers the title obtainable now; null = cannot say
 * @property {string|null} arrStatus        the provider's own lifecycle word, verbatim (announced, released, continuing, …)
 * @property {boolean|null} monitored       the provider is actively looking for it; null = cannot say
 * @property {{poster: string|null, backdrop: string|null}} art  the provider's remote artwork URLs (never its own local paths); each null when absent
 */

/**
 * @typedef {Object} IdentityEvent
 * @property {string} kind                  one of EVENT_KINDS
 * @property {string} source                the provider's `name`
 * @property {string} rawType               the provider's own event type string
 * @property {IdentityClaim|null} claim     the folder the event is about, when the payload carries enough to say
 * @property {Object} [details]             provider-specific extras (isUpgrade, old/new file, …)
 */

/**
 * Normalize a library-relative path the way the identity sidecar does, so a
 * claim built from a provider's Windows-style or trailing-slash path lands on
 * the same key the scanner uses.
 * @param {string} p
 * @returns {string}
 */
export function normalizeLibraryRelativePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Build a library-relative path from a media type and folder name.
 * @param {'movie'|'tv'} mediaType
 * @param {string} folderName
 * @returns {string}
 */
export function libraryRelativePathFor(mediaType, folderName) {
  const root = LIBRARY_ROOTS[mediaType];
  if (!root) throw new Error(`Unknown media type: ${mediaType}`);
  return `${root}/${normalizeLibraryRelativePath(folderName)}`;
}

/**
 * Only absolute http(s) URLs count as art the frontend can render; anything
 * else (a provider's own /MediaCover path, an empty string) is null.
 * @param {Object|undefined} art
 * @returns {{poster: string|null, backdrop: string|null}}
 */
export function normalizeArt(art) {
  const url = (value) => (typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : null);
  return { poster: url(art?.poster), backdrop: url(art?.backdrop) };
}

/**
 * Whether a claim names a TMDB entity (as opposed to only external ids).
 * @param {IdentityClaim} claim
 * @returns {boolean}
 */
export function isIdentified(claim) {
  return Number.isInteger(claim?.tmdbId) && claim.tmdbId > 0;
}

/**
 * Split a library-relative path into its root and the folder under it.
 * @param {string} libraryRelativePath
 * @returns {{mediaType: 'movie'|'tv', folder: string}|null} null when the root is not a library root
 */
export function splitLibraryRelativePath(libraryRelativePath) {
  const normalized = normalizeLibraryRelativePath(libraryRelativePath);
  const slash = normalized.indexOf('/');
  if (slash <= 0) return null;
  const root = normalized.slice(0, slash);
  const folder = normalized.slice(slash + 1);
  const mediaType = MEDIA_TYPES.find((type) => LIBRARY_ROOTS[type] === root);
  if (!mediaType || !folder) return null;
  return { mediaType, folder };
}

const NAME_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_NAMES = new Set(['manual', 'auto']);

/**
 * Base class. Subclasses override the members marked "implement".
 */
export class IdentityProvider {
  /**
   * @param {Object} options
   * @param {string} options.name          unique token, also written as `tmdb_id_source`
   * @param {Array<'movie'|'tv'>} options.mediaTypes
   * @param {Object} [options.logger]
   */
  constructor({ name, mediaTypes, logger = null }) {
    if (!NAME_TOKEN.test(name)) {
      throw new Error(`Identity provider name must be a lowercase token: ${name}`);
    }
    if (RESERVED_NAMES.has(name)) {
      throw new Error(`Identity provider name '${name}' is reserved`);
    }
    for (const type of mediaTypes) {
      if (!MEDIA_TYPES.includes(type)) throw new Error(`${name}: unknown media type '${type}'`);
    }
    this.name = name;
    this.mediaTypes = Object.freeze([...mediaTypes]);
    this.logger = logger;
    /** Diagnostics from the most recent fetchClaims, for the status endpoint. */
    this.lastFetch = null;
  }

  /**
   * implement — Build an instance from environment variables, or return null
   * when the provider is not configured. Must not throw for "not configured";
   * may throw for "configured wrongly" (the registry reports it and moves on).
   * @param {Object} env
   * @param {Object} [deps] injected dependencies (fetchImpl, logger, …)
   * @returns {IdentityProvider|null}
   */
  // eslint-disable-next-line no-unused-vars
  static fromEnv(env, deps = {}) {
    return null;
  }

  /**
   * implement — Every folder this provider manages, as claims.
   * Throwing is fine: the index builder records the failure and treats the
   * provider as empty for the tick.
   * @returns {Promise<IdentityClaim[]>}
   */
  async fetchClaims() {
    throw new Error(`${this.name}: fetchClaims not implemented`);
  }

  /**
   * optional — Turn a webhook body into events. Return [] for payloads the
   * provider does not understand. Default: no webhook support.
   * @param {Object} body
   * @param {Object} [headers]
   * @returns {IdentityEvent[]}
   */
  // eslint-disable-next-line no-unused-vars
  parseWebhook(body, headers = {}) {
    return [];
  }

  /** @returns {boolean} whether parseWebhook is meaningful for this provider */
  get supportsWebhook() {
    return this.parseWebhook !== IdentityProvider.prototype.parseWebhook;
  }

  /**
   * optional — A cheap reachability probe for the status endpoint.
   * @returns {Promise<{ok: boolean, detail?: string}>}
   */
  async healthCheck() {
    return { ok: true, detail: 'not implemented' };
  }

  /**
   * Helper for subclasses: assemble a claim with every field present.
   * @param {Object} fields
   * @returns {IdentityClaim}
   */
  makeClaim(fields) {
    const tmdbId = Number.isInteger(fields.tmdbId) && fields.tmdbId > 0 ? fields.tmdbId : null;
    const externalIds = fields.externalIds ?? {};
    if (tmdbId === null && Object.keys(externalIds).length === 0) {
      throw new Error(`${this.name}: a claim needs a tmdbId or at least one external id (${fields.libraryRelativePath})`);
    }
    return {
      mediaType: fields.mediaType,
      libraryRelativePath: normalizeLibraryRelativePath(fields.libraryRelativePath),
      tmdbId,
      resolvedVia: null,
      source: this.name,
      year: Number.isInteger(fields.year) ? fields.year : null,
      title: fields.title ?? null,
      externalIds,
      hasFile: typeof fields.hasFile === 'boolean' ? fields.hasFile : null,
      providerPath: fields.providerPath ?? null,
      // Availability is never guessed: a provider that cannot say emits null.
      released: typeof fields.released === 'boolean' ? fields.released : null,
      arrStatus: typeof fields.arrStatus === 'string' && fields.arrStatus ? fields.arrStatus : null,
      monitored: typeof fields.monitored === 'boolean' ? fields.monitored : null,
      art: normalizeArt(fields.art),
    };
  }

  /**
   * Helper for subclasses: assemble an event.
   * @param {string} kind one of EVENT_KINDS
   * @param {string} rawType
   * @param {IdentityClaim|null} claim
   * @param {Object} [details]
   * @returns {IdentityEvent}
   */
  makeEvent(kind, rawType, claim = null, details = {}) {
    return { kind, source: this.name, rawType: String(rawType ?? ''), claim, details };
  }

  /** Redacted description for logs and the status endpoint. Never includes secrets. */
  describe() {
    return { name: this.name, mediaTypes: this.mediaTypes, supportsWebhook: this.supportsWebhook };
  }
}
