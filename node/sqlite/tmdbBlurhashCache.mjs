import { createCategoryLogger } from '../lib/logger.mjs';
import { withDb, withWriteTx, withRetry } from '../sqliteDatabase.mjs';

const logger = createCategoryLogger('tmdb-blurhash-cache');

// Singleton flag to prevent re-initialization and response corruption
let tableInitialized = false;

/**
 * Initialize the TMDB blurhash cache table in the database
 * @param {Object} db - SQLite database connection
 */
export async function initializeTmdbBlurhashCacheTable(db) {
  // Skip if already initialized to prevent blocking subsequent requests
  if (tableInitialized) {
    return;
  }
  
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS tmdb_blurhash_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_url TEXT UNIQUE,
        blurhash TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT,
        last_accessed TEXT DEFAULT CURRENT_TIMESTAMP,
        file_size INTEGER,
        image_width INTEGER,
        image_height INTEGER
      );
      
      CREATE INDEX IF NOT EXISTS idx_tmdb_blurhash_url ON tmdb_blurhash_cache(image_url);
      CREATE INDEX IF NOT EXISTS idx_tmdb_blurhash_expires ON tmdb_blurhash_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_tmdb_blurhash_accessed ON tmdb_blurhash_cache(last_accessed);
    `);
    
    tableInitialized = true;
    logger.info('TMDB blurhash cache table initialized');
  } catch (error) {
    logger.error(`Error initializing TMDB blurhash cache table: ${error.message}`);
    throw error;
  }
}

/**
 * Get cached blurhash for a TMDB image URL
 * @param {Object} db - SQLite database connection
 * @param {string} imageUrl - Full TMDB image URL
 * @returns {Promise<string|null>} - Cached blurhash or null if not found/expired
 */
export async function getCachedTmdbBlurhash(db, imageUrl) {
  try {
    const now = new Date().toISOString();
    
    const cached = await withRetry(() =>
      db.get(
        'SELECT blurhash, last_accessed FROM tmdb_blurhash_cache WHERE image_url = ? AND (expires_at IS NULL OR expires_at > ?)',
        [imageUrl, now]
      )
    );
    
    if (cached) {
      // Only update last_accessed if it's stale (older than 6 hours) to reduce write contention
      // Use Date.parse() to handle different timestamp formats reliably
      const lastAccessedMs = cached.last_accessed ? Date.parse(cached.last_accessed) : 0;
      const sixHoursAgoMs = Date.now() - 6 * 60 * 60 * 1000;
      
      if (!lastAccessedMs || lastAccessedMs < sixHoursAgoMs) {
        // Don't await this - fire and forget to avoid blocking reads
        withWriteTx('tmdbCache', async (db) => {
          await withRetry(() =>
            db.run(
              'UPDATE tmdb_blurhash_cache SET last_accessed = ? WHERE image_url = ?',
              [now, imageUrl]
            )
          );
        }).catch((err) => {
          // Silently ignore shutdown errors or other transient issues
          if (!err.message.includes('shutting down')) {
            logger.warn(`Failed to update last_accessed for ${imageUrl}: ${err.message}`);
          }
        });
      }
      
      logger.debug(`Blurhash cache hit for: ${imageUrl}`);
      return cached.blurhash;
    }
    
    return null;
  } catch (error) {
    logger.error(`Error getting cached TMDB blurhash: ${error.message}`);
    return null;
  }
}

/**
 * Store blurhash in cache for a TMDB image URL
 * @param {Object} db - SQLite database connection
 * @param {string} imageUrl - Full TMDB image URL
 * @param {string} blurhash - Generated blurhash
 * @param {number} ttlHours - Time to live in hours (default: 2160 = 90 days)
 * @param {Object} metadata - Optional metadata (file_size, width, height)
 * @returns {Promise<void>}
 */
export async function cacheTmdbBlurhash(db, imageUrl, blurhash, ttlHours = 2160, metadata = {}) {
  try {
    const now = new Date();
    const expiresAt = ttlHours > 0 ? new Date(now.getTime() + (ttlHours * 60 * 60 * 1000)) : null;
    
    await withRetry(() =>
      db.run(
        `INSERT INTO tmdb_blurhash_cache (
          image_url, blurhash, created_at, expires_at, last_accessed, file_size, image_width, image_height
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(image_url) DO UPDATE SET
          blurhash = excluded.blurhash,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at,
          last_accessed = excluded.last_accessed,
          file_size = excluded.file_size,
          image_width = excluded.image_width,
          image_height = excluded.image_height`,
        [
          imageUrl,
          blurhash,
          now.toISOString(),
          expiresAt ? expiresAt.toISOString() : null,
          now.toISOString(),
          metadata.file_size || null,
          metadata.image_width || null,
          metadata.image_height || null
        ]
      )
    );
    
    logger.debug(`Cached blurhash for: ${imageUrl}`);
  } catch (error) {
    logger.error(`Error caching TMDB blurhash: ${error.message}`);
  }
}

/**
 * Clear expired TMDB blurhash cache entries
 * @param {Object} db - SQLite database connection
 * @returns {Promise<number>} - Number of entries deleted
 */
export async function clearExpiredTmdbBlurhashCache(db) {
  try {
    const now = new Date().toISOString();
    
    const result = await withRetry(() =>
      db.run('DELETE FROM tmdb_blurhash_cache WHERE expires_at IS NOT NULL AND expires_at <= ?', [now])
    );
    
    const deletedCount = result.changes || 0;
    if (deletedCount > 0) {
      logger.info(`Cleared ${deletedCount} expired TMDB blurhash cache entries`);
    }
    
    return deletedCount;
  } catch (error) {
    logger.error(`Error clearing expired TMDB blurhash cache: ${error.message}`);
    return 0;
  }
}

/**
 * Clear all TMDB blurhash cache entries (admin function)
 * @param {Object} db - SQLite database connection
 * @param {string} urlPattern - Optional URL pattern to match (e.g., '%poster%')
 * @returns {Promise<number>} - Number of entries deleted
 */
export async function clearTmdbBlurhashCache(db, urlPattern = null) {
  try {
    let result;
    if (urlPattern) {
      result = await withRetry(() =>
        db.run('DELETE FROM tmdb_blurhash_cache WHERE image_url LIKE ?', [urlPattern])
      );
    } else {
      result = await withRetry(() =>
        db.run('DELETE FROM tmdb_blurhash_cache')
      );
    }
    
    const deletedCount = result.changes || 0;
    logger.info(`Cleared ${deletedCount} TMDB blurhash cache entries${urlPattern ? ` matching pattern: ${urlPattern}` : ''}`);
    
    return deletedCount;
  } catch (error) {
    logger.error(`Error clearing TMDB blurhash cache: ${error.message}`);
    return 0;
  }
}

/**
 * Get TMDB blurhash cache statistics
 * @param {Object} db - SQLite database connection
 * @returns {Promise<Object>} - Cache statistics
 */
export async function getTmdbBlurhashCacheStats(db) {
  try {
    const now = new Date().toISOString();
    
    const [total, expired, sizeStats] = await Promise.all([
      withRetry(() => db.get('SELECT COUNT(*) as count FROM tmdb_blurhash_cache')),
      withRetry(() => db.get('SELECT COUNT(*) as count FROM tmdb_blurhash_cache WHERE expires_at IS NOT NULL AND expires_at <= ?', [now])),
      withRetry(() => db.get(`
        SELECT 
          COUNT(*) as total_with_size,
          AVG(file_size) as avg_file_size,
          SUM(file_size) as total_file_size,
          MIN(created_at) as oldest_entry,
          MAX(last_accessed) as most_recent_access
        FROM tmdb_blurhash_cache 
        WHERE file_size IS NOT NULL
      `))
    ]);
    
    // Get distribution by image type (based on URL patterns)
    const imageTypes = await withRetry(() => db.all(`
      SELECT 
        CASE 
          WHEN image_url LIKE '%/poster%' OR image_url LIKE '%poster%' THEN 'poster'
          WHEN image_url LIKE '%/backdrop%' OR image_url LIKE '%backdrop%' THEN 'backdrop'
          WHEN image_url LIKE '%/logo%' OR image_url LIKE '%logo%' THEN 'logo'
          WHEN image_url LIKE '%/still%' OR image_url LIKE '%still%' THEN 'still'
          ELSE 'other'
        END as image_type,
        COUNT(*) as count
      FROM tmdb_blurhash_cache
      WHERE expires_at IS NULL OR expires_at > ?
      GROUP BY image_type
      ORDER BY count DESC
    `, [now]));
    
    return {
      total: total.count,
      expired: expired.count,
      active: total.count - expired.count,
      averageFileSize: sizeStats.avg_file_size ? Math.round(sizeStats.avg_file_size) : null,
      totalFileSize: sizeStats.total_file_size || 0,
      oldestEntry: sizeStats.oldest_entry,
      mostRecentAccess: sizeStats.most_recent_access,
      imageTypeDistribution: imageTypes
    };
  } catch (error) {
    logger.error(`Error getting TMDB blurhash cache stats: ${error.message}`);
    return {
      total: 0,
      expired: 0,
      active: 0,
      averageFileSize: null,
      totalFileSize: 0,
      oldestEntry: null,
      mostRecentAccess: null,
      imageTypeDistribution: []
    };
  }
}

/**
 * Clean up old TMDB blurhash cache entries based on last access time
 * @param {Object} db - SQLite database connection
 * @param {number} maxAgeHours - Maximum age in hours for last access (default: 2160 = 90 days)
 * @returns {Promise<number>} - Number of entries deleted
 */
export async function cleanupOldTmdbBlurhashCache(db, maxAgeHours = 2160) {
  try {
    const cutoffTime = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000)).toISOString();
    
    const result = await withRetry(() =>
      db.run('DELETE FROM tmdb_blurhash_cache WHERE last_accessed < ?', [cutoffTime])
    );
    
    const deletedCount = result.changes || 0;
    if (deletedCount > 0) {
      logger.info(`Cleaned up ${deletedCount} old TMDB blurhash cache entries (not accessed for ${maxAgeHours} hours)`);
    }
    
    return deletedCount;
  } catch (error) {
    logger.error(`Error cleaning up old TMDB blurhash cache: ${error.message}`);
    return 0;
  }
}

/**
 * High-level function to get cached blurhash (uses singleton connection)
 * @param {string} imageUrl - Full TMDB image URL
 * @returns {Promise<string|null>} - Cached blurhash or null if not found/expired
 */
export async function getCachedTmdbBlurhashWithDb(imageUrl) {
  return withDb('tmdbCache', async (db) => {
    return await getCachedTmdbBlurhash(db, imageUrl);
  });
}

/**
 * High-level function to cache blurhash (uses write mutex)
 * @param {string} imageUrl - Full TMDB image URL
 * @param {string} blurhash - Generated blurhash
 * @param {number} ttlHours - Time to live in hours (default: 2160 = 90 days)
 * @param {Object} metadata - Optional metadata (file_size, width, height)
 * @returns {Promise<void>}
 */
export async function cacheTmdbBlurhashWithDb(imageUrl, blurhash, ttlHours = 2160, metadata = {}) {
  return withWriteTx('tmdbCache', async (db) => {
    await cacheTmdbBlurhash(db, imageUrl, blurhash, ttlHours, metadata);
  });
}

/**
 * High-level function to clear expired cache (uses write mutex)
 * @returns {Promise<number>} - Number of entries deleted
 */
export async function clearExpiredTmdbBlurhashCacheWithDb() {
  return withWriteTx('tmdbCache', async (db) => {
    return await clearExpiredTmdbBlurhashCache(db);
  });
}
