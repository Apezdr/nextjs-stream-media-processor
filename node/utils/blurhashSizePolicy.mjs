/**
 * Single source of truth for blurhash encode sizes per image kind (B-2b).
 *
 * Three pipelines encode blurhashes and historically each carried its own
 * size-per-kind rules inline; two agreed and one diverged, with nothing
 * making the divergence visible. This module encodes the AS-BUILT policies
 * verbatim — B-2b is deliberately a zero-behavior-change unification: same
 * effective size out of every pipeline, just single-sourced so future edits
 * are explicit policy decisions instead of silent drift.
 *
 * The two policies, and the one deliberate divergence:
 *
 *  - SIDECAR policy (library storage — `.blurhash` files next to media art):
 *    backdrops and episode thumbnails are blurred backgrounds → 'small';
 *    posters and season posters → 'medium'; logos need edge detail → 'large'.
 *    Used by both sidecar writers (`downloadImageWithBlurhash()` keyed on the
 *    imageType option, `getStoredBlurhash()` keyed on filename substring).
 *
 *  - TMDB-PROXY policy (blurhash embedded into cached /api/tmdb/* responses —
 *    browse/search previews, not library storage): **details/collection
 *    posters use 'large' where the sidecar policy uses 'medium'** — a
 *    deliberate, named divergence: these render as primary artwork in
 *    browse/search UI before any library copy exists, so they get the extra
 *    detail; search-result posters go the other way ('small') because search
 *    lists render many tiny previews at once.
 *
 * Changing ANY value here is a policy change with real invalidation costs:
 * sidecars only converge via a BLURHASH_GENERATION_VERSION bump (and that
 * mechanism currently covers movie images only — TV sidecars have no
 * version-regen path), and tmdb_blurhash_cache keys embed the size, so a
 * change orphans every old row in a table with no live eviction. Do not edit
 * casually.
 */

/** Encode sizes understood by blurhashNative (preview px: 16 / 24 / 32). */
export const BLURHASH_SIZE_SMALL = 'small';
export const BLURHASH_SIZE_MEDIUM = 'medium';
export const BLURHASH_SIZE_LARGE = 'large';

/**
 * Sidecar policy, keyed by the downloader's imageType option values.
 * Unknown/absent kinds fall back to 'large' (the historical default).
 */
const SIDECAR_SIZE_BY_IMAGE_TYPE = Object.freeze({
  backdrop: BLURHASH_SIZE_SMALL,
  'episode-thumbnail': BLURHASH_SIZE_SMALL,
  poster: BLURHASH_SIZE_MEDIUM,
  'season-poster': BLURHASH_SIZE_MEDIUM,
  logo: BLURHASH_SIZE_LARGE,
});

/**
 * Sidecar encode size for a downloader imageType ('backdrop', 'poster',
 * 'logo', 'season-poster', 'episode-thumbnail').
 *
 * @param {string} imageType
 * @returns {'small'|'medium'|'large'}
 */
export function sidecarBlurhashSizeForImageType(imageType) {
  return SIDECAR_SIZE_BY_IMAGE_TYPE[imageType] ?? BLURHASH_SIZE_LARGE;
}

/**
 * Sidecar encode size derived from an image file path/name — the lazy
 * scanner-side variant (`getStoredBlurhash()`), which only has the filename.
 * Substring checks in this exact order are load-bearing: 'backdrop' and
 * 'thumbnail' outrank 'poster', which outranks 'logo'; anything else falls
 * back to 'large'. Matches the imageType table above for every conventional
 * filename (poster/show_poster, backdrop/show_backdrop, logo/show_logo,
 * season_poster, `NN - Thumbnail`).
 *
 * @param {string} imagePath
 * @returns {'small'|'medium'|'large'}
 */
export function sidecarBlurhashSizeForFilename(imagePath) {
  const fileName = String(imagePath).toLowerCase();
  if (fileName.includes('backdrop') || fileName.includes('thumbnail')) return BLURHASH_SIZE_SMALL;
  if (fileName.includes('poster')) return BLURHASH_SIZE_MEDIUM;
  if (fileName.includes('logo')) return BLURHASH_SIZE_LARGE;
  return BLURHASH_SIZE_LARGE;
}

/**
 * TMDB-proxy policy: one named constant per response context in
 * `tmdbBlurhash.mjs`. The poster entries are where this policy deliberately
 * diverges from the sidecar policy (see module doc).
 */
export const TMDB_PROXY_BLURHASH_SIZES = Object.freeze({
  /** Main poster on a details/comprehensive response. Divergent: sidecar posters are 'medium'. */
  detailsPoster: BLURHASH_SIZE_LARGE,
  /** Main backdrop on a details/comprehensive response. */
  detailsBackdrop: BLURHASH_SIZE_SMALL,
  /** Main logo on a details/comprehensive response. */
  detailsLogo: BLURHASH_SIZE_LARGE,
  /** Backdrop entries of an /images collection response. */
  imagesBackdropCollection: BLURHASH_SIZE_MEDIUM,
  /** Poster entries of an /images collection response. Divergent (see above). */
  imagesPosterCollection: BLURHASH_SIZE_LARGE,
  /** Logo entries of an /images collection response. */
  imagesLogoCollection: BLURHASH_SIZE_LARGE,
  /** Per-part posters of an enhanced collection response. Divergent (see above). */
  collectionPartPoster: BLURHASH_SIZE_LARGE,
  /** Per-part backdrops of an enhanced collection response. */
  collectionPartBackdrop: BLURHASH_SIZE_SMALL,
  /** Search-result posters — many tiny previews per page. */
  searchResultPoster: BLURHASH_SIZE_SMALL,
});
