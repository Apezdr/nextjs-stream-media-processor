/**
 * Fold every provider's claims into one per-tick index keyed by
 * library-relative path.
 *
 * Providers are queried in parallel; a provider that throws is recorded and
 * contributes nothing for this tick — the scan must never wait on, or fail
 * because of, an external manager. When two providers claim the same folder
 * with different ids the earlier provider (registry order) wins and the
 * disagreement is kept for the report.
 */

export class IdentityIndex {
  constructor() {
    /** @type {Map<string, import('./provider.mjs').IdentityClaim>} */
    this.byPath = new Map();
    /** @type {Array<{libraryRelativePath: string, kept: Object, dropped: Object}>} */
    this.providerConflicts = [];
    /** @type {Array<{name: string, mediaTypes: string[], ok: boolean, claims: number, durationMs: number, error?: string, lastFetch?: Object}>} */
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

  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      const t0 = Date.now();
      const claims = await provider.fetchClaims();
      return { provider, claims, durationMs: Date.now() - t0 };
    })
  );

  results.forEach((result, i) => {
    const provider = providers[i];
    if (result.status === 'rejected') {
      const message = result.reason?.message ?? String(result.reason);
      index.providers.push({
        name: provider.name,
        mediaTypes: provider.mediaTypes,
        ok: false,
        claims: 0,
        durationMs: Date.now() - started,
        error: message,
      });
      logger?.warn(`identity: provider '${provider.name}' failed this tick and contributes nothing: ${message}`);
      return;
    }
    const { claims, durationMs } = result.value;
    let conflicts = 0;
    for (const claim of claims) {
      if (index.add(claim) === 'conflict') conflicts++;
    }
    index.providers.push({
      name: provider.name,
      mediaTypes: provider.mediaTypes,
      ok: true,
      claims: claims.length,
      durationMs,
      lastFetch: provider.lastFetch ?? null,
    });
    if (conflicts > 0) {
      logger?.warn(`identity: provider '${provider.name}' disagreed with an earlier provider on ${conflicts} folder(s)`);
    }
  });

  index.builtAt = new Date(started).toISOString();
  index.durationMs = Date.now() - started;
  return index;
}
