import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { initializeMetadataHashesTable } from './sqlite/metadataHashes.mjs';
import { createHash } from 'crypto';
import { fileExists } from './utils/utils.mjs';

// Need to implement connection pooling and connection handling
// to avoid SQLITE_BUSY errors
// and to ensure that the database is not locked by other processes

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbDirectory = join(__dirname, 'db');
const dbFilePaths = {
  main: join(dbDirectory, 'media.db'),
  processTracking: join(dbDirectory, 'process_tracking.db'),
  tmdbCache: join(dbDirectory, 'tmdb_cache.db')
};

// Track initialization status for each database type
var hasInitialized = {
  main: false,
  processTracking: false,
  tmdbCache: false
};

// Cache for database connections
const dbConnections = {};

/**
 * Helper function that wraps a database operation.
 * If a SQLITE_BUSY error is encountered, it retries the operation with exponential backoff.
 * @param {Function} operation - The database operation to execute
 * @param {number} maxRetries - Maximum number of retry attempts before failing
 * @param {number} initialDelayMs - Initial delay between retries in milliseconds
 * @returns {Promise<any>} - The result of the database operation
 */
export async function withRetry(operation, maxRetries = 15, initialDelayMs = 200) {
  let attempt = 0;
  let delay = initialDelayMs;
  
  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (error) {
      if (error.code === 'SQLITE_BUSY') {
        attempt++;
        // Exponential backoff with jitter for better distribution
        delay = Math.min(delay * 1.5, 5000) * (0.9 + Math.random() * 0.2);
        
        console.warn(
          `SQLITE_BUSY encountered. Retrying ${attempt}/${maxRetries} after ${Math.round(delay)}ms...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error('Operation failed after maximum retries');
}

/**
 * Initialize a SQLite database connection.
 * @param {string} dbType - Type of database to initialize ('main' or 'processTracking')
 * @returns {Promise<Object>} - The database connection
 */
export async function initializeDatabase(dbType = 'main') {
  // Check if we already have a cached connection
  if (dbConnections[dbType]) {
    return dbConnections[dbType];
  }

  // Create the db directory if it doesn't exist
  await fs.mkdir(dbDirectory, { recursive: true });
  
  // Get the appropriate database file path
  const dbFilePath = dbFilePaths[dbType] || dbFilePaths.main;
  
  // Open the database connection
  const db = await open({ filename: dbFilePath, driver: sqlite3.Database });
  
  // Enable WAL mode for better concurrency
  await db.exec('PRAGMA journal_mode = WAL');
  
  // Optimize synchronous setting for better performance with WAL
  await db.exec('PRAGMA synchronous = NORMAL');
  
  // Increase SQLite busy timeout to reduce SQLITE_BUSY errors
  await db.exec('PRAGMA busy_timeout = 15000');
  
  // Initialize tables based on database type
  if (dbType === 'main' && !hasInitialized.main) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS movies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            file_names TEXT,
            lengths TEXT,
            dimensions TEXT,
            urls TEXT,
            metadata_url TEXT,
            directory_hash TEXT,
            hdr TEXT,
            media_quality TEXT,
            additional_metadata TEXT,
            _id TEXT,
            poster_file_path TEXT,
            backdrop_file_path TEXT,
            logo_file_path TEXT,
            base_path TEXT
        );
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS tv_shows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            metadata TEXT,
            metadata_path TEXT,
            poster TEXT,
            posterBlurhash TEXT,
            logo TEXT,
            logoBlurhash TEXT,
            backdrop TEXT,
            backdropBlurhash TEXT,
            seasons TEXT,
            directory_hash TEXT,
            poster_file_path TEXT,
            backdrop_file_path TEXT,
            logo_file_path TEXT,
            base_path TEXT
        );
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS missing_data_media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            last_attempt TEXT
        );
    `);
    
    // Initialize metadata_hashes table
    await initializeMetadataHashesTable(db);
    
    hasInitialized.main = true;
  }
  // Initialize process tracking database
  else if (dbType === 'processTracking' && !hasInitialized.processTracking) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS process_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_key TEXT UNIQUE,
        process_type TEXT,
        total_steps INTEGER,
        current_step INTEGER,
        status TEXT,
        message TEXT,
        last_updated TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    hasInitialized.processTracking = true;
  }
  // Initialize TMDB cache database
  else if (dbType === 'tmdbCache' && !hasInitialized.tmdbCache) {
    // Create TMDB cache table with TTL functionality for the exposed API endpoint
    await db.exec(`
        CREATE TABLE IF NOT EXISTS tmdb_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cache_key TEXT UNIQUE,
            endpoint TEXT,
            request_params TEXT,
            response_data TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT,
            last_accessed TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    
    // Create index for TMDB cache efficient cache lookups
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tmdb_cache_key ON tmdb_cache(cache_key);
    `);
    
    // Create index for TMDB cache for TTL cleanup
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tmdb_cache_expires ON tmdb_cache(expires_at);
    `);
    
    hasInitialized.tmdbCache = true;
  }
  return db;
}

export async function releaseDatabase(db) {
  return await db.close();
}

export async function insertOrUpdateTVShow(
  db,
  showName,
  metadata,
  metadataPath,
  poster,
  posterBlurhash,
  logo,
  logoBlurhash,
  backdrop,
  backdropBlurhash,
  seasonsObj,
  posterFilePath = null,
  backdropFilePath = null,
  logoFilePath = null,
  basePath = null
) {
  const seasonsStr = JSON.stringify(seasonsObj);
  const existingShow = await withRetry(() =>
    db.get('SELECT * FROM tv_shows WHERE name = ?', [showName])
  );

  if (existingShow) {
    await withRetry(() =>
      db.run(
        `UPDATE tv_shows 
         SET metadata = ?, metadata_path = ?, poster = ?, posterBlurhash = ?, logo = ?, logoBlurhash = ?, 
             backdrop = ?, backdropBlurhash = ?, seasons = ?,
             poster_file_path = ?, backdrop_file_path = ?, logo_file_path = ?, base_path = ?
         WHERE name = ?`,
        [
          metadata, metadataPath, poster, posterBlurhash, logo, logoBlurhash, backdrop, backdropBlurhash, seasonsStr,
          posterFilePath, backdropFilePath, logoFilePath, basePath,
          showName
        ]
      )
    );
  } else {
    await withRetry(() =>
      db.run(
        `INSERT INTO tv_shows (name, metadata, metadata_path, poster, posterBlurhash, logo, logoBlurhash, backdrop, backdropBlurhash, seasons,
                               poster_file_path, backdrop_file_path, logo_file_path, base_path) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          showName, metadata, metadataPath, poster, posterBlurhash, logo, logoBlurhash, backdrop, backdropBlurhash, seasonsStr,
          posterFilePath, backdropFilePath, logoFilePath, basePath
        ]
      )
    );
  }
}

