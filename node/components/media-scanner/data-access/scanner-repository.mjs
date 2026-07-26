import { createCategoryLogger } from '../../../lib/logger.mjs';
import {
  initializeDatabase,
  insertOrUpdateMovie,
  getMovies,
  deleteMovie,
  insertOrUpdateTVShow,
  getTVShows,
  getTVShowNamesAndHashes,
  deleteTVShow,
  getMissingDataMedia,
  insertOrUpdateMissingDataMedia,
  deleteMissingDataMedia,
  getEpisodeMetadataMissingRows,
  recordEpisodeMetadataAttempt,
  clearEpisodeMetadataMissing,
  clearEpisodeMetadataMissingForShow,
  releaseDatabase
} from '../../../sqliteDatabase.mjs';

const logger = createCategoryLogger('scanner-repository');

/**
 * Data Access Layer for Media Scanner
 * Handles all database operations for scanning media files
 */

/**
 * A per-scan record of which title claimed which id. Create one per scan run
 * and thread it through every recordMediaIdentity call in that run.
 *
 * @returns {Map<string, string>}
 */
export function createIdentityClaims() {
  return new Map();
}

/**
 * Record a resolved identity in the reverse index, reporting whether another
 * title in THIS SAME SCAN already claimed that id.
 *
 * The index is a rebuildable cache; its one active job is this collision check.
 * A genuine collision means a copied media folder brought a cloned
 * .mediaid.json with it, and two distinct titles would otherwise share a resume
 * position.
 *
 * The "this same scan" qualifier is load-bearing. Comparing against the STORED
 * row instead treats a folder rename as a duplicate — the stored name is the
 * old one, the presented name is the new one, they differ, and the caller
 * repoints. That would destroy the single property the sidecar exists to
 * provide, on the very next scan after any rename. A stale row from an earlier
 * pass is not evidence of anything: the other folder may be long gone. Only two
 * folders both present in one pass prove a duplicate.
 *
 * Resolution is deliberately NOT "first one wins", which would depend on scan
 * order and differ between runs. The caller re-derives the loser's id from its
 * own path, which is unique per folder by construction.
 *
 * @param {Object} db
 * @param {Map<string,string>} claims - From createIdentityClaims(), per scan run
 * @returns {Promise<{conflict: boolean, ownedBy: string|null}>}
 */
export async function recordMediaIdentity(db, claims, { mediaId, mediaType, mediaName, seasonKey = '', episodeKey = '' }) {
  if (!mediaId) return { conflict: false, ownedBy: null };

  // Structured, not a joined string: media names contain spaces and arbitrary
  // punctuation, so parsing a name back out of a delimited key is lossy.
  const prior = claims.get(mediaId);
  const isSameClaimant =
    prior &&
    prior.mediaName === mediaName &&
    prior.seasonKey === seasonKey &&
    prior.episodeKey === episodeKey;

  if (prior && !isSameClaimant) {
    logger.warn(
      `identity duplicate: ${mediaId} was claimed by "${prior.mediaName}" ` +
      `(season="${prior.seasonKey}" episode="${prior.episodeKey}") and again by ` +
      `"${mediaName}" (season="${seasonKey}" episode="${episodeKey}") in the same scan`
    );
    return { conflict: true, ownedBy: prior.mediaName };
  }

  claims.set(mediaId, { mediaName, seasonKey, episodeKey });

  // Unconditional upsert. A row whose media_name differs is a RENAME, and the
  // correct response is to follow it, not to fight it.
  await db.run(
    `INSERT INTO media_identity_index (media_id, media_type, media_name, season_key, episode_key, seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(media_id) DO UPDATE SET
       media_type=excluded.media_type,
       media_name=excluded.media_name,
       season_key=excluded.season_key,
       episode_key=excluded.episode_key,
       seen_at=excluded.seen_at`,
    [mediaId, mediaType, mediaName, seasonKey, episodeKey, new Date().toISOString()]
  );

  return { conflict: false, ownedBy: null };
}

/**
 * Cooldown (in hours) between retries for media that has been flagged as
 * having missing TMDB data. Owned here because the cooldown semantics belong
 * to the `missing_data_media` table that this repository fronts.
 *
 * Only the *metadata-missing* failure mode is gated by this interval —
 * transient image-download failures bypass it and retry every scan tick
 * (see the scanner gate logic in movie-scanner.mjs and tv-scanner.mjs).
 */
export const RETRY_INTERVAL_HOURS = 24;

/**
 * Get all existing movies from the database
 * @returns {Promise<Array>} Array of movie objects
 */
export async function getExistingMovies() {
  return await getMovies();
}

