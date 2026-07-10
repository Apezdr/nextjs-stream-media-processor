import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { withDbQuerySpan, withDbTransactionSpan, withDbConnectionSpan } from './lib/dbTracer.mjs';
import { initializeMetadataHashesTable } from './sqlite/metadataHashes.mjs';
import { initializeTmdbBlurhashCacheTable } from './sqlite/tmdbBlurhashCache.mjs';
import { initializeDiscordIntrosTable } from './sqlite/discordIntros.mjs';
import { createHash } from 'crypto';
import { fileExists } from './utils/utils.mjs';

// Singleton connections + per-DB write mutex to reduce SQLITE_BUSY under concurrency

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// MEDIA_DB_DIRECTORY is a test seam (unit tests point the SQLite layer at a
// temp directory so schema/upsert tests never touch the real node/db files).
// Production deployments should leave it unset and use the default location.
const dbDirectory = process.env.MEDIA_DB_DIRECTORY || join(__dirname, 'db');
const dbFilePaths = {
  main: join(dbDirectory, 'media.db'),
  processTracking: join(dbDirectory, 'process_tracking.db'),
  tmdbCache: join(dbDirectory, 'tmdb_cache.db'),
  discordIntros: join(dbDirectory, 'discord_intros.db')
};

/**
 * Tiny async mutex. FIFO-ish fairness.
 *
 * Note: No deadlock detection or timeout. If a callback throws in a way that
 * prevents `finally` from running (e.g., native addon crash), the mutex locks
 * permanently. Consider adding a safety timeout for production if this becomes
 * a concern.
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

// Exported for schema tests (fresh-DB vs. migrated-DB convergence). Runtime
// callers go through getOrInitDb/initializeDatabase, never call this directly.
export async function initializeSchema(dbType, db) {
  if (dbType === "main") {
    // P-1c: the AUTOINCREMENT `id` on movies/tv_shows is a surrogate key that
    // never crosses a module boundary — stable external references key on
    // `name` or the TMDB-derived `_id`, never this `id` (it does not survive
    // a media.db rebuild).
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
        logo_mtime INTEGER,
        backdrop_focal TEXT,
        backdrop_focal_suggested TEXT,
        metadata TEXT,           -- F-1: canonical metadata.json fingerprint (see movie-scanner.mjs)
        pristine_metadata TEXT,  -- G-5: raw pre-override TMDB payload (trust semantics = Branch 2)
        -- I-3: *_source_url added now only so this table isn't altered a third
        -- time later; population + URL-mismatch-means-stale reconcile logic are
        -- a separate decided branch and are deliberately NOT wired yet.
        poster_source_url TEXT,
        backdrop_source_url TEXT,
        logo_source_url TEXT
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
        logo_mtime INTEGER,
        backdrop_focal TEXT,
        backdrop_focal_suggested TEXT,
        pristine_metadata TEXT,  -- G-5: raw pre-override TMDB payload (trust semantics = Branch 2)
        -- I-3: *_source_url added now only so this table isn't altered a third
        -- time later; population + URL-mismatch-means-stale reconcile logic are
        -- a separate decided branch and are deliberately NOT wired yet.
        poster_source_url TEXT,
        backdrop_source_url TEXT,
        logo_source_url TEXT
      );
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS missing_data_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        last_attempt TEXT
      );
    `);

    // Per-episode cooldown for the air-date-aware backfill of missing/thin
    // episode metadata. Distinct from missing_data_media (show-level): keyed by
    // (show, season, episode) so one freshly-aired episode is retried on its own
    // cadence without re-hammering the rest of the show. See
    // plans/AIR_DATE_AWARE_EPISODE_BACKFILL.md.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS episode_metadata_missing (
        show_name TEXT,
        season_number INTEGER,
        episode_number INTEGER,
        air_date TEXT,
        last_attempt TEXT,
        attempts INTEGER DEFAULT 0,
        PRIMARY KEY (show_name, season_number, episode_number)
      );
    `);

    // MIGRATE EXISTING DATABASES: Add hash columns if they don't exist
    await migrateToHashColumns(db);
    await migrateToFocalColumns(db);
    await migrateToSchemaParityColumns(db);

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
        last_accessed TEXT DEFAULT CURRENT_TIMESTAMP,
        etag TEXT
      );
    `);

    // T-1: the etag column joined CREATE TABLE above for fresh databases;
    // this ALTER converges databases created before it existed.
    try {
      await db.exec(`ALTER TABLE tmdb_cache ADD COLUMN etag TEXT`);
    } catch (err) {
      if (!err.message.includes('duplicate column name')) throw err;
    }

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
 * Migration function to add backdrop focal columns to existing databases
 * Safe to run multiple times - ignores duplicate column name errors
 */
