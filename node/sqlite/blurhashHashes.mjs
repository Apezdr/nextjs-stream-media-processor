import path from 'path';
import { createHash } from 'crypto';
import { createCategoryLogger } from '../lib/logger.mjs';
import { getMovies, getTVShows, withRetry } from '../sqliteDatabase.mjs';
import { getStoredBlurhash } from '../utils/utils.mjs';

const PREFIX_PATH = process.env.PREFIX_PATH || '';

const logger = createCategoryLogger('blurhashHashes');

// Current version of the hash data structure
export const HASH_DATA_VERSION = 1;

/**
 * Initialize the blurhash_hashes table in the database
 * @param {Object} db - SQLite database connection
 */
export async function initializeBlurhashHashesTable(db) {
  // First check if the image_type column exists
  const tableInfo = await db.all("PRAGMA table_info(blurhash_hashes)");
  const hasImageTypeColumn = tableInfo.some(column => column.name === 'image_type');
  
  // If table doesn't exist yet, create it with the image_type column
  if (tableInfo.length === 0) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS blurhash_hashes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_type TEXT NOT NULL,
        media_id TEXT NOT NULL,
        title TEXT NOT NULL,
        season_number TEXT,
        episode_key TEXT,
        image_type TEXT NOT NULL,
        hash TEXT NOT NULL,
        last_modified TIMESTAMP,
        hash_generated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        data_version INTEGER NOT NULL,
        UNIQUE(media_type, media_id, season_number, episode_key, image_type)
      );
      
      CREATE INDEX IF NOT EXISTS idx_blurhash_hashes_lookup ON blurhash_hashes(media_type, media_id, season_number, episode_key);
      CREATE INDEX IF NOT EXISTS idx_blurhash_hashes_title_lookup ON blurhash_hashes(media_type, title, season_number, episode_key);
      CREATE INDEX IF NOT EXISTS idx_blurhash_hashes_modified ON blurhash_hashes(last_modified);
      CREATE INDEX IF NOT EXISTS idx_blurhash_hashes_image_type ON blurhash_hashes(image_type);
    `);
  }
  
  logger.info('Blurhash hashes table initialized');
}

/**
 * Generate a deterministic hash for an object
 * @param {Object} data - The data to hash
 * @returns {string} - The hash value
 */
export function generateHash(data) {
  // Ensure deterministic JSON stringification by sorting keys
  const sortedJson = JSON.stringify(data, Object.keys(data).sort());
  return createHash('sha1').update(sortedJson).digest('hex');
}

/**
 * Store or update a blurhash hash in the database
 * @param {Object} db - SQLite database connection
 * @param {string} mediaType - 'movies' or 'tv'
 * @param {string} mediaId - Movie or TV show unique ID
 * @param {string} title - Movie or TV show title
 * @param {string|null} seasonNumber - Season number or null for movies/show-level
 * @param {string|null} episodeKey - Episode key (SxxExx) or null for movies/seasons/show-level
 * @param {string} imageType - Type of image (poster, backdrop, logo, thumbnail, etc.)
 * @param {string} hash - The calculated hash value
 * @param {string} lastModified - ISO timestamp of when the source content was last modified
 */
export async function storeHash(db, mediaType, mediaId, title, seasonNumber, episodeKey, imageType, hash, lastModified) {
  try {
    // Check if a record for this combination already exists
    const existingRecord = await withRetry(() => 
      db.get(
        `SELECT id FROM blurhash_hashes 
         WHERE media_type = ? AND media_id = ? AND title = ? 
         AND (season_number IS NULL AND ? IS NULL OR season_number = ?)
         AND (episode_key IS NULL AND ? IS NULL OR episode_key = ?)
         AND image_type = ?`,
        [
          mediaType, mediaId, title, 
          seasonNumber, seasonNumber,
          episodeKey, episodeKey,
          imageType
        ]
      )
    );

    if (existingRecord) {
      // Update the existing record
      await withRetry(() => 
        db.run(
          `UPDATE blurhash_hashes SET 
           hash = ?, 
           last_modified = ?, 
           hash_generated = CURRENT_TIMESTAMP,
           data_version = ?
           WHERE id = ?`,
          [hash, lastModified, HASH_DATA_VERSION, existingRecord.id]
        )
      );

      logger.debug(`Updated blurhash hash for ${mediaType}/${title}${seasonNumber ? '/' + seasonNumber : ''}${episodeKey ? '/' + episodeKey : ''} (${imageType})`);
    } else {
      // Insert a new record
      await withRetry(() => 
        db.run(
          `INSERT INTO blurhash_hashes 
            (media_type, media_id, title, season_number, episode_key, image_type, hash, last_modified, data_version) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            mediaType, mediaId, title, seasonNumber, episodeKey, imageType, hash, lastModified, HASH_DATA_VERSION
          ]
        )
      );

      logger.debug(`Inserted new blurhash hash for ${mediaType}/${title}${seasonNumber ? '/' + seasonNumber : ''}${episodeKey ? '/' + episodeKey : ''} (${imageType})`);
    }

    // Clean up any other duplicate records that might exist
    if (existingRecord) {
      await withRetry(() => 
        db.run(
          `DELETE FROM blurhash_hashes
           WHERE media_type = ? AND media_id = ? AND title = ? 
           AND (season_number IS NULL AND ? IS NULL OR season_number = ?)
           AND (episode_key IS NULL AND ? IS NULL OR episode_key = ?)
           AND image_type = ?
           AND id != ?`,
          [
            mediaType, mediaId, title, 
            seasonNumber, seasonNumber,
            episodeKey, episodeKey,
            imageType,
            existingRecord.id
          ]
        )
      );
    }
  } catch (error) {
    logger.error(`Error storing blurhash hash: ${error.message}`);
    throw error;
  }
}

