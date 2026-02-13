/**
 * Media Scanner Component
 * 
 * This component follows the 3-tier architecture pattern:
 * - entry-points: HTTP request handlers and external interfaces
 * - domain: Business logic for scanning media files
 * - data-access: Database operations
 * 
 * This structure separates concerns and makes the code more maintainable and testable.
 */

export {
  scanMoviesLibrary,
  scanTVShowsLibrary,
  scanMediaLibrary
} from './entry-points/scanner-controller.mjs';

export {
  scanMovies
} from './domain/movie-scanner.mjs';

export {
  scanTVShows
} from './domain/tv-scanner.mjs';

export {
  getExistingMovies,
  getExistingTVShows,
  getMissingMediaData,
  saveMovie,
  saveTVShow,
  removeMovie,
  removeTVShow,
  markMediaAsMissingData
} from './data-access/scanner-repository.mjs';
