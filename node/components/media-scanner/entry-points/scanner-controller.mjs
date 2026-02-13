import { createCategoryLogger } from '../../../lib/logger.mjs';
import { scanMovies } from '../domain/movie-scanner.mjs';
import { scanTVShows } from '../domain/tv-scanner.mjs';
import { getDatabaseInstance, releaseDatabaseInstance } from '../data-access/scanner-repository.mjs';

const logger = createCategoryLogger('scanner-controller');

/**
 * Entry-point controller for media scanner
 * Handles HTTP requests and coordinates scanning operations
 */

/**
 * Scan movies library
 * @param {string} moviesPath - Path to movies directory
 * @param {string} prefixPath - URL prefix path
 * @param {string} basePath - Base path for media files
 * @param {Object} langMap - Language code mapping
 * @param {number} currentVersion - Current info file version
 * @param {boolean} isDebugMode - Debug mode flag
 * @param {Function} downloadTMDBImages - Function to download TMDB images
 * @returns {Promise<void>}
 */
export async function scanMoviesLibrary(
  moviesPath,
  prefixPath,
  basePath,
  langMap,
  currentVersion,
  isDebugMode,
  downloadTMDBImages
) {
  const db = await getDatabaseInstance();
  
  try {
    logger.info('Starting movie library scan');
    await scanMovies(
      db,
      moviesPath,
      prefixPath,
      basePath,
      langMap,
      currentVersion,
      isDebugMode,
      downloadTMDBImages
    );
    logger.info('Movie library scan completed');
  } catch (error) {
    logger.error(`Error scanning movie library: ${error.message}`);
    throw error;
  } finally {
    await releaseDatabaseInstance(db);
  }
}

/**
 * Scan TV shows library
 * @param {string} tvPath - Path to TV shows directory
 * @param {string} prefixPath - URL prefix path
 * @param {string} basePath - Base path for media files
 * @param {Object} langMap - Language code mapping
 * @param {boolean} isDebugMode - Debug mode flag
 * @param {Function} downloadTMDBImages - Function to download TMDB images
 * @returns {Promise<void>}
 */
export async function scanTVShowsLibrary(
  tvPath,
  prefixPath,
  basePath,
  langMap,
  isDebugMode,
  downloadTMDBImages
) {
  const db = await getDatabaseInstance();
  
  try {
    logger.info('Starting TV shows library scan');
    await scanTVShows(
      db,
      tvPath,
      prefixPath,
      basePath,
      langMap,
      isDebugMode,
      downloadTMDBImages
    );
    logger.info('TV shows library scan completed');
  } catch (error) {
    logger.error(`Error scanning TV shows library: ${error.message}`);
    throw error;
  } finally {
    await releaseDatabaseInstance(db);
  }
}

/**
 * Scan entire media library (movies and TV shows)
 * @param {string} moviesPath - Path to movies directory
 * @param {string} tvPath - Path to TV shows directory
 * @param {string} prefixPath - URL prefix path
 * @param {string} basePath - Base path for media files
 * @param {Object} langMap - Language code mapping
 * @param {number} currentVersion - Current info file version
 * @param {boolean} isDebugMode - Debug mode flag
 * @param {Function} downloadTMDBImages - Function to download TMDB images
 * @returns {Promise<void>}
 */
export async function scanMediaLibrary(
  moviesPath,
  tvPath,
  prefixPath,
  basePath,
  langMap,
  currentVersion,
  isDebugMode,
  downloadTMDBImages
) {
  logger.info('Starting complete media library scan');
  
  try {
    await scanMoviesLibrary(
      moviesPath,
      prefixPath,
      basePath,
      langMap,
      currentVersion,
      isDebugMode,
      downloadTMDBImages
    );
    
    await scanTVShowsLibrary(
      tvPath,
      prefixPath,
      basePath,
      langMap,
      isDebugMode,
      downloadTMDBImages
    );
    
    logger.info('Complete media library scan finished');
  } catch (error) {
    logger.error(`Error during media library scan: ${error.message}`);
    throw error;
  }
}