/**
 * Clean up duplicate blurhash records in the database
 * @param {Object} db - SQLite database connection
 * @returns {Promise<number>} - Number of deleted duplicate records
 */
export async function cleanupDuplicateRecords(db) {
  try {
    logger.info('Starting cleanup of duplicate blurhash records...');
    
    // Get all unique combinations of media type, id, season, episode, and image type
    const uniqueCombinations = await withRetry(() => 
      db.all(`
        SELECT media_type, media_id, title, season_number, episode_key, image_type, 
               COUNT(*) as record_count, MAX(id) as latest_id
        FROM blurhash_hashes
        GROUP BY media_type, media_id, 
                 IFNULL(season_number, ''), 
                 IFNULL(episode_key, ''), 
                 image_type
        HAVING COUNT(*) > 1
      `)
    );
    
    let deletedCount = 0;
    
    // For each group with duplicates, delete all but the latest record
    for (const combo of uniqueCombinations) {
      const result = await withRetry(() => 
        db.run(`
          DELETE FROM blurhash_hashes
          WHERE media_type = ? AND media_id = ? AND title = ?
          AND (season_number IS NULL AND ? IS NULL OR season_number = ?)
          AND (episode_key IS NULL AND ? IS NULL OR episode_key = ?)
          AND image_type = ?
          AND id != ?
        `, [
          combo.media_type, combo.media_id, combo.title,
          combo.season_number, combo.season_number,
          combo.episode_key, combo.episode_key,
          combo.image_type,
          combo.latest_id
        ])
      );
      
      deletedCount += result.changes;
    }
    
    if (deletedCount > 0) {
      logger.info(`Cleaned up ${deletedCount} duplicate blurhash records`);
    } else {
      logger.info('No duplicate blurhash records found');
    }
    
    return deletedCount;
  } catch (error) {
    logger.error(`Error cleaning up duplicate blurhash records: ${error.message}`);
    return 0;
  }
}

/**
 * Get a blurhash hash from the database
 * @param {Object} db - SQLite database connection
 * @param {string} mediaType - 'movies' or 'tv'
 * @param {string} mediaId - Movie or TV show unique ID
 * @param {string|null} seasonNumber - Season number or null for movies/show-level
 * @param {string|null} episodeKey - Episode key (SxxExx) or null for movies/seasons/show-level
 * @returns {Promise<Object|null>} - The hash record or null if not found
 */
export async function getHash(db, mediaType, mediaId, seasonNumber = null, episodeKey = null) {
  try {
    return await withRetry(() => 
      db.get(
        `SELECT * FROM blurhash_hashes 
         WHERE media_type = ? AND media_id = ? AND season_number IS ? AND episode_key IS ?`,
        [mediaType, mediaId, seasonNumber, episodeKey]
      )
    );
  } catch (error) {
    logger.error(`Error getting blurhash hash: ${error.message}`);
    throw error;
  }
}

/**
 * Get a blurhash hash from the database by title
 * @param {Object} db - SQLite database connection
 * @param {string} mediaType - 'movies' or 'tv'
 * @param {string} title - Movie or TV show title
 * @param {string|null} seasonNumber - Season number or null for movies/show-level
 * @param {string|null} episodeKey - Episode key (SxxExx) or null for movies/seasons/show-level
 * @returns {Promise<Object|null>} - The hash record or null if not found
 */