async function migrateToFocalColumns(db) {
  const columns = [
    ['movies',   'backdrop_focal TEXT'],
    ['movies',   'backdrop_focal_suggested TEXT'],
    ['tv_shows', 'backdrop_focal TEXT'],
    ['tv_shows', 'backdrop_focal_suggested TEXT'],
  ];
  for (const [table, col] of columns) {
    try {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
    } catch (err) {
      if (!err.message.includes('duplicate column name')) throw err;
    }
  }
}

/**
 * Migration function for the Branch 1 "movies table schema parity" columns
 * (G-5 + F-1 + I-3, decided 2026-07-07). ALTER TABLE ADD COLUMN only — safe on
 * a live DB, no rewrites. Safe to run multiple times - ignores duplicate
 * column name errors. Exported for schema tests (idempotency / convergence).
 *
 *  - movies.metadata (F-1): the canonically-serialized metadata.json content
 *    fingerprint the scanner persists so BOTH movie-hash writers (scanner
 *    inline path and the scheduled updateAllMovieHashes sweep) fold identical
 *    content into generateMovieHashes. tv_shows already has `metadata`.
 *  - pristine_metadata (G-5, both tables): raw pre-override TMDB payload from
 *    a genuine fetch, persisted opaquely. Trust/merge semantics are Branch 2.
 *  - *_source_url (I-3, both tables): the upstream TMDB image URL each managed
 *    image was downloaded from, mirroring the *_hash/*_mtime provenance
 *    pattern. Added NOW only so these two tables are not altered a third time
 *    later — their population and the URL-mismatch-means-stale reconcile logic
 *    are a separate decided branch and are deliberately NOT wired here.
 */
