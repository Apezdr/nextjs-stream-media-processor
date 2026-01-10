import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { initializeMetadataHashesTable } from './sqlite/metadataHashes.mjs';
import { initializeTmdbBlurhashCacheTable } from './sqlite/tmdbBlurhashCache.mjs';
import { initializeDiscordIntrosTable } from './sqlite/discordIntros.mjs';
import { createHash } from 'crypto';
import { fileExists } from './utils/utils.mjs';

// Singleton connections + per-DB write mutex to reduce SQLITE_BUSY under concurrency

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbDirectory = join(__dirname, 'db');
const dbFilePaths = {
  main: join(dbDirectory, 'media.db'),
  processTracking: join(dbDirectory, 'process_tracking.db'),
  tmdbCache: join(dbDirectory, 'tmdb_cache.db'),
  discordIntros: join(dbDirectory, 'discord_intros.db')
};

/**
 * Tiny async mutex. FIFO-ish fairness.
 */
class Mutex {
  constructor() {
    this._locked = false;
    this._waiters = [];
  }

  async runExclusive(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  acquire() {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve(() => this._release());
    }

    return new Promise((resolve) => {
      this._waiters.push(resolve);
    }).then(() => () => this._release());
  }

  _release() {
    const next = this._waiters.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }
}

// --- Singleton state ---
/** @type {Map<string, any>} */
const dbInstances = new Map();        // dbType -> db
const initPromises = new Map();       // dbType -> Promise<db>
const writeMutexes = new Map();       // dbType -> Mutex

function getWriteMutex(dbType) {
  let m = writeMutexes.get(dbType);
  if (!m) {
    m = new Mutex();
    writeMutexes.set(dbType, m);
  }
  return m;
}


async function applyPragmas(db) {
  // WAL: best general concurrency mode for "mostly reads, occasional writes"
  await db.exec("PRAGMA journal_mode = WAL");
  await db.exec("PRAGMA synchronous = NORMAL");

  // Let SQLite wait a bit before yelling BUSY.
  await db.exec("PRAGMA busy_timeout = 15000");

  // Keep WAL growth sane; default is often 1000 pages, we'll be explicit.
  await db.exec("PRAGMA wal_autocheckpoint = 1000");

  // Good hygiene
  await db.exec("PRAGMA foreign_keys = ON");
  await db.exec("PRAGMA temp_store = MEMORY");

  // Avoid giant per-connection caches. Leave default, or set modestly if needed.
  // await db.exec("PRAGMA cache_size = -8000"); // ~8MB (optional)
}

async function initializeSchema(dbType, db) {
  if (dbType === "main") {
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
        base_path TEXT,
        poster_hash TEXT,
        poster_mtime INTEGER,
        backdrop_hash TEXT,
        backdrop_mtime INTEGER,
        logo_hash TEXT,
        logo_mtime INTEGER
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
        base_path TEXT,
        poster_hash TEXT,
        poster_mtime INTEGER,
        backdrop_hash TEXT,
        backdrop_mtime INTEGER,
        logo_hash TEXT,
        logo_mtime INTEGER
      );
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS missing_data_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        last_attempt TEXT
      );
    `);

    // MIGRATE EXISTING DATABASES: Add hash columns if they don't exist
    await migrateToHashColumns(db);

    // Add unique indexes for UPSERT operations
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_movies_name ON movies(name);`);
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_tv_shows_name ON tv_shows(name);`);

    // Add performance indexes for hash-based conditional updates
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_movies_directory_hash ON movies(directory_hash);`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_tv_shows_directory_hash ON tv_shows(directory_hash);`);

    await initializeMetadataHashesTable(db);
    return;
  }

  if (dbType === "processTracking") {
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
    return;
  }

  if (dbType === "tmdbCache") {
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

    await db.exec(`CREATE INDEX IF NOT EXISTS idx_tmdb_cache_key ON tmdb_cache(cache_key);`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_tmdb_cache_expires ON tmdb_cache(expires_at);`);

    await initializeTmdbBlurhashCacheTable(db);
    return;
  }

  if (dbType === "discordIntros") {
    await initializeDiscordIntrosTable(db);
  }
}

