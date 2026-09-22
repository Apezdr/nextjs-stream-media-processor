/**
 * Fold every provider's claims into one per-tick index keyed by
 * library-relative path.
 *
 * Providers are queried in parallel; a provider that throws is recorded and
 * contributes nothing for this tick — the scan must never wait on, or fail
 * because of, an external manager. When two providers claim the same folder
 * with different ids the earlier provider (registry order) wins and the
 * disagreement is kept for the report.
 *
 * A claim may arrive UNIDENTIFIED (`tmdbId: null`, external ids only —
 * Sonarr with no TVDB→TMDB mapping). The builder offers it to the external
 * id resolver (TMDB /find, an exact lookup); on a hit the claim becomes an
 * ordinary one, otherwise it is kept apart in `unidentifiedByPath` so the
 * reconciler can report the folder as managed-but-unidentified rather than
 * unmanaged.
 *
 * Each provider's list is also fingerprinted as it arrives, over exactly the
 * fields a reconcile can act on. The service compares the combined
 * fingerprint between runs so a quiet minute costs the pulls and nothing
 * else — no config reads, no writes, no report rebuild.
 */

import { createHash } from 'crypto';
import { isIdentified } from './provider.mjs';

function externalIdKey(claim) {
  const ids = claim.externalIds ?? {};
  return Object.keys(ids).sort().map((k) => `${k}=${ids[k]}`).join(',');
}

/**
 * Stable hash of what a reconcile would see, plus `released`, which flips
 * once per title on release day and changes what a provider-only row means.
 * An unidentified claim contributes its external ids where the TMDB id
 * would be, so a resolution appearing changes the fingerprint.
 * Fields outside the tuple (monitored, arrStatus, quality profile, title
 * casing, …) deliberately do not move it.
 * @param {import('./provider.mjs').IdentityClaim[]} claims
 * @returns {string}
 */
export function fingerprintClaims(claims) {
  const lines = claims
    .map((c) => {
      const id = isIdentified(c) ? String(c.tmdbId) : `ext:${externalIdKey(c)}`;
      return `${c.providerPath ?? c.libraryRelativePath}\t${id}\t${c.hasFile}\t${c.released ?? null}`;
    })
    .sort();
  return createHash('sha1').update(lines.join('\n')).digest('hex');
}

let buildCounter = 0;

export class IdentityIndex {
  constructor() {
    /** Unique per build; makes a failed provider's fingerprint marker unstable. */
    this.nonce = ++buildCounter;
    /** @type {Map<string, import('./provider.mjs').IdentityClaim>} identified claims */
    this.byPath = new Map();
    /** @type {Map<string, import('./provider.mjs').IdentityClaim>} claims with external ids only */
    this.unidentifiedByPath = new Map();
    /** @type {Array<{libraryRelativePath: string, kept: Object, dropped: Object}>} */
    this.providerConflicts = [];
    /** @type {Array<{name: string, mediaTypes: string[], ok: boolean, claims: number, unidentified: number, resolved: number, durationMs: number, fingerprint: string|null, error?: string, lastFetch?: Object}>} */
    this.providers = [];
    this.builtAt = null;
    this.durationMs = 0;
  }

  get size() {
    return this.byPath.size;
  }

  get unidentifiedCount() {
    return this.unidentifiedByPath.size;
  }

  /** @returns {boolean} whether any provider returned successfully */
  get hasData() {
    return this.providers.some((p) => p.ok);
  }

  /** @returns {boolean} whether every provider returned successfully */
  get allOk() {
    return this.providers.length > 0 && this.providers.every((p) => p.ok);
  }

  /**
   * Media types at least one successful provider covers. A type with no
   * successful provider is unknown this tick, not unmanaged.
   * @returns {Set<string>}
   */
  get coveredTypes() {
    const types = new Set();
    for (const p of this.providers) {
      if (p.ok) for (const t of p.mediaTypes) types.add(t);
    }
    return types;
  }

  /**
   * One string that moves iff a reconcile could see something different.
   * A failed provider contributes an unstable marker so the next run after a
   * failure never skips.
   * @returns {string}
   */
  get fingerprint() {
    return [...this.providers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `${p.name}=${p.ok ? p.fingerprint : `error:${this.nonce}`}`)
      .join('|');
  }

  get(libraryRelativePath) {
    return this.byPath.get(libraryRelativePath) ?? null;
  }

  /** Identified claim for the path? */
  has(libraryRelativePath) {
    return this.byPath.has(libraryRelativePath);
  }

  /** Any claim at all for the path, identified or not? */
  knows(libraryRelativePath) {
    return this.byPath.has(libraryRelativePath) || this.unidentifiedByPath.has(libraryRelativePath);
  }

  /** @param {'movie'|'tv'} mediaType */
  claimsFor(mediaType) {
    return [...this.byPath.values()].filter((claim) => claim.mediaType === mediaType);
  }

  /** @param {'movie'|'tv'} mediaType */
  unidentifiedFor(mediaType) {
    return [...this.unidentifiedByPath.values()].filter((claim) => claim.mediaType === mediaType);
  }

  entries() {
    return this.byPath.entries();
  }