export async function getHashByTitle(db, mediaType, title, seasonNumber = null, episodeKey = null) {
  try {
    return await withRetry(() => 
      db.get(
        `SELECT * FROM blurhash_hashes 
         WHERE media_type = ? AND title = ? AND season_number IS ? AND episode_key IS ?`,
        [mediaType, title, seasonNumber, episodeKey]
      )
    );
  } catch (error) {
    logger.error(`Error getting blurhash hash by title: ${error.message}`);
    throw error;
  }
}

/**
 * Get all blurhash hashes modified since a specific timestamp
 * @param {Object} db - SQLite database connection
 * @param {string} sinceTimestamp - ISO timestamp to filter by (e.g., "2023-01-01T00:00:00.000Z")
 * @returns {Promise<Array>} - Array of modified media records
 */
export async function getHashesModifiedSince(db, sinceTimestamp) {
  try {
    logger.info(`Fetching blurhash changes since ${sinceTimestamp}`);
    
    // Get all records modified since the given timestamp with better NULL handling
    const results = await withRetry(() => 
      db.all(
        `SELECT 
          media_type, 
          media_id, 
          title, 
          season_number, 
          episode_key, 
          image_type, 
          hash, 
          last_modified, 
          hash_generated
         FROM blurhash_hashes 
         WHERE (last_modified > ? OR hash_generated > ?)
         ORDER BY 
           media_type, 
           title, 
           IFNULL(season_number, ''), 
           IFNULL(episode_key, ''), 
           image_type`,
        [sinceTimestamp, sinceTimestamp]
      )
    );
    
    
    return results;
  } catch (error) {
    logger.error(`Error getting hashes modified since ${sinceTimestamp}: ${error.message}`);
    throw error;
  }
}

/**
 * Generate and store hashes for a movie's blurhash data
 * @param {Object} db - SQLite database connection
 * @param {Object} movie - Movie data
 * @param {string} basePath - Base path to media files
 */
