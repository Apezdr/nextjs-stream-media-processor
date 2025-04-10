import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { initializeMetadataHashesTable } from './sqlite/metadataHashes.mjs';
import { createHash } from 'crypto';
import { fileExists } from './utils/utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbDirectory = join(__dirname, 'db');
const dbFilePath = join(dbDirectory, 'media.db');

var hasInitialized = false;

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

export async function initializeDatabase() {
  // Create the db directory if it doesn't exist
  await fs.mkdir(dbDirectory, { recursive: true });
  const db = await open({ filename: dbFilePath, driver: sqlite3.Database });
  
  // Enable WAL mode for better concurrency
  await db.exec('PRAGMA journal_mode = WAL');
  
  // Optimize synchronous setting for better performance with WAL
  await db.exec('PRAGMA synchronous = NORMAL');
  
  // Increase SQLite busy timeout to reduce SQLITE_BUSY errors
  await db.exec('PRAGMA busy_timeout = 15000');
  
  if (!hasInitialized) {
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
    
    // Initialize metadata_hashes table
    await initializeMetadataHashesTable(db);
    
    hasInitialized = true;
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