export async function migrateToSchemaParityColumns(db) {
  const columns = [
    ['movies',   'metadata TEXT'],
    ['movies',   'pristine_metadata TEXT'],
    ['movies',   'poster_source_url TEXT'],
    ['movies',   'backdrop_source_url TEXT'],
    ['movies',   'logo_source_url TEXT'],
    ['tv_shows', 'pristine_metadata TEXT'],
    ['tv_shows', 'poster_source_url TEXT'],
    ['tv_shows', 'backdrop_source_url TEXT'],
    ['tv_shows', 'logo_source_url TEXT'],
  ];
  for (const [table, col] of columns) {
    try {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
    } catch (err) {
      if (!err.message.includes('duplicate column name')) throw err;
    }
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

  const p = withDbConnectionSpan({
    system: 'sqlite',
    dbName: dbType,
    path: filename
  }, async () => {
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
  }).finally(() => {
    initPromises.delete(dbType);
  });

  initPromises.set(dbType, p);
  return p;
}

/**
 * Retries for lock contention cases that are common in WAL or under high write load.
 *
 * IMPORTANT: Should NOT be used inside withWriteTx, as the mutex already prevents
 * contention from same process. Use only at the outer withDb (read) layer.
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
  
  // For read operations, use a generic read span without SQL details
  // as we don't know what queries will be run inside the callback
  return withDbQuerySpan({
    system: 'sqlite',
    dbName: dbType,
    operation: 'READ',
  }, async () => {
    return fn(db);
  });
}

/**
 * Serialize writes per DB file (this is the big win).
 */
export async function withWrite(dbType, fn) {
  if (!dbFilePaths[dbType]) throw new Error(`Unknown dbType: ${dbType}`);
  const mutex = getWriteMutex(dbType);
  
  return withDbQuerySpan({
    system: 'sqlite',
    dbName: dbType,
    operation: 'WRITE',
  }, async () => {
    return mutex.runExclusive(async () => {
      const db = await getOrInitDb(dbType);
      return fn(db);
    });
  });
}

/**
 * Transaction helper
 * - readOnly: BEGIN (deferred)
 * - writes:   BEGIN IMMEDIATE (acquire write intent early)
 *
 * Note: BEGIN IMMEDIATE is technically redundant since withWrite already serializes
 * via mutex, but it provides defense-in-depth if the mutex is ever bypassed and
 * has negligible performance cost.
 */
export async function withTransaction(db, fn, { readOnly = false } = {}) {
  return withDbTransactionSpan({
    system: 'sqlite',
    type: readOnly ? 'read-only' : 'read-write',
  }, async () => {
    await withDbQuerySpan({
      system: 'sqlite',
      operation: 'BEGIN',
      sql: readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE'
    }, async () => {
      return db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    });
    
    try {
      const result = await fn(db);
      
      await withDbQuerySpan({
        system: 'sqlite',
        operation: 'COMMIT',
        sql: 'COMMIT'
      }, async () => {
        return db.exec("COMMIT");
      });
      
      return result;
    } catch (e) {
      await withDbQuerySpan({
        system: 'sqlite',
        operation: 'ROLLBACK',
        sql: 'ROLLBACK'
      }, async () => {
        return db.exec("ROLLBACK");
      });
      
      throw e;
    }
  });
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

export async function getTVShows() {
  return withDb("main", async (db) => {
    const shows = await withRetry(() => db.all('SELECT * FROM tv_shows'));
    
    // Process each show using CACHED hashes for ALL images (NO filesystem I/O)
    const updatedShows = shows.map((show) => {
      // Parse seasons from JSON
      const seasons = safeJson(show.seasons, {});
      
      // Update show-level image URLs with CACHED hashes
      const poster = buildImageUrl(show.poster, show.poster_hash);
      const logo = buildImageUrl(show.logo, show.logo_hash);
      const backdrop = buildImageUrl(show.backdrop, show.backdrop_hash);
      
      // Use seasons directly - URLs already contain cached hashes from scanner
      // Scanner embeds hashes during write (see tv-scanner.mjs lines 264-274, 357-366)
      // No filesystem I/O needed - massive performance improvement!
      
      // Return updated show object
      return {
        id: show.id,
        name: show.name,
        metadata: show.metadata,
        // Cache-bust metadata.json by URL the same way images are (and the same
        // way getMovies* cache-busts urls.metadata). The frontend keys its
        // metadata fetch cache by URL, so without a version token a content
        // change is served stale from its Redis/304 cache. directory_hash moves
        // whenever anything in the show dir changes (incl. a metadata.json
        // rewrite), so it's a zero-cost version token.
        metadata_path: buildImageUrl(show.metadata_path, show.directory_hash),
        poster: poster,
        posterBlurhash: show.posterBlurhash,
        logo: logo,
        logoBlurhash: show.logoBlurhash,
        backdrop: backdrop,
        backdropBlurhash: show.backdropBlurhash,
        seasons: seasons,
        posterFilePath: show.poster_file_path,
        backdropFilePath: show.backdrop_file_path,
        logoFilePath: show.logo_file_path,
        basePath: show.base_path,
        backdropFocal: show.backdrop_focal ?? null,
        backdropFocalSuggested: show.backdrop_focal_suggested ?? null,
        // Internal-only (G-5): raw pre-override TMDB payload. Never serialized
        // to /media/tv — the app.mjs handler allowlist drops it.
        pristineMetadata: show.pristine_metadata ?? null
      };
    });

    return updatedShows;
  });
}

/**
 * Lightweight query returning only TV show names and directory hashes.
 * Used by the scanner to detect unchanged directories without loading full show data.
 * @returns {Promise<Array<{name: string, directory_hash: string|null}>>}
 */
export async function getTVShowNamesAndHashes() {
  return withDb("main", async (db) => {
    return await withRetry(() => db.all('SELECT name, directory_hash FROM tv_shows'));
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

      // Cache-bust metadata.json the same way images are cache-busted. The
      // frontend keys its metadata fetch cache by URL, so without a version
      // token a metadata.json content change (e.g. tmdb_id edit) is served
      // stale from its Redis/304 cache even though the file on disk changed.
      // directory_hash changes whenever anything in the movie dir changes
      // (including a metadata.json rewrite), so it's a zero-cost version token.
      if (urls.metadata) {
        urls.metadata = buildImageUrl(urls.metadata, movie.directory_hash);
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
        basePath: movie.base_path,
        backdropFocal: movie.backdrop_focal ?? null,
        backdropFocalSuggested: movie.backdrop_focal_suggested ?? null,
        // Internal-only columns — never serialized to /media/movies (the
        // app.mjs handler allowlist drops them).
        //
        // `metadata` (F-1): returned VERBATIM from the column so the scheduled
        // updateAllMovieHashes() sweep folds the exact bytes the scanner
        // persisted into generateMovieHashes. The canonical serialization
        // lives in movie-scanner.mjs (compact JSON.stringify of the parsed
        // metadata.json); do NOT re-parse or re-shape it here or the sweep and
        // the scanner's inline hash path will oscillate.
        metadata: movie.metadata,
        // `pristineMetadata` (G-5): raw pre-override TMDB payload, opaque.
        pristineMetadata: movie.pristine_metadata ?? null
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

// P-1a: kept with zero callers anywhere DELIBERATELY — the by-name/by-id
// getter pair mirrors the pattern used in the sister nextjs-stream frontend
// repo, and keeping both codebases on the same idiom makes them easier to
// reason about together (the frontend does not call this endpoint-side; it is
// a ready-made by-id surface). Any column added to getMovieByName's
// processing must be mirrored here.
export async function getMovieById(id) {
  return withDb("main", async (db) => {
    const movie = await withRetry(() => db.get('SELECT * FROM movies WHERE id = ?', [id]));
    if (movie) {
      // Parse the URLs so we can update them
      const urls = safeJson(movie.urls, {});
      
      // Update image URLs with CACHED hashes (NO filesystem I/O)
      if (urls.poster) {
        urls.poster = buildImageUrl(urls.poster, movie.poster_hash);
      }
      
      if (urls.logo) {
        urls.logo = buildImageUrl(urls.logo, movie.logo_hash);
      }
      
      if (urls.backdrop) {
        urls.backdrop = buildImageUrl(urls.backdrop, movie.backdrop_hash);
      }

      // Cache-bust metadata.json the same way images are (see getMovies).
      // Without a version token the frontend serves stale cached metadata after
      // a content change; directory_hash moves on any dir change incl. a
      // metadata.json rewrite, so it's a zero-cost version token.
      if (urls.metadata) {
        urls.metadata = buildImageUrl(urls.metadata, movie.directory_hash);
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
        basePath: movie.base_path,
        backdropFocal: movie.backdrop_focal ?? null,
        backdropFocalSuggested: movie.backdrop_focal_suggested ?? null,
        // Internal-only: metadata fingerprint (F-1, verbatim column bytes —
        // see getMovies) + raw pre-override TMDB payload (G-5).
        metadata: movie.metadata,
        pristineMetadata: movie.pristine_metadata ?? null
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
      
      // Update image URLs with CACHED hashes (NO filesystem I/O)
      if (urls.poster) {
        urls.poster = buildImageUrl(urls.poster, movie.poster_hash);
      }
      
      if (urls.logo) {
        urls.logo = buildImageUrl(urls.logo, movie.logo_hash);
      }
      
      if (urls.backdrop) {
        urls.backdrop = buildImageUrl(urls.backdrop, movie.backdrop_hash);
      }

      // Cache-bust metadata.json the same way images are (see getMovies).
      // Without a version token the frontend serves stale cached metadata after
      // a content change; directory_hash moves on any dir change incl. a
      // metadata.json rewrite, so it's a zero-cost version token.
      if (urls.metadata) {
        urls.metadata = buildImageUrl(urls.metadata, movie.directory_hash);
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
        basePath: movie.base_path,
        backdropFocal: movie.backdrop_focal ?? null,
        backdropFocalSuggested: movie.backdrop_focal_suggested ?? null,
        // Internal-only: `metadata` MUST be the verbatim column bytes — the
        // movie scanner re-reads this row after saveMovie and feeds it to
        // generateMovieHashes, and the scheduled sweep hashes the same column
        // via getMovies(). Any divergence here re-opens the hash oscillation
        // (F-1). Canonical serialization lives in movie-scanner.mjs.
        metadata: movie.metadata,
        pristineMetadata: movie.pristine_metadata ?? null
      };
    }
    return null;
  });
}

// P-1a: kept with zero callers anywhere DELIBERATELY — the by-name/by-id
// getter pair mirrors the pattern used in the sister nextjs-stream frontend
// repo, and keeping both codebases on the same idiom makes them easier to
// reason about together (the frontend does not call this endpoint-side; it is
// a ready-made by-id surface). Any column added to getTVShowByName's
// processing must be mirrored here.
export async function getTVShowById(id) {
  return withDb("main", async (db) => {
    const show = await withRetry(() => db.get('SELECT * FROM tv_shows WHERE id = ?', [id]));
    if (show) {
      // Parse seasons from JSON
      const seasons = safeJson(show.seasons, {});
      
      // Update show-level image URLs with CACHED hashes (NO filesystem I/O)
      const poster = buildImageUrl(show.poster, show.poster_hash);
      const logo = buildImageUrl(show.logo, show.logo_hash);
      const backdrop = buildImageUrl(show.backdrop, show.backdrop_hash);
      
      // Use seasons directly - URLs already contain cached hashes from scanner
      // Scanner embeds hashes during write (see tv-scanner.mjs lines 264-274, 357-366)
      // No filesystem I/O needed - massive performance improvement!
      
      return {
        id: show.id,
        name: show.name,
        metadata: show.metadata,
        // Cache-bust metadata.json URL with directory_hash (see getTVShows).
        metadata_path: buildImageUrl(show.metadata_path, show.directory_hash),
        poster: poster,
        posterBlurhash: show.posterBlurhash,
        logo: logo,
        logoBlurhash: show.logoBlurhash,
        backdrop: backdrop,
        backdropBlurhash: show.backdropBlurhash,
        seasons: seasons,
        directory_hash: show.directory_hash,
        posterFilePath: show.poster_file_path,
        backdropFilePath: show.backdrop_file_path,
        logoFilePath: show.logo_file_path,
        basePath: show.base_path,
        backdropFocal: show.backdrop_focal ?? null,
        backdropFocalSuggested: show.backdrop_focal_suggested ?? null,
        // Internal-only (G-5): raw pre-override TMDB payload, opaque.
        pristineMetadata: show.pristine_metadata ?? null
      };
    }
    return null;
  });
}

export async function getTVShowByName(name) {
  return withDb("main", async (db) => {
    const show = await withRetry(() => db.get('SELECT * FROM tv_shows WHERE name = ?', [name]));
    if (show) {
      // Parse seasons from JSON
      const seasons = safeJson(show.seasons, {});
      
      // Update show-level image URLs with CACHED hashes (NO filesystem I/O)
      const poster = buildImageUrl(show.poster, show.poster_hash);
      const logo = buildImageUrl(show.logo, show.logo_hash);
      const backdrop = buildImageUrl(show.backdrop, show.backdrop_hash);
      
      // Use seasons directly - URLs already contain cached hashes from scanner
      // Scanner embeds hashes during write (see tv-scanner.mjs lines 264-274, 357-366)
      // No filesystem I/O needed - massive performance improvement!
      
      return {
        id: show.id,
        name: show.name,
        metadata: show.metadata,
        // Cache-bust metadata.json URL with directory_hash (see getTVShows).
        metadata_path: buildImageUrl(show.metadata_path, show.directory_hash),
        poster: poster,
        posterBlurhash: show.posterBlurhash,
        logo: logo,
        logoBlurhash: show.logoBlurhash,
        backdrop: backdrop,
        backdropBlurhash: show.backdropBlurhash,
        seasons: seasons,
        directory_hash: show.directory_hash,
        posterFilePath: show.poster_file_path,
        backdropFilePath: show.backdrop_file_path,
        logoFilePath: show.logo_file_path,
        basePath: show.base_path,
        backdropFocal: show.backdrop_focal ?? null,
        backdropFocalSuggested: show.backdrop_focal_suggested ?? null,
        // Internal-only (G-5): raw pre-override TMDB payload, opaque.
        pristineMetadata: show.pristine_metadata ?? null
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
    // Use EXISTS instead of COUNT(*) - stops after finding first row instead of scanning entire table
    const row = await withRetry(() => db.get(`SELECT EXISTS(SELECT 1 FROM ${tableName} LIMIT 1) as exists_flag`));
    return row.exists_flag === 0;
  });
}

export async function deleteMovie(name) {
  return withWriteTx("main", async (db) => {
    // No withRetry needed inside transaction - mutex prevents contention
    await db.run('DELETE FROM movies WHERE name = ?', [name]);
  });
}

export async function deleteTVShow(name) {
  return withWriteTx("main", async (db) => {
    // No withRetry needed inside transaction - mutex prevents contention
    await db.run('DELETE FROM tv_shows WHERE name = ?', [name]);
  });
}

// P-2: the missing change-guard WHERE clause (vs. the movie upsert below) is
// INTENTIONAL — TV's shallower dir-hash depth (TV_DIR_HASH_MAX_DEPTH) plus the
// episode-backfill fall-through can legitimately rewrite a show whose
// directory_hash is unchanged; a movies-style guard here would silently drop
// those writes. Do not "make it symmetric".
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
  basePath = null,
  directoryHash = null,
  backdropFocal = null,
  backdropFocalSuggested = null,
  imageHashes = null,
  pristineMetadata = null
) {
  return withWriteTx("main", async (db) => {
    // Image cache-bust hashes are precomputed by the scanner from the SAME stat
    // that resolved each image file + built its URL (see resolveImage /
    // imageHashesFromResolved). Storing them directly keeps the URL filename,
    // *_file_path, and *_hash in lockstep and avoids a second stat per image.
    const posterHash   = imageHashes?.poster   ?? { hash: null, mtime: null };
    const backdropHash = imageHashes?.backdrop ?? { hash: null, mtime: null };
    const logoHash     = imageHashes?.logo     ?? { hash: null, mtime: null };

    const seasonsStr = JSON.stringify(seasonsObj);

    // G-5 preservation: this upsert ALWAYS rewrites on conflict (see the P-2
    // note above), so a save whose generator invocation performed no genuine
    // TMDB fetch (pristineMetadata === null) must carry the previously stored
    // pristine payload forward — hence the COALESCE on pristine_metadata
    // below. Never let an image-only or backfill rewrite null it out.
    await withRetry(() =>
      db.run(
        `INSERT INTO tv_shows (
          name, metadata, metadata_path, poster, posterBlurhash, logo, logoBlurhash,
          backdrop, backdropBlurhash, seasons,
          poster_file_path, backdrop_file_path, logo_file_path, base_path,
          poster_hash, poster_mtime, backdrop_hash, backdrop_mtime, logo_hash, logo_mtime,
          directory_hash, backdrop_focal, backdrop_focal_suggested, pristine_metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          logo_mtime=excluded.logo_mtime,
          directory_hash=excluded.directory_hash,
          backdrop_focal=excluded.backdrop_focal,
          backdrop_focal_suggested=excluded.backdrop_focal_suggested,
          pristine_metadata=COALESCE(excluded.pristine_metadata, tv_shows.pristine_metadata)`,
        [
          showName, metadata, metadataPath, poster, posterBlurhash, logo, logoBlurhash, backdrop, backdropBlurhash, seasonsStr,
          posterFilePath, backdropFilePath, logoFilePath, basePath,
          posterHash.hash, posterHash.mtime, backdropHash.hash, backdropHash.mtime, logoHash.hash, logoHash.mtime,
          directoryHash, backdropFocal, backdropFocalSuggested, pristineMetadata
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
  basePath = null,
  backdropFocal = null,
  backdropFocalSuggested = null,
  imageHashes = null,
  metadata = null,
  pristineMetadata = null
) {
  return withWriteTx("main", async (db) => {
    // Image cache-bust hashes are precomputed by the scanner from the SAME stat
    // that resolved each image file + built its URL (see resolveImage /
    // imageHashesFromResolved). Storing them directly keeps the URL filename,
    // *_file_path, and *_hash in lockstep and avoids a second stat per image.
    const posterHash   = imageHashes?.poster   ?? { hash: null, mtime: null };
    const backdropHash = imageHashes?.backdrop ?? { hash: null, mtime: null };
    const logoHash     = imageHashes?.logo     ?? { hash: null, mtime: null };

    // `metadata` (F-1) is the scanner's canonically-serialized metadata.json
    // fingerprint (see movie-scanner.mjs) — stored verbatim so both hash
    // writers (scanner inline + scheduled sweep) hash identical bytes.
    // `pristineMetadata` (G-5) is COALESCE-preserved in the UPDATE below: a
    // save without a fresh genuine-fetch payload keeps the stored value.
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

    // Change-guard WHERE clause: the update is skipped when directory_hash is
    // unchanged, with two backfill escape hatches for rows written before a
    // column existed — backdrop_focal_suggested (focal migration) and metadata
    // (F-1 migration; fires only when the scanner actually has a fingerprint
    // to store, so movies without metadata.json don't rewrite every pass).
    // The metadata hatch is driven proactively: movie-scanner.mjs skips its
    // unchanged-directory early return once per row while movies.metadata is
    // NULL and a metadata.json exists (one-shot backfill), so pre-migration
    // rows converge on the first scan pass after deploy rather than waiting
    // for their directory to change.
    await withRetry(() =>
      db.run(
        `INSERT INTO movies (
          name, file_names, lengths, dimensions, urls, metadata_url, directory_hash,
          hdr, media_quality, additional_metadata, _id,
          poster_file_path, backdrop_file_path, logo_file_path, base_path,
          poster_hash, poster_mtime, backdrop_hash, backdrop_mtime, logo_hash, logo_mtime,
          backdrop_focal, backdrop_focal_suggested, metadata, pristine_metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          logo_mtime=excluded.logo_mtime,
          backdrop_focal=excluded.backdrop_focal,
          backdrop_focal_suggested=excluded.backdrop_focal_suggested,
          metadata=excluded.metadata,
          pristine_metadata=COALESCE(excluded.pristine_metadata, movies.pristine_metadata)
        WHERE movies.directory_hash IS NULL OR movies.directory_hash <> excluded.directory_hash
        OR movies.backdrop_focal_suggested IS NULL
        OR (movies.metadata IS NULL AND excluded.metadata IS NOT NULL)`,
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
          logoHash.mtime,
          backdropFocal,
          backdropFocalSuggested,
          metadata,
          pristineMetadata
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
 * Remove a media item from the missing_data_media cooldown table.
 * Called by the scanner once a previously-flagged item has successfully
 * recovered (metadata.json AND all required image files are now present).
 * Idempotent: no-op if the entry doesn't exist.
 * @param {string} name - Media name (movie or show directory name)
 */
export async function deleteMissingDataMedia(name) {
  return withWriteTx("main", async (db) => {
    await withRetry(() =>
      db.run(`DELETE FROM missing_data_media WHERE name = ?`, [name])
    );
  });
}

/**
 * Read the per-episode backfill cooldown rows for one show.
 * @param {string} showName
 * @returns {Promise<Array<{seasonNumber:number, episodeNumber:number, airDate:string|null, lastAttempt:string|null, attempts:number}>>}
 */
export async function getEpisodeMetadataMissingRows(showName) {
  return withDb("main", async (db) => {
    const rows = await withRetry(() =>
      db.all('SELECT * FROM episode_metadata_missing WHERE show_name = ?', [showName])
    );
    return rows.map((r) => ({
      seasonNumber: r.season_number,
      episodeNumber: r.episode_number,
      airDate: r.air_date,
      lastAttempt: r.last_attempt,
      attempts: r.attempts,
    }));
  });
}

/**
 * Record a backfill attempt for one episode (upsert): stamps last_attempt = now,
 * increments attempts, and preserves a known air_date (only overwrites with a
 * non-null value). Drives the 3-day per-episode cooldown.
 */
export async function recordEpisodeMetadataAttempt(showName, seasonNumber, episodeNumber, airDate) {
  return withWriteTx("main", async (db) => {
    const now = new Date().toISOString();
    await withRetry(() =>
      db.run(
        `INSERT INTO episode_metadata_missing
           (show_name, season_number, episode_number, air_date, last_attempt, attempts)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(show_name, season_number, episode_number) DO UPDATE SET
           air_date = COALESCE(excluded.air_date, episode_metadata_missing.air_date),
           last_attempt = excluded.last_attempt,
           attempts = episode_metadata_missing.attempts + 1`,
        [showName, seasonNumber, episodeNumber, airDate ?? null, now]
      )
    );
  });
}

/**
 * Remove an episode's backfill cooldown row once it's resolved (no longer thin).
 * Idempotent.
 */
export async function clearEpisodeMetadataMissing(showName, seasonNumber, episodeNumber) {
  return withWriteTx("main", async (db) => {
    await withRetry(() =>
      db.run(
        `DELETE FROM episode_metadata_missing
         WHERE show_name = ? AND season_number = ? AND episode_number = ?`,
        [showName, seasonNumber, episodeNumber]
      )
    );
  });
}

/**
 * Remove ALL of a show's episode backfill cooldown rows (R-4 removal cascade:
 * called when the show itself leaves the filesystem, so a same-named show
 * re-added later starts with clean retry history). Idempotent.
 */
export async function clearEpisodeMetadataMissingForShow(showName) {
  return withWriteTx("main", async (db) => {
    await withRetry(() =>
      db.run(`DELETE FROM episode_metadata_missing WHERE show_name = ?`, [showName])
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
          expiresAt: cached.expires_at,
          etag: cached.etag || null
        };
      }

      return null;
    } catch (error) {
      console.error('Error getting TMDB cache:', error);
      return null;
    }
  });
}

/**
 * Fetch a cache entry regardless of expiry — the revalidation lookup (T-1).
 * An expired row is exactly what conditional revalidation needs: its stored
 * `etag` rides out as `If-None-Match`, and a 304 lets the caller re-up the
 * row instead of re-downloading the payload.
 */
export async function getTmdbCacheEntryAnyAge(endpoint, params = {}, customCacheKey = null) {
  return withDb("tmdbCache", async (db) => {
    const cacheKey = customCacheKey || generateTmdbCacheKey(endpoint, params);
    try {
      const row = await withRetry(() =>
        db.get('SELECT * FROM tmdb_cache WHERE cache_key = ?', [cacheKey])
      );
      if (!row) return null;
      return {
        data: JSON.parse(row.response_data),
        etag: row.etag || null,
        cachedAt: row.created_at,
        expiresAt: row.expires_at,
        expired: !row.expires_at || row.expires_at <= new Date().toISOString()
      };
    } catch (error) {
      console.error('Error getting TMDB cache entry (any age):', error);
      return null;
    }
  });
}

export async function setTmdbCache(endpoint, params = {}, responseData, ttlHours = 1440, customCacheKey = null, etag = null) {
  return withWriteTx("tmdbCache", async (db) => {
    const cacheKey = customCacheKey || generateTmdbCacheKey(endpoint, params);
    const now = new Date();

    // Validate ttlHours to prevent invalid Date objects
    const validTtl = (typeof ttlHours === 'number' && isFinite(ttlHours) && ttlHours > 0) ? ttlHours : 1440;
    const expiresAt = new Date(now.getTime() + (validTtl * 60 * 60 * 1000));

    // Sanity check: if expiresAt is invalid, log and skip
    if (!isFinite(expiresAt.getTime())) {
      console.error(`Invalid expiresAt calculated for ${endpoint} with ttlHours=${ttlHours}`);
      return false;
    }

    try {
      await withRetry(() =>
        db.run(
          `INSERT INTO tmdb_cache (
            cache_key, endpoint, request_params, response_data, created_at, expires_at, last_accessed, etag
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET
            endpoint = excluded.endpoint,
            request_params = excluded.request_params,
            response_data = excluded.response_data,
            expires_at = excluded.expires_at,
            last_accessed = excluded.last_accessed,
            etag = excluded.etag`,
          [
            cacheKey,
            endpoint,
            JSON.stringify(params),
            JSON.stringify(responseData),
            now.toISOString(),
            expiresAt.toISOString(),
            now.toISOString(),
            etag
          ]
        )
      );
      // Explicit success signal (T-6): the cache-write telemetry derives its
      // write-success attribute from this, so a void return would misreport.
      return true;
    } catch (error) {
      console.error('Error setting TMDB cache:', error);
      return false;
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