export async function generateMovieBlurhashHashes(db, movie, basePath) {
  try {
    if (!movie._id) {
      logger.warn(`Movie ${movie.name} has no ID, skipping blurhash hash generation`);
      return;
    }

    // Extract relevant fields for hashing
    const blurhashData = {
      name: movie.name,
      lastModified: movie.urls?.mediaLastModified || new Date().toISOString()
    };
    
    // Use the direct file paths from the database when available
    if (movie.posterFilePath) {
      logger.debug(`Using direct file path for poster for "${movie.name}": ${movie.posterFilePath}`);
      const blurhash = await getStoredBlurhash(movie.posterFilePath, basePath);
      if (blurhash) {
        blurhashData.posterBlurhash = blurhash;
        logger.debug(`Found poster blurhash for "${movie.name}" using direct path`);
      } else {
        logger.debug(`No poster blurhash found for "${movie.name}" using direct path`);
      }
    } 
    // Fallback to URL-based path construction if direct path not available
    else if (movie.urls?.poster) {
      const posterUrl = movie.urls.poster;
      // Remove PREFIX_PATH and clean the URL to be a proper relative path
      let relativePosterPath = posterUrl;
      if (PREFIX_PATH && posterUrl.startsWith(PREFIX_PATH)) {
        relativePosterPath = posterUrl.substring(PREFIX_PATH.length);
      }
      // Remove any leading slashes
      relativePosterPath = relativePosterPath.replace(/^\/+/, '');
      
      // Construct the full path using path.join for proper cross-platform handling
      const fullPosterPath = path.join(basePath, relativePosterPath);
      
      logger.debug(`Looking for poster blurhash for "${movie.name}" at: ${fullPosterPath}`);
      const blurhash = await getStoredBlurhash(fullPosterPath, basePath);
      if (blurhash) {
        blurhashData.posterBlurhash = blurhash;
        logger.debug(`Found poster blurhash for "${movie.name}"`);
      } else {
        logger.debug(`No poster blurhash found for "${movie.name}" at ${fullPosterPath}`);
      }
    }
    
    // Use the direct file paths for backdrop from the database when available
    if (movie.backdropFilePath) {
      logger.debug(`Using direct file path for backdrop for "${movie.name}": ${movie.backdropFilePath}`);
      const blurhash = await getStoredBlurhash(movie.backdropFilePath, basePath);
      if (blurhash) {
        blurhashData.backdropBlurhash = blurhash;
        logger.debug(`Found backdrop blurhash for "${movie.name}" using direct path`);
      } else {
        logger.debug(`No backdrop blurhash found for "${movie.name}" using direct path`);
      }
    }
    // Fallback to URL-based path construction if direct path not available
    else if (movie.urls?.backdrop) {
      const backdropUrl = movie.urls.backdrop;
      // Remove PREFIX_PATH and clean the URL to be a proper relative path
      let relativeBackdropPath = backdropUrl;
      if (PREFIX_PATH && backdropUrl.startsWith(PREFIX_PATH)) {
        relativeBackdropPath = backdropUrl.substring(PREFIX_PATH.length);
      }
      // Remove any leading slashes
      relativeBackdropPath = relativeBackdropPath.replace(/^\/+/, '');
      
      // Construct the full path using path.join for proper cross-platform handling
      const fullBackdropPath = path.join(basePath, relativeBackdropPath);
      
      logger.debug(`Looking for backdrop blurhash for "${movie.name}" at: ${fullBackdropPath}`);
      const blurhash = await getStoredBlurhash(fullBackdropPath, basePath);
      if (blurhash) {
        blurhashData.backdropBlurhash = blurhash;
        logger.debug(`Found backdrop blurhash for "${movie.name}"`);
      } else {
        logger.debug(`No backdrop blurhash found for "${movie.name}" at ${fullBackdropPath}`);
      }
    }
    
    // Use the direct file paths for logo from the database when available
    if (movie.logoFilePath) {
      logger.debug(`Using direct file path for logo for "${movie.name}": ${movie.logoFilePath}`);
      const blurhash = await getStoredBlurhash(movie.logoFilePath, basePath);
      if (blurhash) {
        blurhashData.logoBlurhash = blurhash;
        logger.debug(`Found logo blurhash for "${movie.name}" using direct path`);
      } else {
        logger.debug(`No logo blurhash found for "${movie.name}" using direct path`);
      }
    }
    // Fallback to URL-based path construction if direct path not available
    else if (movie.urls?.logo) {
      const logoUrl = movie.urls.logo;
      // Remove PREFIX_PATH and clean the URL to be a proper relative path
      let relativeLogoPath = logoUrl;
      if (PREFIX_PATH && logoUrl.startsWith(PREFIX_PATH)) {
        relativeLogoPath = logoUrl.substring(PREFIX_PATH.length);
      }
      // Remove any leading slashes
      relativeLogoPath = relativeLogoPath.replace(/^\/+/, '');
      
      // Construct the full path using path.join for proper cross-platform handling
      const fullLogoPath = path.join(basePath, relativeLogoPath);
      
      logger.debug(`Looking for logo blurhash for "${movie.name}" at: ${fullLogoPath}`);
      const blurhash = await getStoredBlurhash(fullLogoPath, basePath);
      if (blurhash) {
        blurhashData.logoBlurhash = blurhash;
        logger.debug(`Found logo blurhash for "${movie.name}"`);
      } else {
        logger.debug(`No logo blurhash found for "${movie.name}" at ${fullLogoPath}`);
      }
    }
    
    // Store each blurhash type separately
    if (blurhashData.posterBlurhash) {
      await storeHash(
        db, 
        'movies', 
        movie._id,
        movie.name, 
        null, 
        null, 
        'poster',
        generateHash({ blurhash: blurhashData.posterBlurhash }),
        blurhashData.lastModified
      );
    }
    
    if (blurhashData.backdropBlurhash) {
      await storeHash(
        db, 
        'movies', 
        movie._id,
        movie.name, 
        null, 
        null, 
        'backdrop',
        generateHash({ blurhash: blurhashData.backdropBlurhash }),
        blurhashData.lastModified
      );
    }
    
    if (blurhashData.logoBlurhash) {
      await storeHash(
        db, 
        'movies', 
        movie._id,
        movie.name, 
        null, 
        null, 
        'logo',
        generateHash({ blurhash: blurhashData.logoBlurhash }),
        blurhashData.lastModified
      );
    }
    
    logger.debug(`Generated blurhash hash for movie: ${movie.name}`);
  } catch (error) {
    logger.error(`Error generating movie blurhash hash for ${movie.name}: ${error.message}`);
  }
}

/**
 * Generate and store hashes for a TV show's blurhash data and its seasons/episodes
 * @param {Object} db - SQLite database connection
 * @param {Object} show - TV show data
 * @param {string} basePath - Base path to media files
 */