  /**
   * Merge one identified claim, honouring first-provider-wins.
   * @param {import('./provider.mjs').IdentityClaim} claim
   * @returns {'added'|'agreed'|'conflict'}
   */
  add(claim) {
    const existing = this.byPath.get(claim.libraryRelativePath);
    if (!existing) {
      this.byPath.set(claim.libraryRelativePath, claim);
      // An identified claim beats an earlier unidentified one for the same folder.
      this.unidentifiedByPath.delete(claim.libraryRelativePath);
      return 'added';
    }
    if (existing.tmdbId === claim.tmdbId) return 'agreed';
    this.providerConflicts.push({
      libraryRelativePath: claim.libraryRelativePath,
      kept: { source: existing.source, tmdbId: existing.tmdbId },
      dropped: { source: claim.source, tmdbId: claim.tmdbId },
    });
    return 'conflict';
  }

  /**
   * Keep an unidentified claim, unless the folder already has an identified
   * (or earlier unidentified) claim.
   * @param {import('./provider.mjs').IdentityClaim} claim
   * @returns {'added'|'ignored'}
   */
  addUnidentified(claim) {
    if (this.knows(claim.libraryRelativePath)) return 'ignored';
    this.unidentifiedByPath.set(claim.libraryRelativePath, claim);
    return 'added';
  }

  summary() {
    return {
      builtAt: this.builtAt,
      durationMs: this.durationMs,
      size: this.size,
      unidentified: this.unidentifiedCount,
      allOk: this.allOk,
      providers: this.providers,
      providerConflicts: this.providerConflicts.length,
    };
  }
}

/**
 * @param {import('./provider.mjs').IdentityProvider[]} providers
 * @param {Object} [options]
 * @param {Object} [options.logger]
 * @param {(claim: Object) => Promise<{tmdbId: number, via: string}|null>} [options.resolveExternalId]
 *   fills tmdbId on unidentified claims; null = no resolution attempted
 * @returns {Promise<IdentityIndex>}
 */
export async function buildIdentityIndex(providers, { logger = null, resolveExternalId = null } = {}) {
  const index = new IdentityIndex();
  const started = Date.now();

  const results = await Promise.all(
    providers.map(async (provider) => {
      const t0 = Date.now();
      try {
        const claims = await provider.fetchClaims();
        return { ok: true, claims, at: new Date(t0).toISOString(), durationMs: Date.now() - t0 };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error), at: new Date(t0).toISOString(), durationMs: Date.now() - t0 };
      }
    })
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const provider = providers[i];
    if (!result.ok) {
      // Record the failure where the status endpoint reads provider health,
      // replacing any earlier success so "last fetch" is never stale-good.
      provider.lastFetch = { ok: false, at: result.at, durationMs: result.durationMs, claims: 0, error: result.error };
      index.providers.push({
        name: provider.name,
        mediaTypes: provider.mediaTypes,
        ok: false,
        claims: 0,
        unidentified: 0,
        resolved: 0,
        durationMs: result.durationMs,
        fingerprint: null,
        error: result.error,
        lastFetch: provider.lastFetch,
      });
      logger?.warn(`identity: provider '${provider.name}' failed this tick and contributes nothing: ${result.error}`);
      continue;
    }

    const { claims, durationMs, at } = result;

    // Resolve external-id-only claims before merging or fingerprinting, so
    // a mapping that appears on TMDB's side moves the fingerprint.
    let resolved = 0;
    if (resolveExternalId) {
      for (const claim of claims) {
        if (isIdentified(claim)) continue;
        const hit = await resolveExternalId(claim);
        if (hit && Number.isInteger(hit.tmdbId) && hit.tmdbId > 0) {
          claim.tmdbId = hit.tmdbId;
          claim.resolvedVia = hit.via ?? null;
          resolved++;
          logger?.info(`identity: resolved ${claim.libraryRelativePath} to TMDB ${claim.tmdbId} via ${claim.resolvedVia} (${provider.name})`);
        }
      }
    }

    let conflicts = 0;
    let unidentified = 0;
    for (const claim of claims) {
      if (isIdentified(claim)) {
        if (index.add(claim) === 'conflict') conflicts++;
      } else {
        unidentified++;
        index.addUnidentified(claim);
      }
    }
    const fingerprint = fingerprintClaims(claims);
    // Keep whatever the provider recorded about its own fetch (item counts,
    // unmapped, …) unless it is a stale failure record; stamp the essentials.
    const own = provider.lastFetch && provider.lastFetch.ok !== false ? provider.lastFetch : {};
    provider.lastFetch = { ...own, ok: true, at, durationMs, claims: claims.length, unidentified, resolved, fingerprint };
    index.providers.push({
      name: provider.name,
      mediaTypes: provider.mediaTypes,
      ok: true,
      claims: claims.length,
      unidentified,
      resolved,
      durationMs,
      fingerprint,
      lastFetch: provider.lastFetch,
    });
    if (conflicts > 0) {
      logger?.warn(`identity: provider '${provider.name}' disagreed with an earlier provider on ${conflicts} folder(s)`);
    }
    if (unidentified > 0) {
      logger?.info(`identity: provider '${provider.name}' manages ${unidentified} title(s) with no TMDB id that TMDB could not resolve either`);
    }
  }

  index.builtAt = new Date(started).toISOString();
  index.durationMs = Date.now() - started;
  return index;
}