export async function insertOrUpdateMovie(
  db,
  name,
  fileNames,
  lengths,
  dimensions,
  urls,
  metadata_url,
  hash,
  hdr,
  mediaQuality,
  additionalMetadata,
  _id,
  posterFilePath = null,
  backdropFilePath = null,
  logoFilePath = null,
  basePath = null
) {
  const movie = {
    name,
    file_names: JSON.stringify(fileNames),
    lengths: JSON.stringify(lengths),
    dimensions: JSON.stringify(dimensions),
    urls: JSON.stringify(urls),
    hash,
    hdr,
    media_quality: mediaQuality ? JSON.stringify(mediaQuality) : null,
    additional_metadata: JSON.stringify(additionalMetadata),
    _id,
    poster_file_path: posterFilePath,
    backdrop_file_path: backdropFilePath,
    logo_file_path: logoFilePath,
    base_path: basePath
  };

  const existingMovie = await withRetry(() =>
    db.get('SELECT * FROM movies WHERE name = ?', [name])
  );
  if (existingMovie) {
    if (existingMovie.directory_hash !== hash) {
      await withRetry(() =>
        db.run(
          `UPDATE movies 
           SET file_names = ?, lengths = ?, dimensions = ?, urls = ?, metadata_url = ?, directory_hash = ?, 
               hdr = ?, media_quality = ?, additional_metadata = ?, _id = ?,
               poster_file_path = ?, backdrop_file_path = ?, logo_file_path = ?, base_path = ?
           WHERE name = ?`,
          [
            movie.file_names,
            movie.lengths,
            movie.dimensions,
            movie.urls,
            metadata_url,
            hash,
            movie.hdr,
            movie.media_quality,
            movie.additional_metadata,
            _id,
            posterFilePath,
            backdropFilePath,
            logoFilePath,
            basePath,
            name
          ]
        )
      );
    }
  } else {
    await withRetry(() =>
      db.run(
        `INSERT INTO movies (file_names, lengths, dimensions, urls, metadata_url, directory_hash, hdr, media_quality, additional_metadata, _id, 
                            poster_file_path, backdrop_file_path, logo_file_path, base_path, name) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          movie.file_names,
          movie.lengths,
          movie.dimensions,
          movie.urls,
          metadata_url,
          hash,
          movie.hdr,
          movie.media_quality,
          movie.additional_metadata,
          _id,
          posterFilePath,
          backdropFilePath,
          logoFilePath,
          basePath,
          name
        ]
      )
    );
  }
}

export async function insertOrUpdateMissingDataMedia(db, name) {
  const now = new Date().toISOString();
  try {
    await withRetry(() =>
      db.run('INSERT INTO missing_data_media (name, last_attempt) VALUES (?, ?)', [name, now])
    );
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      // If the entry already exists, update the last_attempt timestamp
      await withRetry(() =>
        db.run('UPDATE missing_data_media SET last_attempt = ? WHERE name = ?', [now, name])
      );
    } else {
      throw error; // Re-throw if it's not a unique constraint error
    }
  }
}

/**
 * Utility function to refresh image URL hashes based on current file modification times
 * @param {string} url - The original image URL
 * @param {string} filePath - Path to the actual image file
 * @returns {string} - Updated URL with a fresh hash parameter
 */
async function refreshImageUrlHash(url, filePath) {
  // If there's no file path or URL, return the original URL
  if (!filePath || !url) return url;
  
  try {
    // Check if the file exists
    if (await fileExists(filePath)) {
      // Get the file's current stats
      const stats = await fs.stat(filePath);
      // Create a hash from the modification time
      const imageHash = createHash('md5').update(stats.mtime.toISOString()).digest('hex').substring(0, 10);
      
      // If the URL already has a hash parameter, replace it
      if (url.includes('?hash=')) {
        return url.replace(/\?hash=[a-f0-9]+/, `?hash=${imageHash}`);
      }
      // Otherwise, add the hash parameter
      else {
        return `${url}?hash=${imageHash}`;
      }
    }
  } catch (error) {
    console.error(`Error refreshing image hash for ${filePath}: ${error.message}`);
  }
  
  // Return the original URL if anything fails
  return url;
}

/**
 * Updates all image URLs in a TV show season with fresh hash parameters
 * @param {Object} season - Season object with episodes
 * @param {string} basePath - Base path for resolving file paths
 * @returns {Object} - Updated season with fresh image URL hashes
 */
async function refreshSeasonImageHashes(season, basePath, showPath, seasonName) {
  // Skip if it's not a valid season or there's no base path
  if (!season || !basePath) return season;
  
  const updatedSeason = { ...season };
  
  // Update season poster if available
  if (season.season_poster) {
    const seasonPosterPath = join(showPath, seasonName, "season_poster.jpg");
    updatedSeason.season_poster = await refreshImageUrlHash(season.season_poster, seasonPosterPath);
  }
  
  // Update episode thumbnails if available
  if (season.episodes) {
    const updatedEpisodes = { ...season.episodes };
    
    for (const [episodeKey, episode] of Object.entries(season.episodes)) {
      const updatedEpisode = { ...episode };
      
      // Update thumbnail URL if available
      if (episode.thumbnail) {
        // Extract episode number from key (e.g., "S01E02" -> "02")
        const episodeNumber = episodeKey.match(/E(\d+)/i)?.[1] || "";
        const thumbnailPath = join(showPath, seasonName, `${episodeNumber} - Thumbnail.jpg`);
        updatedEpisode.thumbnail = await refreshImageUrlHash(episode.thumbnail, thumbnailPath);
      }
      
      updatedEpisodes[episodeKey] = updatedEpisode;
    }
    
    updatedSeason.episodes = updatedEpisodes;
  }
  
  return updatedSeason;
}

export async function getTVShows(db) {
  const shows = await withRetry(() => db.all('SELECT * FROM tv_shows'));
  
  // Process each show to update image URL hashes
  const updatedShows = await Promise.all(shows.map(async (show) => {
    // Parse seasons now so we can update them
    const seasons = JSON.parse(show.seasons);
    const basePath = show.base_path;
    const showPath = join(basePath, 'tv', show.name);
    
    // Update show-level image URLs with fresh hashes
    const poster = await refreshImageUrlHash(show.poster, show.poster_file_path);
    const logo = await refreshImageUrlHash(show.logo, show.logo_file_path);
    const backdrop = await refreshImageUrlHash(show.backdrop, show.backdrop_file_path);
    
    // Update each season's image URLs
    const updatedSeasons = {};
    for (const [seasonName, season] of Object.entries(seasons)) {
      updatedSeasons[seasonName] = await refreshSeasonImageHashes(season, basePath, showPath, seasonName);
    }
    
    // Return updated show object
    return {
      id: show.id,
      name: show.name,
      metadata: show.metadata,
      metadata_path: show.metadata_path,
      poster: poster,
      posterBlurhash: show.posterBlurhash,
      logo: logo,
      logoBlurhash: show.logoBlurhash,
      backdrop: backdrop,
      backdropBlurhash: show.backdropBlurhash,
      seasons: updatedSeasons,
      posterFilePath: show.poster_file_path,
      backdropFilePath: show.backdrop_file_path,
      logoFilePath: show.logo_file_path,
      basePath: show.base_path
    };
  }));
  
  return updatedShows;
}

export async function getMovies(db) {
  const movies = await withRetry(() => db.all('SELECT * FROM movies'));
  
  // Process each movie to update image URL hashes
  const updatedMovies = await Promise.all(movies.map(async (movie) => {
    // Parse the URLs so we can update them
    const urls = JSON.parse(movie.urls);
    
    // Update image URLs with fresh hashes
    if (urls.poster) {
      urls.poster = await refreshImageUrlHash(urls.poster, movie.poster_file_path);
    }
    
    if (urls.logo) {
      urls.logo = await refreshImageUrlHash(urls.logo, movie.logo_file_path);
    }
    
    if (urls.backdrop) {
      urls.backdrop = await refreshImageUrlHash(urls.backdrop, movie.backdrop_file_path);
    }
    
    // Return updated movie object
    return {
      id: movie.id,
      name: movie.name,
      fileNames: JSON.parse(movie.file_names),
      lengths: JSON.parse(movie.lengths),
      dimensions: JSON.parse(movie.dimensions),
      urls: urls,
      metadataUrl: movie.metadata_url,
      directory_hash: movie.directory_hash,
      hdr: movie.hdr,
      mediaQuality: movie.media_quality ? JSON.parse(movie.media_quality) : null,
      additional_metadata: JSON.parse(movie.additional_metadata),
      _id: movie._id,
      posterFilePath: movie.poster_file_path,
      backdropFilePath: movie.backdrop_file_path,
      logoFilePath: movie.logo_file_path,
      basePath: movie.base_path
    };
  }));
  
  return updatedMovies;
}

export async function getMissingDataMedia(db) {
  const media = await withRetry(() => db.all('SELECT * FROM missing_data_media'));
  return media.map((item) => ({
    id: item.id,
    name: item.name,
    lastAttempt: item.last_attempt,
  }));
}

export async function getMovieById(db, id) {
  const movie = await withRetry(() => db.get('SELECT * FROM movies WHERE id = ?', [id]));
  if (movie) {
    // Parse the URLs so we can update them
    const urls = JSON.parse(movie.urls);
    
    // Update image URLs with fresh hashes
    if (urls.poster) {
      urls.poster = await refreshImageUrlHash(urls.poster, movie.poster_file_path);
    }
    
    if (urls.logo) {
      urls.logo = await refreshImageUrlHash(urls.logo, movie.logo_file_path);
    }
    
    if (urls.backdrop) {
      urls.backdrop = await refreshImageUrlHash(urls.backdrop, movie.backdrop_file_path);
    }
    
    return {
      id: movie.id,
      name: movie.name,
      fileNames: JSON.parse(movie.file_names),
      lengths: JSON.parse(movie.lengths),
      dimensions: JSON.parse(movie.dimensions),
      urls: urls,
      metadataUrl: movie.metadata_url,
      directory_hash: movie.directory_hash,
      hdr: movie.hdr,
      mediaQuality: movie.media_quality ? JSON.parse(movie.media_quality) : null,
      additional_metadata: JSON.parse(movie.additional_metadata),
      _id: movie._id,
      posterFilePath: movie.poster_file_path,
      backdropFilePath: movie.backdrop_file_path,
      logoFilePath: movie.logo_file_path,
      basePath: movie.base_path
    };
  }
  return null;
}

export async function getMovieByName(db, name) {
  const movie = await withRetry(() => db.get('SELECT * FROM movies WHERE name = ?', [name]));
  if (movie) {
    // Parse the URLs so we can update them
    const urls = JSON.parse(movie.urls);
    
    // Update image URLs with fresh hashes
    if (urls.poster) {
      urls.poster = await refreshImageUrlHash(urls.poster, movie.poster_file_path);
    }
    
    if (urls.logo) {
      urls.logo = await refreshImageUrlHash(urls.logo, movie.logo_file_path);
    }
    
    if (urls.backdrop) {
      urls.backdrop = await refreshImageUrlHash(urls.backdrop, movie.backdrop_file_path);
    }
    
    return {
      id: movie.id,
      name: movie.name,
      fileNames: JSON.parse(movie.file_names),
      lengths: JSON.parse(movie.lengths),
      dimensions: JSON.parse(movie.dimensions),
      urls: urls,
      metadataUrl: movie.metadata_url,
      directory_hash: movie.directory_hash,
      hdr: movie.hdr,
      mediaQuality: movie.media_quality ? JSON.parse(movie.media_quality) : null,
      additional_metadata: JSON.parse(movie.additional_metadata),
      _id: movie._id,
      posterFilePath: movie.poster_file_path,
      backdropFilePath: movie.backdrop_file_path,
      logoFilePath: movie.logo_file_path,
      basePath: movie.base_path
    };
  }
  return null;
}

export async function getTVShowById(db, id) {
  const show = await withRetry(() => db.get('SELECT * FROM tv_shows WHERE id = ?', [id]));
  if (show) {
    // Parse seasons now so we can update them
    const seasons = JSON.parse(show.seasons);
    const basePath = show.base_path;
    const showPath = join(basePath, 'tv', show.name);
    
    // Update show-level image URLs with fresh hashes
    const poster = await refreshImageUrlHash(show.poster, show.poster_file_path);
    const logo = await refreshImageUrlHash(show.logo, show.logo_file_path);
    const backdrop = await refreshImageUrlHash(show.backdrop, show.backdrop_file_path);
    
    // Update each season's image URLs
    const updatedSeasons = {};
    for (const [seasonName, season] of Object.entries(seasons)) {
      updatedSeasons[seasonName] = await refreshSeasonImageHashes(season, basePath, showPath, seasonName);
    }
    
    return {
      id: show.id,
      name: show.name,
      metadata: show.metadata,
      metadata_path: show.metadata_path,
      poster: poster,
      posterBlurhash: show.posterBlurhash,
      logo: logo,
      logoBlurhash: show.logoBlurhash,
      backdrop: backdrop,
      backdropBlurhash: show.backdropBlurhash,
      seasons: updatedSeasons,
      directory_hash: show.directory_hash,
      posterFilePath: show.poster_file_path,
      backdropFilePath: show.backdrop_file_path,
      logoFilePath: show.logo_file_path,
      basePath: show.base_path
    };
  }
  return null;
}

export async function getTVShowByName(db, name) {
  const show = await withRetry(() => db.get('SELECT * FROM tv_shows WHERE name = ?', [name]));
  if (show) {
    // Parse seasons now so we can update them
    const seasons = JSON.parse(show.seasons);
    const basePath = show.base_path;
    const showPath = join(basePath, 'tv', show.name);
    
    // Update show-level image URLs with fresh hashes
    const poster = await refreshImageUrlHash(show.poster, show.poster_file_path);
    const logo = await refreshImageUrlHash(show.logo, show.logo_file_path);
    const backdrop = await refreshImageUrlHash(show.backdrop, show.backdrop_file_path);
    
    // Update each season's image URLs
    const updatedSeasons = {};
    for (const [seasonName, season] of Object.entries(seasons)) {
      updatedSeasons[seasonName] = await refreshSeasonImageHashes(season, basePath, showPath, seasonName);
    }
    
    return {
      id: show.id,
      name: show.name,
      metadata: show.metadata,
      metadata_path: show.metadata_path,
      poster: poster,
      posterBlurhash: show.posterBlurhash,
      logo: logo,
      logoBlurhash: show.logoBlurhash,
      backdrop: backdrop,
      backdropBlurhash: show.backdropBlurhash,
      seasons: updatedSeasons,
      directory_hash: show.directory_hash,
      posterFilePath: show.poster_file_path,
      backdropFilePath: show.backdrop_file_path,
      logoFilePath: show.logo_file_path,
      basePath: show.base_path
    };
  }
  return null;
}

export async function isDatabaseEmpty(db, tableName = 'movies') {
  const row = await withRetry(() => db.get(`SELECT COUNT(*) as count FROM ${tableName}`));
  return row.count === 0;
}

export async function deleteMovie(db, name) {
  await withRetry(() => db.run('DELETE FROM movies WHERE name = ?', [name]));
}

export async function deleteTVShow(db, name) {
  await withRetry(() => db.run('DELETE FROM tv_shows WHERE name = ?', [name]));
}

/**
 * Execute multiple database operations in a single transaction.
 * @param {Object} db - SQLite database connection
 * @param {Function[]} operations - Array of functions that return Promises for DB operations
 * @param {boolean} readOnly - Whether the transaction is read-only (uses DEFERRED if true)
 * @returns {Promise<any[]>} - Array of results from each operation
 */
export async function withTransaction(db, operations, readOnly = false) {
  // Begin transaction with appropriate mode
  await db.exec('BEGIN' + (readOnly ? ' DEFERRED' : ''));
  
  try {
    const results = [];
    for (const op of operations) {
      results.push(await op());
    }
    await db.exec('COMMIT');
    return results;
  } catch (error) {
    // Always rollback on any error
    await db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Generate a cache key for TMDB API requests
 * @param {string} endpoint - TMDB API endpoint
 * @param {Object} params - Request parameters
 * @returns {string} - Cache key
 */
function generateTmdbCacheKey(endpoint, params = {}) {
  // Sort params for consistent cache keys
  const sortedParams = Object.keys(params)
    .sort()
    .reduce((result, key) => {
      result[key] = params[key];
      return result;
    }, {});
  
  return createHash('md5')
    .update(`${endpoint}:${JSON.stringify(sortedParams)}`)
    .digest('hex');
}

/**
 * Get cached TMDB response
 * @param {Object} db - SQLite database connection
 * @param {string} endpoint - TMDB API endpoint
 * @param {Object} params - Request parameters
 * @returns {Promise<Object|null>} - Cached response or null if not found/expired
 */
export async function getTmdbCache(db, endpoint, params = {}) {
  const cacheKey = generateTmdbCacheKey(endpoint, params);
  const now = new Date().toISOString();
  
  try {
    const cached = await withRetry(() =>
      db.get(
        'SELECT * FROM tmdb_cache WHERE cache_key = ? AND expires_at > ?',
        [cacheKey, now]
      )
    );
    
    if (cached) {
      // Update last accessed time
      await withRetry(() =>
        db.run(
          'UPDATE tmdb_cache SET last_accessed = ? WHERE cache_key = ?',
          [now, cacheKey]
        )
      );
      
      return {
        data: JSON.parse(cached.response_data),
        cached: true,
        cachedAt: cached.created_at,
        expiresAt: cached.expires_at
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error getting TMDB cache:', error);
    return null;
  }
}

/**
 * Store TMDB response in cache
 * @param {Object} db - SQLite database connection
 * @param {string} endpoint - TMDB API endpoint
 * @param {Object} params - Request parameters
 * @param {Object} responseData - TMDB API response data
 * @param {number} ttlHours - Time to live in hours (default: 1440 = 60 days)
 * @returns {Promise<void>}
 */
export async function setTmdbCache(db, endpoint, params = {}, responseData, ttlHours = 1440) {
  const cacheKey = generateTmdbCacheKey(endpoint, params);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (ttlHours * 60 * 60 * 1000));
  
  try {
    await withRetry(() =>
      db.run(
        `INSERT OR REPLACE INTO tmdb_cache
         (cache_key, endpoint, request_params, response_data, created_at, expires_at, last_accessed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          cacheKey,
          endpoint,
          JSON.stringify(params),
          JSON.stringify(responseData),
          now.toISOString(),
          expiresAt.toISOString(),
          now.toISOString()
        ]
      )
    );
  } catch (error) {
    console.error('Error setting TMDB cache:', error);
  }
}