export async function generateTVShowBlurhashHashes(db, show, basePath) {
  try {
    // Store each blurhash type for the show level
    const showId = show._id || `tv_${show.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const currentTime = new Date().toISOString();
    
    // Process show poster if URL is available
    const posterUrl = show.urls?.poster;
    if (posterUrl) {
      // Remove PREFIX_PATH and clean the URL to be a proper relative path
      let relativePosterPath = posterUrl;
      if (PREFIX_PATH && posterUrl.startsWith(PREFIX_PATH)) {
        relativePosterPath = posterUrl.substring(PREFIX_PATH.length);
      }
      // Remove any leading slashes
      relativePosterPath = relativePosterPath.replace(/^\/+/, '');
      
      // Construct the full path using path.join for proper cross-platform handling
      const fullPosterPath = path.join(basePath, relativePosterPath);
      
      logger.debug(`Looking for TV show poster blurhash for "${show.name}" at: ${fullPosterPath}`);
      const blurhash = await getStoredBlurhash(fullPosterPath, basePath);
      if (blurhash) {
        show.posterBlurhash = blurhash;
        logger.debug(`Found TV show poster blurhash for "${show.name}"`);
      }
    }
    
    // Process show backdrop if URL is available
    const backdropUrl = show.urls?.backdrop;
    if (backdropUrl) {
      // Remove PREFIX_PATH and clean the URL to be a proper relative path
      let relativeBackdropPath = backdropUrl;
      if (PREFIX_PATH && backdropUrl.startsWith(PREFIX_PATH)) {
        relativeBackdropPath = backdropUrl.substring(PREFIX_PATH.length);
      }
      // Remove any leading slashes
      relativeBackdropPath = relativeBackdropPath.replace(/^\/+/, '');
      
      // Construct the full path using path.join for proper cross-platform handling
      const fullBackdropPath = path.join(basePath, relativeBackdropPath);
      
      logger.debug(`Looking for TV show backdrop blurhash for "${show.name}" at: ${fullBackdropPath}`);
      const blurhash = await getStoredBlurhash(fullBackdropPath, basePath);
      if (blurhash) {
        show.backdropBlurhash = blurhash;
        logger.debug(`Found TV show backdrop blurhash for "${show.name}"`);
      }
    }
    
    // Process show logo if URL is available
    const logoUrl = show.urls?.logo;
    if (logoUrl) {
      // Remove PREFIX_PATH and clean the URL to be a proper relative path
      let relativeLogoPath = logoUrl;
      if (PREFIX_PATH && logoUrl.startsWith(PREFIX_PATH)) {
        relativeLogoPath = logoUrl.substring(PREFIX_PATH.length);
      }
      // Remove any leading slashes
      relativeLogoPath = relativeLogoPath.replace(/^\/+/, '');
      
      // Construct the full path using path.join for proper cross-platform handling
      const fullLogoPath = path.join(basePath, relativeLogoPath);
      
      logger.debug(`Looking for TV show logo blurhash for "${show.name}" at: ${fullLogoPath}`);
      const blurhash = await getStoredBlurhash(fullLogoPath, basePath);
      if (blurhash) {
        show.logoBlurhash = blurhash;
        logger.debug(`Found TV show logo blurhash for "${show.name}"`);
      }
    }
    
    // Store poster blurhash if available
    if (show.posterBlurhash) {
      await storeHash(
        db, 
        'tv', 
        showId,
        show.name, 
        null, 
        null, 
        'poster',
        generateHash({ blurhash: show.posterBlurhash }),
        currentTime
      );
    }
    
    // Store logo blurhash if available
    if (show.logoBlurhash) {
      await storeHash(
        db, 
        'tv', 
        showId,
        show.name, 
        null, 
        null, 
        'logo',
        generateHash({ blurhash: show.logoBlurhash }),
        currentTime
      );
    }
    
    // Store backdrop blurhash if available
    if (show.backdropBlurhash) {
      await storeHash(
        db, 
        'tv', 
        showId,
        show.name, 
        null, 
        null, 
        'backdrop',
        generateHash({ blurhash: show.backdropBlurhash }),
        currentTime
      );
    }
    
    // Generate and store season-level hashes
    for (const [seasonName, seasonData] of Object.entries(show.seasons)) {
      // Extract season number from name (e.g., "Season 1" -> "1")
      const seasonNumber = seasonName.replace(/Season\s+/i, '');
      
      // Process season poster if URL is available
      const seasonPosterUrl = seasonData.urls?.poster;
      if (seasonPosterUrl) {
        // Remove PREFIX_PATH and clean the URL to be a proper relative path
        let relativeSeasonPosterPath = seasonPosterUrl;
        if (PREFIX_PATH && seasonPosterUrl.startsWith(PREFIX_PATH)) {
          relativeSeasonPosterPath = seasonPosterUrl.substring(PREFIX_PATH.length);
        }
        // Remove any leading slashes
        relativeSeasonPosterPath = relativeSeasonPosterPath.replace(/^\/+/, '');
        
        // Construct the full path using path.join for proper cross-platform handling
        const fullSeasonPosterPath = path.join(basePath, relativeSeasonPosterPath);
        
        logger.debug(`Looking for season poster blurhash for "${show.name}" season ${seasonNumber} at: ${fullSeasonPosterPath}`);
        const blurhash = await getStoredBlurhash(fullSeasonPosterPath, basePath);
        if (blurhash) {
          seasonData.seasonPosterBlurhash = blurhash;
          logger.debug(`Found season poster blurhash for "${show.name}" season ${seasonNumber}`);
        }
      }
      
      // Store season poster blurhash if available
      if (seasonData.seasonPosterBlurhash) {
        await storeHash(
          db, 
          'tv', 
          showId,
          show.name, 
          seasonNumber, 
          null, 
          'season_poster',
          generateHash({ blurhash: seasonData.seasonPosterBlurhash }),
          currentTime
        );
      }
      
      // Generate and store episode-level hashes
      for (const [episodeKey, episodeData] of Object.entries(seasonData.episodes)) {
        // Process episode thumbnail if URL is available
        const thumbnailUrl = episodeData.urls?.thumbnail;
        if (thumbnailUrl) {
          // Remove PREFIX_PATH and clean the URL to be a proper relative path
          let relativeThumbnailPath = thumbnailUrl;
          if (PREFIX_PATH && thumbnailUrl.startsWith(PREFIX_PATH)) {
            relativeThumbnailPath = thumbnailUrl.substring(PREFIX_PATH.length);
          }
          // Remove any leading slashes
          relativeThumbnailPath = relativeThumbnailPath.replace(/^\/+/, '');
          
          // Construct the full path using path.join for proper cross-platform handling
          const fullThumbnailPath = path.join(basePath, relativeThumbnailPath);
          
          logger.debug(`Looking for episode thumbnail blurhash for "${show.name}" S${seasonNumber}${episodeKey} at: ${fullThumbnailPath}`);
          const blurhash = await getStoredBlurhash(fullThumbnailPath, basePath);
          if (blurhash) {
            episodeData.thumbnailBlurhash = blurhash;
            logger.debug(`Found episode thumbnail blurhash for "${show.name}" S${seasonNumber}${episodeKey}`);
          }
        }
        
        // Store episode thumbnail blurhash if available
        if (episodeData.thumbnailBlurhash) {
          await storeHash(
            db, 
            'tv', 
            showId,
            show.name, 
            seasonNumber, 
            episodeKey, 
            'thumbnail',
            generateHash({ blurhash: episodeData.thumbnailBlurhash }),
            episodeData.mediaLastModified || currentTime
          );
        }
      }
    }
    
    logger.debug(`Generated blurhash hashes for TV show: ${show.name}`);
  } catch (error) {
    logger.error(`Error generating TV show blurhash hashes for ${show.name}: ${error.message}`);
  }
}

/**
 * Update blurhash hashes for all movies in the database
 * @param {Object} db - SQLite database connection
 * @param {string} basePath - Base path to media files
 * @param {string|null} sinceTimestamp - Optional timestamp to filter movies modified since this time
 */
export async function updateAllMovieBlurhashHashes(db, basePath, sinceTimestamp = null) {
  try {
    const movies = await getMovies(db);
    
    // If sinceTimestamp is provided, filter movies that were modified since that time
    let moviesToProcess = movies;
    if (sinceTimestamp) {
      moviesToProcess = movies.filter(movie => {
        const mediaLastModified = movie.urls?.mediaLastModified;
        return !mediaLastModified || new Date(mediaLastModified) >= new Date(sinceTimestamp);
      });
      logger.info(`Processing ${moviesToProcess.length} of ${movies.length} movies modified since ${sinceTimestamp}`);
    }
    
    if (moviesToProcess.length === 0) {
      logger.info('No movies to update blurhash hashes for');
      return;
    }
    
    logger.info(`Updating blurhash hashes for ${moviesToProcess.length} movies`);
    
    // Use a single transaction for better performance
    await db.exec('BEGIN TRANSACTION');
    
    try {
      for (const movie of moviesToProcess) {
        await generateMovieBlurhashHashes(db, movie, basePath);
      }
      
      await db.exec('COMMIT');
      logger.info('Movie blurhash hashes update completed successfully');
    } catch (error) {
      // Rollback the transaction on error
      await db.exec('ROLLBACK');
      logger.error(`Error processing blurhash hashes: ${error.message}`);
      throw error;
    }
  } catch (error) {
    logger.error(`Error updating movie blurhash hashes: ${error.message}`);
  }
}

/**
 * Update blurhash hashes for all TV shows in the database
 * @param {Object} db - SQLite database connection
 * @param {string} basePath - Base path to media files
 * @param {string|null} sinceTimestamp - Optional timestamp to filter shows modified since this time
 */
export async function updateAllTVShowBlurhashHashes(db, basePath, sinceTimestamp = null) {
  try {
    const shows = await getTVShows(db);
    
    // If sinceTimestamp is provided, filter shows or episodes that were modified since that time
    // This is more complex for TV shows as episodes have their own modification timestamps
    let showsToProcess = shows;
    if (sinceTimestamp) {
      // For TV shows, we need to keep the whole show even if only one episode was modified
      showsToProcess = shows.filter(show => {
        // Check if any episodes were modified since the timestamp
        for (const seasonName in show.seasons) {
          const season = show.seasons[seasonName];
          for (const episodeKey in season.episodes) {
            const episode = season.episodes[episodeKey];
            const mediaLastModified = episode.mediaLastModified;
            if (mediaLastModified && new Date(mediaLastModified) >= new Date(sinceTimestamp)) {
              return true; // Keep this show if any episode was modified
            }
          }
        }
        return false; // No episodes were modified
      });
      logger.info(`Processing ${showsToProcess.length} of ${shows.length} TV shows with content modified since ${sinceTimestamp}`);
    }
    
    if (showsToProcess.length === 0) {
      logger.info('No TV shows to update blurhash hashes for');
      return;
    }
    
    logger.info(`Updating blurhash hashes for ${showsToProcess.length} TV shows`);
    
    // Process each show in its own transaction to keep transactions smaller
    for (const show of showsToProcess) {
      try {
        // Start transaction for this show
        await db.exec('BEGIN TRANSACTION');
        
        try {
          await generateTVShowBlurhashHashes(db, show, basePath);
          await db.exec('COMMIT');
        } catch (error) {
          await db.exec('ROLLBACK');
          throw error;
        }
        
        logger.debug(`Processed TV show: ${show.name}`);
      } catch (error) {
        logger.error(`Error processing TV show ${show.name}: ${error.message}`);
        // Continue with next show even if this one fails
      }
    }
    
    logger.info('TV show blurhash hashes update completed');
  } catch (error) {
    logger.error(`Error updating TV show blurhash hashes: ${error.message}`);
  }
}

/**
 * Get movie blurhash data by ID
 * @param {Object} db - SQLite database connection
 * @param {string} movieId - Movie ID
 * @returns {Promise<Object|null>} - The movie blurhash data or null if not found
 */
export async function getMovieBlurhashData(db, movieId) {
  try {
    const movies = await getMovies(db);
    const movie = movies.find(m => m._id === movieId);
    
    if (!movie) {
      return null;
    }
    
    // Get all blurhash records for this movie
    const blurhashRecords = await withRetry(() => 
      db.all(
        `SELECT * FROM blurhash_hashes 
         WHERE media_type = 'movies' AND media_id = ?`,
        [movieId]
      )
    );
    
    // Format the data with image types
    const imageHashes = {};
    
    // If we have records from the database, use them
    if (blurhashRecords.length > 0) {
      for (const record of blurhashRecords) {
        // Format timestamp to ISO 8601 format if it's not already
        const formattedGenerated = record.hash_generated ? 
          (record.hash_generated.endsWith('Z') ? record.hash_generated : new Date(record.hash_generated).toISOString()) : 
          new Date().toISOString();
          
        imageHashes[record.image_type] = {
          hash: record.hash,
          lastModified: record.last_modified,
          generated: formattedGenerated
        };
      }
    } else {
      // If no database records, populate directly from movie data and store them
      const now = new Date().toISOString();
      const needsPersistence = [];
      
      if (movie.urls?.posterBlurhash) {
        const posterHash = generateHash({ blurhash: movie.urls.posterBlurhash });
        imageHashes['poster'] = {
          hash: posterHash,
          lastModified: movie.urls.mediaLastModified || now,
          generated: now
        };
        
        needsPersistence.push({
          type: 'poster',
          hash: posterHash,
          lastModified: movie.urls.mediaLastModified || now
        });
      }
      
      if (movie.urls?.backdropBlurhash) {
        const backdropHash = generateHash({ blurhash: movie.urls.backdropBlurhash });
        imageHashes['backdrop'] = {
          hash: backdropHash,
          lastModified: movie.urls.mediaLastModified || now,
          generated: now
        };
        
        needsPersistence.push({
          type: 'backdrop',
          hash: backdropHash,
          lastModified: movie.urls.mediaLastModified || now
        });
      }
      
      if (movie.urls?.logoBlurhash) {
        const logoHash = generateHash({ blurhash: movie.urls.logoBlurhash });
        imageHashes['logo'] = {
          hash: logoHash,
          lastModified: movie.urls.mediaLastModified || now,
          generated: now
        };
        
        needsPersistence.push({
          type: 'logo',
          hash: logoHash,
          lastModified: movie.urls.mediaLastModified || now
        });
      }
      
      // Store hashes in the database immediately rather than in a background task
      if (needsPersistence.length > 0) {
        for (const item of needsPersistence) {
          try {
            await storeHash(
              db,
              'movies',
              movie._id,
              movie.name,
              null,
              null,
              item.type,
              item.hash,
              item.lastModified
            );
            logger.info(`Stored ${item.type} hash for movie ${movie.name} (${movie._id})`);
          } catch (err) {
            logger.error(`Failed to store ${item.type} hash for movie ${movie.name}: ${err.message}`);
          }
        }
      }
    }
    
    return {
      _id: movie._id,
      name: movie.name,
      posterBlurhash: movie.urls?.posterBlurhash,
      backdropBlurhash: movie.urls?.backdropBlurhash,
      logoBlurhash: movie.urls?.logoBlurhash,
      imageHashes: imageHashes
    };
  } catch (error) {
    logger.error(`Error getting movie blurhash data for ${movieId}: ${error.message}`);
    throw error;
  }
}

/**
 * Get TV show blurhash data by ID
 * @param {Object} db - SQLite database connection
 * @param {string} showId - TV show ID
 * @returns {Promise<Object|null>} - The TV show blurhash data or null if not found
 */
export async function getTVShowBlurhashData(db, showId) {
  try {
    const shows = await getTVShows(db);
    const show = shows.find(s => s._id === showId || 
                                `tv_${s.name.replace(/[^a-zA-Z0-9]/g, '_')}` === showId);
    
    if (!show) {
      return null;
    }
    
    // Get all blurhash records for the show by hierarchical level
    const allBlurhashData = await withRetry(() => 
      db.all(
        `SELECT * FROM blurhash_hashes 
         WHERE media_type = 'tv' AND media_id = ?
         ORDER BY season_number, episode_key, image_type`,
        [showId]
      )
    );
    
    // Group records by their level in the hierarchy and image type
    const showLevelHashes = {};
    const seasonLevelHashes = {};
    const episodeLevelHashes = {};
    
    // Process all database records
    for (const record of allBlurhashData) {
      // Format timestamp to ISO 8601 format if it's not already
      const formattedGenerated = record.hash_generated ? 
        (record.hash_generated.endsWith('Z') ? record.hash_generated : new Date(record.hash_generated).toISOString()) : 
        new Date().toISOString();
      
      // Show level records
      if (!record.season_number && !record.episode_key) {
        showLevelHashes[record.image_type] = {
          hash: record.hash,
          lastModified: record.last_modified,
          generated: formattedGenerated
        };
      }
      // Season level records 
      else if (record.season_number && !record.episode_key) {
        if (!seasonLevelHashes[record.season_number]) {
          seasonLevelHashes[record.season_number] = {};
        }
        seasonLevelHashes[record.season_number][record.image_type] = {
          hash: record.hash,
          lastModified: record.last_modified,
          generated: formattedGenerated
        };
      }
      // Episode level records
      else if (record.season_number && record.episode_key) {
        if (!episodeLevelHashes[record.season_number]) {
          episodeLevelHashes[record.season_number] = {};
        }
        if (!episodeLevelHashes[record.season_number][record.episode_key]) {
          episodeLevelHashes[record.season_number][record.episode_key] = {};
        }
        episodeLevelHashes[record.season_number][record.episode_key][record.image_type] = {
          hash: record.hash,
          lastModified: record.last_modified,
          generated: formattedGenerated
        };
      }
    }
    
    // Format season data
    const seasonsMap = {};
    for (const [seasonName, seasonData] of Object.entries(show.seasons)) {
      const seasonNumber = seasonName.replace(/Season\s+/i, '');
      const seasonKey = `Season ${seasonNumber}`;
      
      // Format episode data for this season
      const episodesMap = {};
      for (const [episodeKey, episodeData] of Object.entries(seasonData.episodes)) {
        if (episodeLevelHashes[seasonNumber]?.[episodeKey]) {
          episodesMap[episodeKey] = {
            _id: episodeData._id,
            thumbnailBlurhash: episodeData.thumbnailBlurhash,
            imageHashes: episodeLevelHashes[seasonNumber][episodeKey]
          };
        }
      }
      
      seasonsMap[seasonKey] = {
        seasonNumber: seasonData.seasonNumber,
        seasonPosterBlurhash: seasonData.seasonPosterBlurhash,
        imageHashes: seasonLevelHashes[seasonNumber] || {},
        episodes: episodesMap
      };
    }
    
    return {
      _id: showId,
      name: show.name,
      posterBlurhash: show.posterBlurhash,
      logoBlurhash: show.logoBlurhash,
      backdropBlurhash: show.backdropBlurhash,
      imageHashes: showLevelHashes,
      seasons: seasonsMap
    };
  } catch (error) {
    logger.error(`Error getting TV show blurhash data for ${showId}: ${error.message}`);
    throw error;
  }
}
