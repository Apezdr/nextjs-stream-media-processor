import { createHash } from 'crypto';
import { createCategoryLogger } from '../lib/logger.mjs';
import { withRetry } from '../sqliteDatabase.mjs';

const logger = createCategoryLogger('metadataHashes');

// Current version of the hash data structure
export const HASH_DATA_VERSION = 1;

/**
 * Initialize the metadata_hashes table in the database
 * @param {Object} db - SQLite database connection
 */
export async function initializeMetadataHashesTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS metadata_hashes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type TEXT NOT NULL,
      title TEXT NOT NULL,
      season_number TEXT,
      episode_key TEXT,
      hash TEXT NOT NULL,
      last_modified TIMESTAMP,
      hash_generated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      data_version INTEGER NOT NULL,
      UNIQUE(media_type, title, season_number, episode_key)
    );
    
    CREATE INDEX IF NOT EXISTS idx_metadata_hashes_lookup ON metadata_hashes(media_type, title, season_number, episode_key);
    CREATE INDEX IF NOT EXISTS idx_metadata_hashes_modified ON metadata_hashes(last_modified);
  `);
  
  logger.info('Metadata hashes table initialized');
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
 * Store or update a hash in the database
 * @param {Object} db - SQLite database connection
 * @param {string} mediaType - 'movies' or 'tv'
 * @param {string} title - Movie or TV show title
 * @param {string|null} seasonNumber - Season number or null for movies/show-level
 * @param {string|null} episodeKey - Episode key (SxxExx) or null for movies/seasons/show-level
 * @param {string} hash - The calculated hash value
 * @param {string} lastModified - ISO timestamp of when the source content was last modified
 */
export async function storeHash(db, mediaType, title, seasonNumber, episodeKey, hash, lastModified) {
  try {
    await withRetry(() => 
      db.run(
        `INSERT INTO metadata_hashes 
          (media_type, title, season_number, episode_key, hash, last_modified, data_version) 
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(media_type, title, season_number, episode_key) 
         DO UPDATE SET 
           hash = ?, 
           last_modified = ?, 
           hash_generated = CURRENT_TIMESTAMP,
           data_version = ?`,
        [
          mediaType, title, seasonNumber, episodeKey, hash, lastModified, HASH_DATA_VERSION,
          hash, lastModified, HASH_DATA_VERSION
        ]
      )
    );
    logger.debug(`Stored hash for ${mediaType}/${title}${seasonNumber ? '/' + seasonNumber : ''}${episodeKey ? '/' + episodeKey : ''}`);
  } catch (error) {
    logger.error(`Error storing hash: ${error.message}`);
    throw error;
  }
}

/**
 * Get a hash from the database
 * @param {Object} db - SQLite database connection
 * @param {string} mediaType - 'movies' or 'tv'
 * @param {string} title - Movie or TV show title
 * @param {string|null} seasonNumber - Season number or null for movies/show-level
 * @param {string|null} episodeKey - Episode key (SxxExx) or null for movies/seasons/show-level
 * @returns {Promise<Object|null>} - The hash record or null if not found
 */
export async function getHash(db, mediaType, title, seasonNumber = null, episodeKey = null) {
  try {
    return await withRetry(() => 
      db.get(
        `SELECT * FROM metadata_hashes 
         WHERE media_type = ? AND title = ? AND season_number IS ? AND episode_key IS ?`,
        [mediaType, title, seasonNumber, episodeKey]
      )
    );
  } catch (error) {
    logger.error(`Error getting hash: ${error.message}`);
    throw error;
  }
}

/**
 * Get all hashes for a specific media type
 * @param {Object} db - SQLite database connection
 * @param {string} mediaType - 'movies' or 'tv'
 * @returns {Promise<Object>} - Object with media type hash and title-level hashes
 */
export async function getMediaTypeHashes(db, mediaType) {
  try {
    // Check if we need to generate hashes first
    if (mediaType === 'movies') {
      // Check if we have any movie hashes
      const movieHashCount = await withRetry(() => 
        db.get(
          `SELECT COUNT(*) as count 
           FROM metadata_hashes 
           WHERE media_type = 'movies' AND season_number IS NULL AND episode_key IS NULL`
        )
      );
      
      // If no movie hashes exist, generate them
      if (movieHashCount.count === 0) {
        logger.info('No movie hashes found, generating them now');
        await updateAllMovieHashes(db);
      }
    } else if (mediaType === 'tv') {
      // Check if we have any TV show hashes
      const tvHashCount = await withRetry(() => 
        db.get(
          `SELECT COUNT(*) as count 
           FROM metadata_hashes 
           WHERE media_type = 'tv' AND season_number IS NULL AND episode_key IS NULL`
        )
      );
      
      // If no TV show hashes exist, generate them
      if (tvHashCount.count === 0) {
        logger.info('No TV show hashes found, generating them now');
        await updateAllTVShowHashes(db);
      }
    }
    
    // Get all title-level hashes for this media type
    const titleHashes = await withRetry(() => 
      db.all(
        `SELECT title, hash, last_modified, hash_generated 
         FROM metadata_hashes 
         WHERE media_type = ? AND season_number IS NULL AND episode_key IS NULL`,
        [mediaType]
      )
    );
    
    // Format the result as a map of titles to hashes
    const hashesMap = {};
    for (const record of titleHashes) {
      hashesMap[record.title] = {
        hash: record.hash,
        lastModified: record.last_modified,
        generated: record.hash_generated
      };
    }
    
    // Calculate a hash of all title hashes to represent the entire media type
    const mediaTypeHash = generateHash(hashesMap);
    
    return {
      hash: mediaTypeHash,
      titles: hashesMap,
      generated: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`Error getting media type hashes: ${error.message}`);
    throw error;
  }
}

/**
 * Get all season hashes for a specific TV show
 * @param {Object} db - SQLite database connection
 * @param {string} title - TV show title
 * @returns {Promise<Object>} - Object with show hash and season-level hashes
 */
export async function getShowHashes(db, title) {
  try {
    // Check if we need to generate hashes for this show
    const showHash = await getHash(db, 'tv', title);
    
    if (!showHash) {
      // If no show hash exists, generate it
      logger.info(`No hash found for TV show: ${title}, generating now`);
      const { getTVShowByName } = await import('../sqliteDatabase.mjs');
      const show = await getTVShowByName(db, title);
      
      if (show) {
        await generateTVShowHashes(db, show);
      } else {
        logger.warn(`TV show not found: ${title}`);
      }
    }
    
    // Get the updated show hash
    const updatedShowHash = await getHash(db, 'tv', title);
    
    // Get all season-level hashes for this show
    const seasonHashes = await withRetry(() => 
      db.all(
        `SELECT season_number, hash, last_modified, hash_generated 
         FROM metadata_hashes 
         WHERE media_type = 'tv' AND title = ? AND season_number IS NOT NULL AND episode_key IS NULL`,
        [title]
      )
    );
    
    // Format the result as a map of season numbers to hashes
    const seasonsMap = {};
    for (const record of seasonHashes) {
      seasonsMap[record.season_number] = {
        hash: record.hash,
        lastModified: record.last_modified,
        generated: record.hash_generated
      };
    }
    
    return {
      hash: updatedShowHash ? updatedShowHash.hash : null,
      seasons: seasonsMap,
      generated: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`Error getting show hashes: ${error.message}`);
    throw error;
  }
}

/**
 * Get all episode hashes for a specific season of a TV show
 * @param {Object} db - SQLite database connection
 * @param {string} title - TV show title
 * @param {string} seasonNumber - Season number
 * @returns {Promise<Object>} - Object with season hash and episode-level hashes
 */
export async function getSeasonHashes(db, title, seasonNumber) {
  try {
    // Check if we need to generate hashes for this season
    const seasonHash = await getHash(db, 'tv', title, seasonNumber);
    
    if (!seasonHash) {
      // If no season hash exists, generate it
      logger.info(`No hash found for season ${seasonNumber} of ${title}, generating now`);
      const { getTVShowByName } = await import('../sqliteDatabase.mjs');
      const show = await getTVShowByName(db, title);
      
      if (show) {
        // Check if this season exists
        const seasonKey = `Season ${seasonNumber}`;
        if (show.seasons[seasonKey]) {
          await generateTVShowHashes(db, show);
        } else {
          logger.warn(`Season ${seasonNumber} not found for TV show: ${title}`);
        }
      } else {
        logger.warn(`TV show not found: ${title}`);
      }
    }
    
    // Get the updated season hash
    const updatedSeasonHash = await getHash(db, 'tv', title, seasonNumber);
    
    // Get all episode-level hashes for this season
    const episodeHashes = await withRetry(() => 
      db.all(
        `SELECT episode_key, hash, last_modified, hash_generated 
         FROM metadata_hashes 
         WHERE media_type = 'tv' AND title = ? AND season_number = ? AND episode_key IS NOT NULL`,
        [title, seasonNumber]
      )
    );
    
    // Format the result as a map of episode keys to hashes
    const episodesMap = {};
    for (const record of episodeHashes) {
      episodesMap[record.episode_key] = {
        hash: record.hash,
        lastModified: record.last_modified,
        generated: record.hash_generated
      };
    }
    
    return {
      hash: updatedSeasonHash ? updatedSeasonHash.hash : null,
      episodes: episodesMap,
      generated: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`Error getting season hashes: ${error.message}`);
    throw error;
  }
}

/**
 * Generate and store hashes for a movie
 * @param {Object} db - SQLite database connection
 * @param {Object} movie - Movie data
 */
export async function generateMovieHashes(db, movie) {
  try {
    // Extract relevant fields for hashing
    const hashableData = {
      _id: movie._id,
      name: movie.name,
      urls: movie.urls,
      hdr: movie.hdr,
      mediaQuality: movie.mediaQuality,
      metadataUrl: movie.metadataUrl,
      lastModified: movie.urls?.mediaLastModified || new Date().toISOString()
    };
    
    // Generate hash
    const hash = generateHash(hashableData);
    
    // Store the hash
    await storeHash(
      db, 
      'movies', 
      movie.name, 
      null, 
      null, 
      hash, 
      hashableData.lastModified
    );
    
    logger.debug(`Generated hash for movie: ${movie.name}`);
  } catch (error) {
    logger.error(`Error generating movie hash for ${movie.name}: ${error.message}`);
  }
}

/**
 * Generate and store hashes for a TV show and its seasons/episodes
 * @param {Object} db - SQLite database connection
 * @param {Object} show - TV show data
 */
export async function generateTVShowHashes(db, show) {
  try {
    // Generate show-level hash
    const showHashableData = {
      name: show.name,
      metadata_path: show.metadata_path,
      poster: show.poster,
      logo: show.logo,
      backdrop: show.backdrop,
      seasonKeys: Object.keys(show.seasons)
    };
    
    const showHash = generateHash(showHashableData);
    
    // Store show-level hash
    await storeHash(
      db, 
      'tv', 
      show.name, 
      null, 
      null, 
      showHash, 
      new Date().toISOString()
    );
    
    // Generate and store season-level hashes
    for (const [seasonName, seasonData] of Object.entries(show.seasons)) {
      // Extract season number from name (e.g., "Season 1" -> "1")
      const seasonNumber = seasonName.replace(/Season\s+/i, '');
      
      // Generate season-level hash
      const seasonHashableData = {
        seasonNumber: seasonData.seasonNumber,
        season_poster: seasonData.season_poster,
        episodeKeys: Object.keys(seasonData.episodes)
      };
      
      const seasonHash = generateHash(seasonHashableData);
      
      // Store season-level hash
      await storeHash(
        db, 
        'tv', 
        show.name, 
        seasonNumber, 
        null, 
        seasonHash, 
        new Date().toISOString()
      );
      
      // Generate and store episode-level hashes
      for (const [episodeKey, episodeData] of Object.entries(seasonData.episodes)) {
        // Generate episode-level hash
        const episodeHashableData = {
          _id: episodeData._id,
          filename: episodeData.filename,
          videoURL: episodeData.videoURL,
          mediaLastModified: episodeData.mediaLastModified,
          hdr: episodeData.hdr,
          mediaQuality: episodeData.mediaQuality,
          thumbnail: episodeData.thumbnail,
          metadata: episodeData.metadata,
          chapters: episodeData.chapters,
          subtitles: episodeData.subtitles
        };
        
        const episodeHash = generateHash(episodeHashableData);
        
        // Store episode-level hash
        await storeHash(
          db, 
          'tv', 
          show.name, 
          seasonNumber, 
          episodeKey, 
          episodeHash, 
          episodeData.mediaLastModified || new Date().toISOString()
        );
      }
    }
    
    logger.debug(`Generated hashes for TV show: ${show.name}`);
  } catch (error) {
    logger.error(`Error generating TV show hashes for ${show.name}: ${error.message}`);
  }
}

/**
 * Get movies modified since a specific timestamp
 * @param {Object} db - SQLite database connection
 * @param {string} sinceTimestamp - ISO timestamp to filter by
 * @returns {Promise<Array>} - Array of movies modified since the timestamp
 */
export async function getMoviesModifiedSince(db, sinceTimestamp) {
  try {
    const { getMovies } = await import('../sqliteDatabase.mjs');
    const allMovies = await getMovies(db);
    
    // Filter movies that have been modified since the timestamp
    return allMovies.filter(movie => {
      const mediaLastModified = movie.urls?.mediaLastModified;
      return mediaLastModified && new Date(mediaLastModified) >= new Date(sinceTimestamp);
    });
  } catch (error) {
    logger.error(`Error getting movies modified since ${sinceTimestamp}: ${error.message}`);
    throw error;
  }
}

/**
 * Update hashes for all movies in the database
 * @param {Object} db - SQLite database connection
 * @param {string} sinceTimestamp - Optional timestamp to filter movies modified since
 */
export async function updateAllMovieHashes(db, sinceTimestamp = null) {
  try {
    const { getMovies } = await import('../sqliteDatabase.mjs');
    
    // Get movies to process - either all movies or only recently modified ones
    const movies = sinceTimestamp 
      ? await getMoviesModifiedSince(db, sinceTimestamp)
      : await getMovies(db);
    
    if (movies.length === 0) {
      logger.info('No movies to update metadata hashes for');
      return;
    }
    
    logger.info(`Updating hashes for ${movies.length} movies${sinceTimestamp ? ` modified since ${sinceTimestamp}` : ''}`);
    
    // Use a single transaction for better performance
    await db.exec('BEGIN TRANSACTION');
    
    try {
      for (const movie of movies) {
        await generateMovieHashes(db, movie);
      }
      
      await db.exec('COMMIT');
      logger.info('Movie hashes update completed successfully');
    } catch (error) {
      // Rollback the transaction on error
      await db.exec('ROLLBACK');
      logger.error(`Error processing metadata hashes: ${error.message}`);
      throw error;
    }
  } catch (error) {
    logger.error(`Error updating movie hashes: ${error.message}`);
  }
}

/**
 * Get TV shows with episodes modified since a specific timestamp
 * @param {Object} db - SQLite database connection
 * @param {string} sinceTimestamp - ISO timestamp to filter by
 * @returns {Promise<Array>} - Array of TV shows with modified episodes
 */
export async function getTVShowsModifiedSince(db, sinceTimestamp) {
  try {
    const { getTVShows } = await import('../sqliteDatabase.mjs');
    const allShows = await getTVShows(db);
    
    // Filter shows that have episodes modified since the timestamp
    return allShows.filter(show => {
      // Check any episode in any season for modification
      for (const seasonName in show.seasons) {
        const season = show.seasons[seasonName];
        for (const episodeKey in season.episodes) {
          const episode = season.episodes[episodeKey];
          const mediaLastModified = episode.mediaLastModified;
          if (mediaLastModified && new Date(mediaLastModified) >= new Date(sinceTimestamp)) {
            return true; // This show has at least one modified episode
          }
        }
      }
      return false; // No episodes were modified
    });
  } catch (error) {
    logger.error(`Error getting TV shows modified since ${sinceTimestamp}: ${error.message}`);
    throw error;
  }
}

/**
 * Update hashes for all TV shows in the database
 * @param {Object} db - SQLite database connection
 * @param {string} sinceTimestamp - Optional timestamp to filter shows modified since
 */
export async function updateAllTVShowHashes(db, sinceTimestamp = null) {
  try {
    const { getTVShows } = await import('../sqliteDatabase.mjs');
    
    // Get shows to process - either all shows or only those with recently modified episodes
    const shows = sinceTimestamp 
      ? await getTVShowsModifiedSince(db, sinceTimestamp)
      : await getTVShows(db);
    
    if (shows.length === 0) {
      logger.info('No TV shows to update metadata hashes for');
      return;
    }
    
    logger.info(`Updating hashes for ${shows.length} TV shows${sinceTimestamp ? ` modified since ${sinceTimestamp}` : ''}`);
    
    // Process each show in its own transaction to keep transactions smaller
    for (const show of shows) {
      try {
        // Start a transaction for this show
        await db.exec('BEGIN TRANSACTION');
        
        try {
          await generateTVShowHashes(db, show);
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
    
    logger.info('TV show hashes update completed');
  } catch (error) {
    logger.error(`Error updating TV show hashes: ${error.message}`);
  }
}