/**
 * Get all existing TV shows from the database
 * @returns {Promise<Array>} Array of TV show objects
 */
export async function getExistingTVShows() {
  return await getTVShows();
}

/**
 * Lightweight: get only TV show names and directory hashes (no season/image processing)
 * @returns {Promise<Array<{name: string, directory_hash: string|null}>>}
 */
export async function getExistingTVShowHashes() {
  return await getTVShowNamesAndHashes();
}

/**
 * Get media with missing data
 * @returns {Promise<Array>} Array of media items with missing data
 */
export async function getMissingMediaData() {
  return await getMissingDataMedia();
}

/**
 * Save or update a movie in the database
 * @param {string} name - Movie name
 * @param {Array} fileNames - Array of file names
 * @param {Object} fileLengths - File lengths mapping
 * @param {Object} fileDimensions - File dimensions mapping
 * @param {Object} urls - URLs object
 * @param {string} metadataUrl - Metadata URL
 * @param {string} directoryHash - Directory hash
 * @param {Object} hdrInfo - HDR information
 * @param {Object} mediaQuality - Media quality information
 * @param {Object} additionalMetadata - Additional metadata
 * @param {string} id - Media ID
 * @param {string} posterFilePath - Poster file path
 * @param {string} backdropFilePath - Backdrop file path
 * @param {string} logoFilePath - Logo file path
 * @param {string} basePath - Base path for media files
 * @param {Object} [backdropFocal] - Manual backdrop focal override
 * @param {Object} [backdropFocalSuggested] - Auto-detected backdrop focal
 * @param {Object} [imageHashes] - Precomputed `{poster,backdrop,logo}` →
 *   `{hash,mtime}` cache-bust hashes from the scanner's single resolve, so the
 *   DB stores the exact hash for the file the URL points at (no second stat).
 * @param {string|null} [metadata] - Canonically-serialized metadata.json
 *   content fingerprint (opaque string; F-1). The scanner produces it, the
 *   hash writers consume the stored column verbatim — this layer never parses it.
 * @param {string|null} [pristineMetadata] - Raw pre-override TMDB payload from
 *   a genuine fetch (opaque string; G-5). Null when no fetch happened this
 *   pass — the upsert then preserves the previously stored value.
 * @param {Object|null} [sourceUrls] - Per-kind `{poster,backdrop,logo}` image
 *   source-URL provenance updates from the generator (I-3). Null per kind (or
 *   as a whole) means "no new information" — the upsert COALESCE-preserves
 *   the stored column value. This layer never inspects the URLs.
 * @returns {Promise<void>}
 */
export async function saveMovie(
  name,
  fileNames,
  fileLengths,
  fileDimensions,
  urls,
  metadataUrl,
  directoryHash,
  hdrInfo,
  mediaQuality,
  additionalMetadata,
  id,
  posterFilePath,
  backdropFilePath,
  logoFilePath,
  basePath,
  backdropFocal = null,
  backdropFocalSuggested = null,
  imageHashes = null,
  metadata = null,
  pristineMetadata = null,
  sourceUrls = null,
  mediaId = null
) {
  await insertOrUpdateMovie(
    name,
    fileNames,
    fileLengths,
    fileDimensions,
    urls,
    metadataUrl,
    directoryHash,
    hdrInfo,
    mediaQuality,
    additionalMetadata,
    id,
    posterFilePath,
    backdropFilePath,
    logoFilePath,
    basePath,
    backdropFocal,
    backdropFocalSuggested,
    imageHashes,
    metadata,
    pristineMetadata,
    sourceUrls,
    mediaId
  );
}

/**
 * Save or update a TV show in the database
 * @param {string} showName - TV show name
 * @param {string} metadata - Metadata JSON string
 * @param {string} metadataUrl - Metadata URL
 * @param {string} poster - Poster URL
 * @param {string} posterBlurhash - Poster blurhash
 * @param {string} logo - Logo URL
 * @param {string} logoBlurhash - Logo blurhash
 * @param {string} backdrop - Backdrop URL
 * @param {string} backdropBlurhash - Backdrop blurhash
 * @param {Object} seasonsObj - Seasons object
 * @param {string} posterFilePath - Poster file path
 * @param {string} backdropFilePath - Backdrop file path
 * @param {string} logoFilePath - Logo file path
 * @param {string} basePath - Base path for media files
 * @param {string} directoryHash - Directory hash for change detection
 * @param {Object} [backdropFocal] - Manual backdrop focal override
 * @param {Object} [backdropFocalSuggested] - Auto-detected backdrop focal
 * @param {Object} [imageHashes] - Precomputed `{poster,backdrop,logo}` →
 *   `{hash,mtime}` cache-bust hashes from the scanner's single resolve, so the
 *   DB stores the exact hash for the file the URL points at (no second stat).
 * @param {string|null} [pristineMetadata] - Raw pre-override TMDB payload from
 *   a genuine fetch (opaque string; G-5). Null when no fetch happened this
 *   pass — the upsert then carries the previously stored value forward
 *   (the TV upsert always rewrites, so preservation lives in its SQL).
 * @param {Object|null} [sourceUrls] - Per-kind `{poster,backdrop,logo}` image
 *   source-URL provenance updates from the generator (I-3). Null per kind (or
 *   as a whole) means "no new information" — the upsert COALESCE-preserves
 *   the stored column value. This layer never inspects the URLs.
 * @returns {Promise<void>}
 */