/**
 * Migration function to add hash columns to existing databases
 * Safe to run multiple times - only adds columns if they don't exist
 */
async function migrateToHashColumns(db) {
  try {
    // Check if hash columns already exist by trying to select from one
    await db.get('SELECT poster_hash FROM movies LIMIT 1');
    // If we get here, columns already exist - no migration needed
    return;
  } catch (error) {
    if (error.message.includes('no such column')) {
      console.log('Migrating database: Adding image hash columns...');
      
      // Add hash columns to movies table
      const movieColumns = [
        'ADD COLUMN poster_hash TEXT',
        'ADD COLUMN poster_mtime INTEGER',
        'ADD COLUMN backdrop_hash TEXT', 
        'ADD COLUMN backdrop_mtime INTEGER',
        'ADD COLUMN logo_hash TEXT',
        'ADD COLUMN logo_mtime INTEGER'
      ];
      
      for (const column of movieColumns) {
        try {
          await db.exec(`ALTER TABLE movies ${column}`);
        } catch (err) {
          // Ignore errors if column already exists
          if (!err.message.includes('duplicate column name')) {
            throw err;
          }
        }
      }
      
      // Add hash columns to tv_shows table
      const tvShowColumns = [
        'ADD COLUMN poster_hash TEXT',
        'ADD COLUMN poster_mtime INTEGER', 
        'ADD COLUMN backdrop_hash TEXT',
        'ADD COLUMN backdrop_mtime INTEGER',
        'ADD COLUMN logo_hash TEXT',
        'ADD COLUMN logo_mtime INTEGER'
      ];
      
      for (const column of tvShowColumns) {
        try {
          await db.exec(`ALTER TABLE tv_shows ${column}`);
        } catch (err) {
          // Ignore errors if column already exists
          if (!err.message.includes('duplicate column name')) {
            throw err;
          }
        }
      }
      
      console.log('Database migration complete: Hash columns added successfully');
    } else {
      // Some other error occurred
      throw error;
    }
  }
}

/**
 * One-time init per dbType, safe under concurrency.
 */
async function getOrInitDb(dbType = "main") {
  if (isClosing) throw new Error("DB layer is shutting down");
  
  if (dbInstances.has(dbType)) return dbInstances.get(dbType);

  if (initPromises.has(dbType)) return initPromises.get(dbType);

  const filename = dbFilePaths[dbType];
  if (!filename) throw new Error(`Unknown dbType "${dbType}"`);

  const p = (async () => {
    let db;
    try {
      await fs.mkdir(dbDirectory, { recursive: true });

      db = await open({ filename, driver: sqlite3.Database });

      // Helpful when you're diagnosing "where did this busy come from?"
      // db.on("trace", console.log);

      await applyPragmas(db);
      await initializeSchema(dbType, db);

      dbInstances.set(dbType, db);
      return db;
    } catch (error) {
      // Close the connection if initialization fails to prevent leaks
      if (db) {
        try {
          await db.close();
        } catch {}
      }
      throw error;
    }
  })().finally(() => {
    initPromises.delete(dbType);
  });

  initPromises.set(dbType, p);
  return p;
}

/**
 * Retries for lock contention cases that are common in WAL or under high write load.
 */
const RETRYABLE = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED"]);

