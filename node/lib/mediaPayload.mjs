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
//
// THE PROBE FACTS ARE TRIMMED. The scanner stores everything ffprobe reported
// (`additionalMetadata` in the .info sidecar), and the caption stubs and the
// hashes still read all of it. The wire carries only what the frontend sync
// reads, which on the full library is about a fifth of the TV body:
//
//   - a movie's `additional_metadata`: duration, dimensions, width, height and
//     size, the first video track's codec, bitrate and frame_rate, and the
//     first audio track's codec and channels
//     (MovieContentStrategy.extractVideoMetadataFromFileServerData);
//   - an episode's `additionalMetadata`: size only (EpisodeSyncService, and the
//     legacy flat sync's videoInfo). An episode's duration and dimensions come
//     from the season's `lengths` and `dimensions` maps, not from here.
//
// Before keeping a field out, check every reader in the frontend: the sync, and
// anything that reads what the sync stored from it. A field read nowhere is
// still recorded in the sync's fieldAvailability, so dropping it moves each
// title's availability fingerprint once (one full pass per title), and nothing
// else.

const MOVIE_FACT_KEYS = new Set(['duration', 'dimensions', 'width', 'height', 'size', 'video', 'audio']);
const MOVIE_VIDEO_TRACK_KEYS = ['codec', 'bitrate', 'frame_rate'];
const MOVIE_AUDIO_TRACK_KEYS = ['codec', 'channels'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The listed keys the object has, in the listed order. */
function pickKeys(source, keys) {
  const picked = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) picked[key] = source[key];
  }
  return picked;
}

/** A track list cut to its first track, carrying only `keys`. */
function firstTrack(tracks, keys) {
  return tracks.slice(0, 1).map((track) => (isPlainObject(track) ? pickKeys(track, keys) : track));
}

/**
 * A movie's `additional_metadata` as published: the kept facts, in the order
 * the stored object has them. A key the stored object lacks stays absent; a
 * null stays null.
 *
 * @param {Object|null|undefined} meta - The stored additional_metadata
 * @returns {Object|null|undefined}
 */
export function slimMovieAdditionalMetadata(meta) {
  if (!isPlainObject(meta)) return meta;
  const slim = {};
  for (const key of Object.keys(meta)) {
    if (!MOVIE_FACT_KEYS.has(key)) continue;
    const value = meta[key];
    if (key === 'video' && Array.isArray(value)) slim.video = firstTrack(value, MOVIE_VIDEO_TRACK_KEYS);
    else if (key === 'audio' && Array.isArray(value)) slim.audio = firstTrack(value, MOVIE_AUDIO_TRACK_KEYS);
    else slim[key] = value;
  }
  return slim;
}

/**
 * An episode's `additionalMetadata` as published: `{ size }`, or `{}` when the
 * stored object has no size (an unprobed file publishes `{}` today, and the
 * legacy flat sync tests the object's presence, so it stays an object).
 *
 * @param {Object|null|undefined} meta - The stored additionalMetadata
 * @returns {Object|null|undefined}
 */
export function slimEpisodeAdditionalMetadata(meta) {
  if (!isPlainObject(meta)) return meta;
  return Object.hasOwn(meta, 'size') ? { size: meta.size } : {};
}

/**
 * A show's `seasons` blob with every episode's additionalMetadata trimmed.
 * Builds new season and episode objects; everything else is passed by
 * reference and keeps its key order.
 *
 * @param {Object} seasons
 * @returns {Object}
 */
function slimSeasons(seasons) {
  if (!isPlainObject(seasons)) return seasons;
  const slim = {};
  for (const [seasonKey, season] of Object.entries(seasons)) {
    if (!isPlainObject(season) || !isPlainObject(season.episodes)) {
      slim[seasonKey] = season;
      continue;
    }
    const episodes = {};
    for (const [episodeKey, episode] of Object.entries(season.episodes)) {
      episodes[episodeKey] =
        isPlainObject(episode) && Object.hasOwn(episode, 'additionalMetadata')
          ? { ...episode, additionalMetadata: slimEpisodeAdditionalMetadata(episode.additionalMetadata) }
          : episode;
    }
    slim[seasonKey] = { ...season, episodes };
  }
  return slim;
}

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
    additional_metadata: slimMovieAdditionalMetadata(movie.additional_metadata),
    backdropFocal: movie.backdropFocal ?? null,
    backdropFocalSuggested: movie.backdropFocalSuggested ?? null,
  };
}

/**
 * One entry of the `/media/tv` response, keyed by show name.
 *
 * Episode-level fields (mediaIdentity, sources, jitEligible, jitUrl) ride
 * inside the `seasons` blob and pass through untouched — which is why TV was
 * unaffected by the movie allowlist bug. The one exception is each episode's
 * additionalMetadata, trimmed to its size (see the note at the top).
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
    seasons: slimSeasons(show.seasons),
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
