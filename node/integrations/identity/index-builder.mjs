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
 * Each provider's list is also fingerprinted as it arrives, over exactly the
 * fields a reconcile can act on: (path, tmdbId, hasFile). The service compares
 * the combined fingerprint between runs so a quiet minute costs the pulls and
 * nothing else — no config reads, no writes, no report rebuild.
 */

import { createHash } from 'crypto';

/**
 * Stable hash of what a reconcile would see, plus `released`, which flips
 * once per title on release day and changes what a provider-only row means.
 * Fields outside the tuple (monitored, arrStatus, quality profile, title
 * casing, …) deliberately do not move it.
 * @param {import('./provider.mjs').IdentityClaim[]} claims
 * @returns {string}
 */
export function fingerprintClaims(claims) {
  const lines = claims
    .map((c) => `${c.providerPath ?? c.libraryRelativePath}\t${c.tmdbId}\t${c.hasFile}\t${c.released ?? null}`)
    .sort();
  return createHash('sha1').update(lines.join('\n')).digest('hex');
}

let buildCounter = 0;

export class IdentityIndex {
  constructor() {
    /** Unique per build; makes a failed provider's fingerprint marker unstable. */
    this.nonce = ++buildCounter;
    /** @type {Map<string, import('./provider.mjs').IdentityClaim>} */
    this.byPath = new Map();
    /** @type {Array<{libraryRelativePath: string, kept: Object, dropped: Object}>} */
    this.providerConflicts = [];
    /** @type {Array<{name: string, mediaTypes: string[], ok: boolean, claims: number, durationMs: number, fingerprint: string|null, error?: string, lastFetch?: Object}>} */
    this.providers = [];
    this.builtAt = null;
    this.durationMs = 0;
  }

  get size() {
    return this.byPath.size;
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

  has(libraryRelativePath) {
    return this.byPath.has(libraryRelativePath);
  }

  /** @param {'movie'|'tv'} mediaType */
  claimsFor(mediaType) {
    return [...this.byPath.values()].filter((claim) => claim.mediaType === mediaType);
  }

  entries() {
    return this.byPath.entries();
  }

  /**
   * Merge one claim, honouring first-provider-wins.
   * @param {import('./provider.mjs').IdentityClaim} claim
   * @returns {'added'|'agreed'|'conflict'}
   */
  add(claim) {
    const existing = this.byPath.get(claim.libraryRelativePath);
    if (!existing) {
      this.byPath.set(claim.libraryRelativePath, claim);
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

  summary() {
    return {
      builtAt: this.builtAt,
      durationMs: this.durationMs,
      size: this.size,
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
 * @returns {Promise<IdentityIndex>}
 */
export async function buildIdentityIndex(providers, { logger = null } = {}) {
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

  results.forEach((result, i) => {
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
        durationMs: result.durationMs,
        fingerprint: null,
        error: result.error,
        lastFetch: provider.lastFetch,
      });
      logger?.warn(`identity: provider '${provider.name}' failed this tick and contributes nothing: ${result.error}`);
      return;
    }
    const { claims, durationMs, at } = result;
    let conflicts = 0;
    for (const claim of claims) {
      if (index.add(claim) === 'conflict') conflicts++;
    }
    const fingerprint = fingerprintClaims(claims);
    // Keep whatever the provider recorded about its own fetch (item counts,
    // unmapped, …) unless it is a stale failure record; stamp the essentials.
    const own = provider.lastFetch && provider.lastFetch.ok !== false ? provider.lastFetch : {};
    provider.lastFetch = { ...own, ok: true, at, durationMs, claims: claims.length, fingerprint };
    index.providers.push({
      name: provider.name,
      mediaTypes: provider.mediaTypes,
      ok: true,
      claims: claims.length,
      durationMs,
      fingerprint,
      lastFetch: provider.lastFetch,
    });
    if (conflicts > 0) {
      logger?.warn(`identity: provider '${provider.name}' disagreed with an earlier provider on ${conflicts} folder(s)`);
    }
  });

  index.builtAt = new Date(started).toISOString();
  index.durationMs = Date.now() - started;
  return index;
}
