// lib/mediaPayload.mjs
//
// The shape /media/movies and /media/tv put on the wire.
//
// Extracted from the route handlers so it is reachable from a test. Every
// payload defect this pivot produced was an EMISSION bug — the scanner computed
// the right value and something between the row and the response dropped it
// (a reader's allowlist, a hash's field list, a reshape). Unit tests all passed
// throughout, because they tested computation. Whatever builds the response has
// to be callable without an HTTP server, or that class of bug stays invisible.

/**
 * The published identity object for a movie or show row.
 *
 * `firstSeen` is when this folder first entered the library, read back from the
 * .mediaid.json sidecar — NOT a file mtime. Consumers rank "recently added" on
 * it precisely because mtime lies in both directions: a quality upgrade bumps
 * it, a download with a preserved mtime buries it. It is null when the sidecar
 * could not be written, never a per-pass timestamp (it is folded into the hash).
 *
 * Shared by both builders so the movie and show shapes cannot drift apart.
 *
 * @param {{media_id?: string|null, first_seen?: string|null}} row
 * @returns {{id: string, scheme: 'mid', firstSeen: string|null}|null}
 */
export function buildMediaIdentity(row) {
  if (!row?.media_id) return null;
  return { id: row.media_id, scheme: 'mid', firstSeen: row.first_seen ?? null };
}

/**
 * One entry of the `/media/movies` response, keyed by movie name.
 *
 * @param {Object} movie - A row as returned by getMovies()
 * @returns {Object}
 */
export function buildMoviePayloadEntry(movie) {
  return {
    _id: movie._id,
    // Stable content identity — what watch history joins on. Distinct from
    // `_id`, which is a mediainfo header hash: per FILE, so it varies by
    // container and rotates on re-encode. See utils/mediaIdentity.mjs.
    //
    // NOTE: getMovies/getMovieById/getMovieByName reshape rows into an explicit
    // allowlist. If media_id (or first_seen) is ever dropped from that list,
    // this silently emits null forever — which is exactly what happened once
    // already.
    mediaIdentity: buildMediaIdentity(movie),
    fileNames: movie.fileNames,
    length: movie.lengths,
    dimensions: movie.dimensions,
    urls: movie.urls,
    hdr: movie.hdr,
    mediaQuality: movie.mediaQuality,
    additional_metadata: movie.additional_metadata,
    backdropFocal: movie.backdropFocal ?? null,
    backdropFocalSuggested: movie.backdropFocalSuggested ?? null,
  };
}

/**
 * One entry of the `/media/tv` response, keyed by show name.
 *
 * Episode-level fields (mediaIdentity, sources, jitEligible, jitUrl) ride
 * inside the `seasons` blob and pass through untouched — which is why TV was
 * unaffected by the movie allowlist bug.
 *
 * @param {Object} show - A row as returned by getTVShows()
 * @returns {Object}
 */
export function buildTvPayloadEntry(show) {
  return {
    // Show-level identity. Episode ids already derive from it, but the show's
    // own id and first-seen date were never on the wire. Same allowlist trap as
    // movies: getTVShows/getTVShowById/getTVShowByName must carry media_id and
    // first_seen or this is a permanent null.
    mediaIdentity: buildMediaIdentity(show),
    metadata: show.metadata_path,
    poster: show.poster,
    posterBlurhash: show.posterBlurhash,
    logo: show.logo,
    logoBlurhash: show.logoBlurhash,
    backdrop: show.backdrop,
    backdropBlurhash: show.backdropBlurhash,
    seasons: show.seasons,
    backdropFocal: show.backdropFocal ?? null,
    backdropFocalSuggested: show.backdropFocalSuggested ?? null,
  };
}

/**
 * Build the full keyed map for a list response.
 *
 * @param {Array<Object>} rows
 * @param {(row: Object) => Object} builder
 * @returns {Object}
 */
export function buildPayloadMap(rows, builder) {
  return rows.reduce((acc, row) => {
    acc[row.name] = builder(row);
    return acc;
  }, {});
}