export async function withRetry(operation, maxRetries = 15, initialDelayMs = 200) {
  let attempt = 0;
  let delay = initialDelayMs;

  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (error) {
      if (RETRYABLE.has(error?.code)) {
        attempt++;
        delay = Math.min(delay * 1.5, 5000) * (0.9 + Math.random() * 0.2);
        console.warn(
          `${error.code} encountered. Retrying ${attempt}/${maxRetries} after ${Math.round(delay)}ms...`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error("Operation failed after maximum retries");
}

/**
 * Basic access helper (reads are fine here).
 */
export async function withDb(dbType, fn) {
  if (!dbFilePaths[dbType]) throw new Error(`Unknown dbType: ${dbType}`);
  const db = await getOrInitDb(dbType);
  return fn(db);
}

/**
 * Serialize writes per DB file (this is the big win).
 */
export async function withWrite(dbType, fn) {
  if (!dbFilePaths[dbType]) throw new Error(`Unknown dbType: ${dbType}`);
  const mutex = getWriteMutex(dbType);
  return mutex.runExclusive(async () => {
    const db = await getOrInitDb(dbType);
    return fn(db);
  });
}

/**
 * Transaction helper
 * - readOnly: BEGIN (deferred)
 * - writes:   BEGIN IMMEDIATE (acquire write intent early)
 */
export async function withTransaction(db, fn, { readOnly = false } = {}) {
  await db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
  try {
    const result = await fn(db);
    await db.exec("COMMIT");
    return result;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Convenience: serialized + transactional write.
 */
export async function withWriteTx(dbType, fn) {
  if (!dbFilePaths[dbType]) throw new Error(`Unknown dbType: ${dbType}`);
  return withWrite(dbType, async (db) =>
    withTransaction(db, () => fn(db), { readOnly: false })
  );
}

let isClosing = false;

export async function closeAllDatabaseConnections() {
  isClosing = true;
  
  // Clear initPromises to prevent new connections during shutdown
  initPromises.clear();
  
  const closes = [];
  for (const [dbType, db] of dbInstances.entries()) {
    closes.push(
      (async () => {
        // Optional: shrink WAL on shutdown (helps keep files tidy)
        try {
          await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {}
        await db.close();
      })()
    );
    dbInstances.delete(dbType);
  }
  
  await Promise.allSettled(closes);
}

// For backward compatibility with existing code
export async function initializeDatabase(dbType = 'main') {
  return getOrInitDb(dbType);
}

export async function releaseDatabase(db) {
  // This is a no-op in the singleton model, but kept for backward compatibility
  return;
}

/**
 * Safe JSON parse helper that tolerates null/malformed values
 * @param {string} jsonString - JSON string to parse
 * @param {any} fallback - Fallback value if parsing fails
 * @returns {any} - Parsed object or fallback
 */
function safeJson(jsonString, fallback) {
  try {
    return jsonString ? JSON.parse(jsonString) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Calculate and cache image hash during sync/insert operations
 * Only recalculates if file mtime has changed since last cache
 * @param {string} filePath - Path to the image file
 * @param {string} cachedHash - Previously cached hash (optional)
 * @param {number} cachedMtime - Previously cached mtime (optional)
 * @returns {Object} - { hash: string | null, mtime: number | null }
 */
async function calculateImageHash(filePath, cachedHash = null, cachedMtime = null) {
  if (!filePath) return { hash: null, mtime: null };
  
  try {
    const stats = await fs.stat(filePath);
    const currentMtime = Math.floor(stats.mtimeMs);
    
    // If we have a cached hash and mtime hasn't changed, use cached version
    if (cachedHash && cachedMtime && cachedMtime === currentMtime) {
      return { hash: cachedHash, mtime: currentMtime };
    }
    
    // Calculate new hash based on mtime
    const hash = createHash('md5')
      .update(String(currentMtime))
      .digest('hex')
      .substring(0, 10);
    
    return { hash, mtime: currentMtime };
  } catch {
    return { hash: null, mtime: null };
  }
}

/**
 * Build URL with cached hash - NO filesystem access required
 * @param {string} baseUrl - The base image URL
 * @param {string} cachedHash - Previously calculated hash from database
 * @returns {string} - URL with hash parameter or original URL if no hash
 */
function buildImageUrl(baseUrl, cachedHash) {
  if (!baseUrl || !cachedHash) return baseUrl;
  
  // If the URL already has a hash parameter, replace it
  if (baseUrl.includes('?hash=')) {
    return baseUrl.replace(/\?hash=[a-f0-9]+/, `?hash=${cachedHash}`);
  }
  // Otherwise, add the hash parameter
  else {
    return `${baseUrl}?hash=${cachedHash}`;
  }
}

/**
 * Legacy function for season/episode images that aren't cached in database yet
 * TODO: Remove this when episode normalization is complete
 * @param {string} url - The original image URL
 * @param {string} filePath - Path to the actual image file
 * @returns {string} - Updated URL with a fresh hash parameter
 */
async function refreshImageUrlHash(url, filePath) {
  // If there's no file path or URL, return the original URL
  if (!filePath || !url) return url;
  
  try {
    // Get the file's current stats (consolidated - one syscall instead of two)
    const stats = await fs.stat(filePath);
    // Create a hash from the modification time
    const imageHash = createHash('md5')
      .update(stats.mtime.toISOString())
      .digest('hex')
      .substring(0, 10);
    
    // If the URL already has a hash parameter, replace it
    if (url.includes('?hash=')) {
      return url.replace(/\?hash=[a-f0-9]+/, `?hash=${imageHash}`);
    }
    // Otherwise, add the hash parameter
    else {
      return `${url}?hash=${imageHash}`;
    }
  } catch {
    // Return the original URL if file doesn't exist or other error
    return url;
  }
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

export async function getTVShows() {
  return withDb("main", async (db) => {
    const shows = await withRetry(() => db.all('SELECT * FROM tv_shows'));
    
    // Process each show using CACHED hashes for show-level images (NO filesystem I/O)
    const updatedShows = await Promise.all(shows.map(async (show) => {
      // Parse seasons now so we can update them
      const seasons = safeJson(show.seasons, {});
      const basePath = show.base_path;
      const showPath = join(basePath, 'tv', show.name);
      
      // Update show-level image URLs with CACHED hashes (massive performance improvement)
      const poster = buildImageUrl(show.poster, show.poster_hash);
      const logo = buildImageUrl(show.logo, show.logo_hash);
      const backdrop = buildImageUrl(show.backdrop, show.backdrop_hash);
      
      // Update each season's image URLs (still uses filesystem I/O - will optimize in episode normalization phase)
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
  });
}

export async function getMovies() {
  return withDb("main", async (db) => {
    const movies = await withRetry(() => db.all('SELECT * FROM movies'));
    
    // Process each movie using CACHED hashes (NO filesystem I/O)
    const updatedMovies = movies.map((movie) => {
      // Parse the URLs so we can update them
      const urls = safeJson(movie.urls, {});
      
      // Update image URLs with CACHED hashes (massive performance improvement)
      if (urls.poster) {
        urls.poster = buildImageUrl(urls.poster, movie.poster_hash);
      }
      
      if (urls.logo) {
        urls.logo = buildImageUrl(urls.logo, movie.logo_hash);
      }
      
      if (urls.backdrop) {
        urls.backdrop = buildImageUrl(urls.backdrop, movie.backdrop_hash);
      }
      
      // Return updated movie object
      return {
        id: movie.id,
        name: movie.name,
        fileNames: safeJson(movie.file_names, []),
        lengths: safeJson(movie.lengths, []),
        dimensions: safeJson(movie.dimensions, []),
        urls: urls,
        metadataUrl: movie.metadata_url,
        directory_hash: movie.directory_hash,
        hdr: movie.hdr,
        mediaQuality: safeJson(movie.media_quality, null),
        additional_metadata: safeJson(movie.additional_metadata, {}),
        _id: movie._id,
        posterFilePath: movie.poster_file_path,
        backdropFilePath: movie.backdrop_file_path,
        logoFilePath: movie.logo_file_path,
        basePath: movie.base_path
      };
    });
    
    return updatedMovies;
  });
}

export async function getMissingDataMedia() {
  return withDb("main", async (db) => {
    const media = await withRetry(() => db.all('SELECT * FROM missing_data_media'));
    return media.map((item) => ({
      id: item.id,
      name: item.name,
      lastAttempt: item.last_attempt,
    }));
  });
}

export async function getMovieById(id) {
  return withDb("main", async (db) => {
    const movie = await withRetry(() => db.get('SELECT * FROM movies WHERE id = ?', [id]));
    if (movie) {
      // Parse the URLs so we can update them
      const urls = safeJson(movie.urls, {});
      
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
        fileNames: safeJson(movie.file_names, []),
        lengths: safeJson(movie.lengths, []),
        dimensions: safeJson(movie.dimensions, []),
        urls: urls,
        metadataUrl: movie.metadata_url,
        directory_hash: movie.directory_hash,
        hdr: movie.hdr,
        mediaQuality: safeJson(movie.media_quality, null),
        additional_metadata: safeJson(movie.additional_metadata, {}),
        _id: movie._id,
        posterFilePath: movie.poster_file_path,
        backdropFilePath: movie.backdrop_file_path,
        logoFilePath: movie.logo_file_path,
        basePath: movie.base_path
      };
    }
    return null;
  });
}

export async function getMovieByName(name) {
  return withDb("main", async (db) => {
    const movie = await withRetry(() => db.get('SELECT * FROM movies WHERE name = ?', [name]));
    if (movie) {
      // Parse the URLs so we can update them
      const urls = safeJson(movie.urls, {});
      
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
        fileNames: safeJson(movie.file_names, []),
        lengths: safeJson(movie.lengths, []),
        dimensions: safeJson(movie.dimensions, []),
        urls: urls,
        metadataUrl: movie.metadata_url,
        directory_hash: movie.directory_hash,
        hdr: movie.hdr,
        mediaQuality: safeJson(movie.media_quality, null),
        additional_metadata: safeJson(movie.additional_metadata, {}),
        _id: movie._id,
        posterFilePath: movie.poster_file_path,
        backdropFilePath: movie.backdrop_file_path,
        logoFilePath: movie.logo_file_path,
        basePath: movie.base_path
      };
    }
    return null;
  });
}

export async function getTVShowById(id) {
  return withDb("main", async (db) => {
    const show = await withRetry(() => db.get('SELECT * FROM tv_shows WHERE id = ?', [id]));
    if (show) {
      // Parse seasons now so we can update them
      const seasons = safeJson(show.seasons, {});
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
  });
}

export async function getTVShowByName(name) {
  return withDb("main", async (db) => {
    const show = await withRetry(() => db.get('SELECT * FROM tv_shows WHERE name = ?', [name]));
    if (show) {
      // Parse seasons now so we can update them
      const seasons = safeJson(show.seasons, {});
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
  });
}

export async function isDatabaseEmpty(tableName = 'movies') {
  // Whitelist allowed tables for security
  const ALLOWED_TABLES = new Set(["movies", "tv_shows", "missing_data_media"]);
  if (!ALLOWED_TABLES.has(tableName)) throw new Error("Invalid table");
  
  return withDb("main", async (db) => {
    const row = await withRetry(() => db.get(`SELECT COUNT(*) as count FROM ${tableName}`));
    return row.count === 0;
  });
}

export async function deleteMovie(name) {
  return withWriteTx("main", async (db) => {
    await withRetry(() => db.run('DELETE FROM movies WHERE name = ?', [name]));
  });
}

export async function deleteTVShow(name) {
  return withWriteTx("main", async (db) => {
    await withRetry(() => db.run('DELETE FROM tv_shows WHERE name = ?', [name]));
  });
}

export async function insertOrUpdateTVShow(
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
  return withWriteTx("main", async (db) => {
    // Get current cached values for comparison (if updating existing TV show)
    const existing = await withRetry(() => 
      db.get('SELECT poster_hash, poster_mtime, backdrop_hash, backdrop_mtime, logo_hash, logo_mtime FROM tv_shows WHERE name = ?', [showName])
    );

    // Calculate image hashes during write
    const posterHash = await calculateImageHash(posterFilePath, existing?.poster_hash, existing?.poster_mtime);
    const backdropHash = await calculateImageHash(backdropFilePath, existing?.backdrop_hash, existing?.backdrop_mtime);
    const logoHash = await calculateImageHash(logoFilePath, existing?.logo_hash, existing?.logo_mtime);

    const seasonsStr = JSON.stringify(seasonsObj);
    
    await withRetry(() =>
      db.run(
        `INSERT INTO tv_shows (
          name, metadata, metadata_path, poster, posterBlurhash, logo, logoBlurhash,
          backdrop, backdropBlurhash, seasons,
          poster_file_path, backdrop_file_path, logo_file_path, base_path,
          poster_hash, poster_mtime, backdrop_hash, backdrop_mtime, logo_hash, logo_mtime
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          metadata=excluded.metadata,
          metadata_path=excluded.metadata_path,
          poster=excluded.poster,
          posterBlurhash=excluded.posterBlurhash,
          logo=excluded.logo,
          logoBlurhash=excluded.logoBlurhash,
          backdrop=excluded.backdrop,
          backdropBlurhash=excluded.backdropBlurhash,
          seasons=excluded.seasons,
          poster_file_path=excluded.poster_file_path,
          backdrop_file_path=excluded.backdrop_file_path,
          logo_file_path=excluded.logo_file_path,
          base_path=excluded.base_path,
          poster_hash=excluded.poster_hash,
          poster_mtime=excluded.poster_mtime,
          backdrop_hash=excluded.backdrop_hash,
          backdrop_mtime=excluded.backdrop_mtime,
          logo_hash=excluded.logo_hash,
          logo_mtime=excluded.logo_mtime`,
        [
          showName, metadata, metadataPath, poster, posterBlurhash, logo, logoBlurhash, backdrop, backdropBlurhash, seasonsStr,
          posterFilePath, backdropFilePath, logoFilePath, basePath,
          posterHash.hash, posterHash.mtime, backdropHash.hash, backdropHash.mtime, logoHash.hash, logoHash.mtime
        ]
      )
    );
  });
}

export async function insertOrUpdateMovie(
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
  return withWriteTx("main", async (db) => {
    // Get current cached values for comparison (if updating existing movie)
    const existing = await withRetry(() => 
      db.get('SELECT poster_hash, poster_mtime, backdrop_hash, backdrop_mtime, logo_hash, logo_mtime FROM movies WHERE name = ?', [name])
    );

    // Calculate image hashes during write
    const posterHash = await calculateImageHash(posterFilePath, existing?.poster_hash, existing?.poster_mtime);
    const backdropHash = await calculateImageHash(backdropFilePath, existing?.backdrop_hash, existing?.backdrop_mtime);
    const logoHash = await calculateImageHash(logoFilePath, existing?.logo_hash, existing?.logo_mtime);

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
      base_path: basePath,
      poster_hash: posterHash.hash,
      poster_mtime: posterHash.mtime,
      backdrop_hash: backdropHash.hash,
      backdrop_mtime: backdropHash.mtime,
      logo_hash: logoHash.hash,
      logo_mtime: logoHash.mtime
    };

    await withRetry(() =>
      db.run(
        `INSERT INTO movies (
          name, file_names, lengths, dimensions, urls, metadata_url, directory_hash, 
          hdr, media_quality, additional_metadata, _id,
          poster_file_path, backdrop_file_path, logo_file_path, base_path,
          poster_hash, poster_mtime, backdrop_hash, backdrop_mtime, logo_hash, logo_mtime
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          file_names=excluded.file_names,
          lengths=excluded.lengths,
          dimensions=excluded.dimensions,
          urls=excluded.urls,
          metadata_url=excluded.metadata_url,
          directory_hash=excluded.directory_hash,
          hdr=excluded.hdr,
          media_quality=excluded.media_quality,
          additional_metadata=excluded.additional_metadata,
          _id=excluded._id,
          poster_file_path=excluded.poster_file_path,
          backdrop_file_path=excluded.backdrop_file_path,
          logo_file_path=excluded.logo_file_path,
          base_path=excluded.base_path,
          poster_hash=excluded.poster_hash,
          poster_mtime=excluded.poster_mtime,
          backdrop_hash=excluded.backdrop_hash,
          backdrop_mtime=excluded.backdrop_mtime,
          logo_hash=excluded.logo_hash,
          logo_mtime=excluded.logo_mtime
        WHERE movies.directory_hash IS NULL OR movies.directory_hash <> excluded.directory_hash`,
        [
          name,
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
          posterHash.hash,
          posterHash.mtime,
          backdropHash.hash,
          backdropHash.mtime,
          logoHash.hash,
          logoHash.mtime
        ]
      )
    );
  });
}

export async function insertOrUpdateMissingDataMedia(name) {
  return withWriteTx("main", async (db) => {
    const now = new Date().toISOString();
    
    await withRetry(() =>
      db.run(
        `INSERT INTO missing_data_media (name, last_attempt) 
         VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET
         last_attempt = excluded.last_attempt`,
        [name, now]
      )
    );
  });
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

export async function getTmdbCache(endpoint, params = {}, customCacheKey = null) {
  return withDb("tmdbCache", async (db) => {
    const cacheKey = customCacheKey || generateTmdbCacheKey(endpoint, params);
    const now = new Date().toISOString();
    
    try {
      const cached = await withRetry(() =>
        db.get(
          'SELECT * FROM tmdb_cache WHERE cache_key = ? AND expires_at > ?',
          [cacheKey, now]
        )
      );
      
      if (cached) {
        // Note: We skip updating last_accessed here to avoid write contention on read path
        // Rely on created_at/expires_at for cache management
        
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
  });
}

export async function setTmdbCache(endpoint, params = {}, responseData, ttlHours = 1440, customCacheKey = null) {
  return withWriteTx("tmdbCache", async (db) => {
    const cacheKey = customCacheKey || generateTmdbCacheKey(endpoint, params);
    const now = new Date();
    
    // Validate ttlHours to prevent invalid Date objects
    const validTtl = (typeof ttlHours === 'number' && isFinite(ttlHours) && ttlHours > 0) ? ttlHours : 1440;
    const expiresAt = new Date(now.getTime() + (validTtl * 60 * 60 * 1000));
    
    // Sanity check: if expiresAt is invalid, log and skip
    if (!isFinite(expiresAt.getTime())) {
      console.error(`Invalid expiresAt calculated for ${endpoint} with ttlHours=${ttlHours}`);
      return;
    }
    
    try {
      await withRetry(() =>
        db.run(
          `INSERT INTO tmdb_cache (
            cache_key, endpoint, request_params, response_data, created_at, expires_at, last_accessed
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET
            endpoint = excluded.endpoint,
            request_params = excluded.request_params,
            response_data = excluded.response_data,
            expires_at = excluded.expires_at,
            last_accessed = excluded.last_accessed`,
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
  });
}

export async function clearExpiredTmdbCache() {
  return withWriteTx("tmdbCache", async (db) => {
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
  });
}

export async function clearTmdbCache(pattern = null) {
  return withWriteTx("tmdbCache", async (db) => {
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
  });
}

export async function getTmdbCacheStats() {
  return withDb("tmdbCache", async (db) => {
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
  });
}

export async function refreshTmdbCacheEntry(endpoint, params = {}) {
  return withWriteTx("tmdbCache", async (db) => {
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
  });
}
