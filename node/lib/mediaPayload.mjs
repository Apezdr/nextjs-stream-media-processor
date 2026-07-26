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
    // allowlist. If media_id is ever dropped from that list, this silently
    // emits null forever — which is exactly what happened once already.
    mediaIdentity: movie.media_id ? { id: movie.media_id, scheme: 'mid' } : null,
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
