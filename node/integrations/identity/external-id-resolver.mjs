/**
 * Turn a claim's external ids into a TMDB id.
 *
 * Sonarr's metadata comes from TheTVDB and its TVDB-to-TMDB mapping is
 * missing for some new shows (production, 2026-09-22: The Wayfinders had
 * tvdbId 470313, imdbId tt29712397, tmdbId 0). A provider still emits such a
 * title as a claim, with `tmdbId: null` and its `externalIds`; this resolver
 * asks TMDB's /find endpoint — an exact lookup, not a name search — and the
 * index builder promotes the claim to an ordinary one on a hit.
 *
 * Order: IMDb first (unambiguous across types), then TVDB for tv. The TMDB
 * client is imported lazily so callers that never see an unidentified claim
 * (and unit tests) do not pull in the SQLite-backed cache.
 */

const ATTEMPT_ORDER = Object.freeze([
  { source: 'imdb', types: ['movie', 'tv'] },
  { source: 'tvdb', types: ['tv'] },
]);

/**
 * @param {Object} [options]
 * @param {Object} [options.logger]
 * @param {Function} [options.find] injectable `(source, externalId, type) => Promise<number|null>`; default is utils/tmdb.mjs findTmdbIdByExternalId
 * @returns {(claim: import('./provider.mjs').IdentityClaim) => Promise<{tmdbId: number, via: string}|null>}
 */
export function createExternalIdResolver({ logger = null, find = null } = {}) {
  let findImpl = find;

  async function loadFind() {
    if (!findImpl) {
      const tmdb = await import('../../utils/tmdb.mjs');
      findImpl = tmdb.findTmdbIdByExternalId;
    }
    return findImpl;
  }

  return async function resolveExternalId(claim) {
    const ids = claim?.externalIds ?? {};
    for (const { source, types } of ATTEMPT_ORDER) {
      const value = ids[source];
      if (!value || !types.includes(claim.mediaType)) continue;
      try {
        const findFn = await loadFind();
        const tmdbId = await findFn(source, value, claim.mediaType);
        if (tmdbId) return { tmdbId, via: source };
      } catch (error) {
        logger?.warn(
          `identity: TMDB find by ${source} ${value} failed for ${claim.libraryRelativePath}: ${error.message}`
        );
      }
    }
    return null;
  };
}
