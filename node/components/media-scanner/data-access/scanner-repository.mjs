import { createCategoryLogger } from '../../../lib/logger.mjs';
import {
  initializeDatabase,
  insertOrUpdateMovie,
  getMovies,
  deleteMovie,
  insertOrUpdateTVShow,
  getTVShows,
  deleteTVShow,
  getMissingDataMedia,
  insertOrUpdateMissingDataMedia,
  releaseDatabase
} from '../../../sqliteDatabase.mjs';

const logger = createCategoryLogger('scanner-repository');

/**
 * Data Access Layer for Media Scanner
 * Handles all database operations for scanning media files
 */

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
  basePath
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
    basePath
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
  basePath
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
    basePath
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
 * Mark media as having missing data (for retry logic)
 * @param {string} name - Media name
 * @returns {Promise<void>}
 */
export async function markMediaAsMissingData(name) {
  await insertOrUpdateMissingDataMedia(name);
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