/**
 * Clear expired TMDB cache entries
 * @param {Object} db - SQLite database connection
 * @returns {Promise<number>} - Number of entries deleted
 */
export async function clearExpiredTmdbCache(db) {
  const now = new Date().toISOString();
  
  try {
    const result = await withRetry(() =>
      db.run('DELETE FROM tmdb_cache WHERE expires_at <= ?', [now])
    );
    
    return result.changes || 0;
  } catch (error) {
    console.error('Error clearing expired TMDB cache:', error);
    return 0;
  }
}

/**
 * Clear all TMDB cache entries (admin function)
 * @param {Object} db - SQLite database connection
 * @param {string} pattern - Optional pattern to match endpoints (e.g., '/search/%')
 * @returns {Promise<number>} - Number of entries deleted
 */
export async function clearTmdbCache(db, pattern = null) {
  try {
    let result;
    if (pattern) {
      result = await withRetry(() =>
        db.run('DELETE FROM tmdb_cache WHERE endpoint LIKE ?', [pattern])
      );
    } else {
      result = await withRetry(() =>
        db.run('DELETE FROM tmdb_cache')
      );
    }
    
    return result.changes || 0;
  } catch (error) {
    console.error('Error clearing TMDB cache:', error);
    return 0;
  }
}

/**
 * Get TMDB cache statistics
 * @param {Object} db - SQLite database connection
 * @returns {Promise<Object>} - Cache statistics
 */