export async function saveTVShow(
  showName,
  metadata,
  metadataUrl,
  poster,
  posterBlurhash,
  logo,
  logoBlurhash,
  backdrop,
  backdropBlurhash,
  seasonsObj,
  posterFilePath,
  backdropFilePath,
  logoFilePath,
  basePath,
  directoryHash = null,
  backdropFocal = null,
  backdropFocalSuggested = null,
  imageHashes = null,
  pristineMetadata = null,
  sourceUrls = null,
  mediaId = null
) {
  await insertOrUpdateTVShow(
    showName,
    metadata,
    metadataUrl,
    poster,
    posterBlurhash,
    logo,
    logoBlurhash,
    backdrop,
    backdropBlurhash,
    seasonsObj,
    posterFilePath,
    backdropFilePath,
    logoFilePath,
    basePath,
    directoryHash,
    backdropFocal,
    backdropFocalSuggested,
    imageHashes,
    pristineMetadata,
    sourceUrls,
    mediaId
  );
}

/**
 * Remove a movie from the database
 * @param {string} name - Movie name
 * @returns {Promise<void>}
 */
export async function removeMovie(name) {
  await deleteMovie(name);
}

/**
 * Remove a TV show from the database
 * @param {string} name - TV show name
 * @returns {Promise<void>}
 */
export async function removeTVShow(name) {
  await deleteTVShow(name);
}

/**
 * Mark media as having missing data (for retry logic).
 *
 * Records a `last_attempt` timestamp so the scanner can apply the
 * `RETRY_INTERVAL_HOURS` cooldown before re-attempting a TMDB metadata
 * lookup. Should ONLY be called for the metadata-missing failure mode —
 * pure image-download failures should not flip this gate (they retry
 * every scan tick).
 *
 * @param {string} name - Media name
 */
export async function markMediaAsMissingData(name) {
  await insertOrUpdateMissingDataMedia(name);
}

/**
 * Clear a previously-flagged item from the missing-data cooldown table.
 * Called by the scanner after a successful recovery where BOTH metadata
 * and all required image files are now present on disk. Idempotent.
 *
 * @param {string} name - Media name
 */
export async function clearMissingMediaData(name) {
  await deleteMissingDataMedia(name);
}

/**
 * Per-episode backfill cooldown rows for one show (air-date-aware retry).
 * @param {string} showName
 */
export async function getEpisodeRetryRows(showName) {
  return await getEpisodeMetadataMissingRows(showName);
}

/**
 * Stamp a backfill attempt for one episode (upsert; bumps attempts, preserves
 * a known air_date). Drives the 3-day per-episode cooldown.
 */
export async function recordEpisodeAttempt(showName, seasonNumber, episodeNumber, airDate) {
  await recordEpisodeMetadataAttempt(showName, seasonNumber, episodeNumber, airDate);
}

/**
 * Clear an episode's backfill cooldown row once it's resolved. Idempotent.
 */
export async function clearEpisodeRetry(showName, seasonNumber, episodeNumber) {
  await clearEpisodeMetadataMissing(showName, seasonNumber, episodeNumber);
}

/**
 * Clear ALL of a show's episode backfill cooldown rows (R-4 removal cascade:
 * the show left the filesystem, so a same-named show re-added later must not
 * inherit its predecessor's retry history). Idempotent.
 */
export async function clearEpisodeRetryForShow(showName) {
  await clearEpisodeMetadataMissingForShow(showName);
}

/**
 * Get a database connection instance for direct querying
 * @returns {Promise<Object>} Database instance
 */
export async function getDatabaseInstance() {
  return await initializeDatabase();
}

/**
 * Release a database connection
 * @param {Object} db - Database instance to release
 * @returns {Promise<void>}
 */
export async function releaseDatabaseInstance(db) {
  if (db) {
    await releaseDatabase(db);
  }
}