export async function getTmdbCacheStats(db) {
  try {
    const now = new Date().toISOString();
    
    const [total, expired, byEndpoint] = await Promise.all([
      withRetry(() => db.get('SELECT COUNT(*) as count FROM tmdb_cache')),
      withRetry(() => db.get('SELECT COUNT(*) as count FROM tmdb_cache WHERE expires_at <= ?', [now])),
      withRetry(() => db.all(`
        SELECT endpoint, COUNT(*) as count,
               MIN(created_at) as oldest,
               MAX(last_accessed) as most_recent
        FROM tmdb_cache
        WHERE expires_at > ?
        GROUP BY endpoint
        ORDER BY count DESC
      `, [now]))
    ]);
    
    return {
      total: total.count,
      expired: expired.count,
      active: total.count - expired.count,
      byEndpoint: byEndpoint
    };
  } catch (error) {
    console.error('Error getting TMDB cache stats:', error);
    return {
      total: 0,
      expired: 0,
      active: 0,
      byEndpoint: []
    };
  }
}

/**
 * Force refresh a specific TMDB cache entry
 * @param {Object} db - SQLite database connection
 * @param {string} endpoint - TMDB API endpoint
 * @param {Object} params - Request parameters
 * @returns {Promise<boolean>} - True if entry was deleted
 */
export async function refreshTmdbCacheEntry(db, endpoint, params = {}) {
  const cacheKey = generateTmdbCacheKey(endpoint, params);
  
  try {
    const result = await withRetry(() =>
      db.run('DELETE FROM tmdb_cache WHERE cache_key = ?', [cacheKey])
    );
    
    return (result.changes || 0) > 0;
  } catch (error) {
    console.error('Error refreshing TMDB cache entry:', error);
    return false;
  }
}
