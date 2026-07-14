import crypto from 'crypto';
import express from 'express';
import { createCategoryLogger } from '../lib/logger.mjs';
import { authenticateUser, createRateLimiter, requireAdmin, requireFullAccess } from '../middleware/auth.mjs';
import {
  searchMedia,
  getMediaDetails,
  getMediaCast,
  getStructuredMediaCast,
  getMediaVideos,
  getMediaImages,
  getMediaRating,
  getEpisodeDetails,
  getEpisodeImages,
  fetchComprehensiveMediaDetails,
  searchCollections,
  getCollectionDetails,
  getCollectionImages,
  fetchEnhancedCollectionData,
  makeTmdbRequest
} from '../utils/tmdb.mjs';
import {
  initializeDatabase,
  releaseDatabase,
  getTmdbCacheStats,
  clearTmdbCache,
  clearExpiredTmdbCache,
  refreshTmdbCacheEntry
} from '../sqliteDatabase.mjs';

const logger = createCategoryLogger('tmdb-api');

// Create rate limiter middleware (800 requests per minute)
const rateLimiter = createRateLimiter(800, 60000);

/**
 * Send a JSON payload with a content-derived ETag and honor If-None-Match.
 *
 * Callers polling these endpoints (the Next.js proxy revalidates with
 * If-None-Match on every request) get a bodyless 304 when the payload is
 * unchanged, instead of re-downloading the full response each time.
 *
 * Cache bookkeeping fields (_cached/_cachedAt/_expiresAt) are excluded from
 * the hash so the ETag stays stable across fresh fetches and SQLite cache
 * hits of the same underlying payload; the ETag is weak for the same reason —
 * equivalent responses can still differ byte-for-byte in those fields.
 */
function sendJsonWithETag(req, res, data) {
  const stablePayload = { ...(data ?? {}) };
  delete stablePayload._cached;
  delete stablePayload._cachedAt;
  delete stablePayload._expiresAt;

  const hash = crypto.createHash('md5').update(JSON.stringify(stablePayload)).digest('hex');
  const etag = `W/"${hash}"`;

  res.set('ETag', etag);

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) {
    const normalize = (tag) => tag.trim().replace(/^W\//, '');
    const matches = ifNoneMatch.split(',').some((tag) => normalize(tag) === normalize(etag));
    if (matches) {
      return res.status(304).end();
    }
  }

  return res.json(data);
}

/**
 * Initialize and configure TMDB API routes
 * @returns {object} Configured Express router
 */
export function setupTmdbRoutes() {
  const router = express.Router();

  // STANDARDIZED ENDPOINTS - All use query parameters consistently

  // Search movies or TV shows
  router.get('/search/:type', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type } = req.params;
    const { query, page = 1, blurhash } = req.query;
    
    const includeBlurhash = blurhash === 'true';
    const data = await searchMedia(type, query, page, includeBlurhash);
    
    logger.info(`User ${req.user.email} searched for ${type}: "${query}"${includeBlurhash ? ' with blurhash' : ''} returned ${data.results.length} results`);
    res.json(data);
  } catch (error) {
    logger.error('Search error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get comprehensive details (similar to Python script's fetch_tmdb_media_details)
router.get('/comprehensive/:type', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type } = req.params;
    const { name, tmdb_id, blurhash } = req.query;
    
    if (!name && !tmdb_id) {
      return res.status(400).json({ error: 'Either name or tmdb_id parameter is required' });
    }
    
    const includeBlurhash = blurhash === 'true';
    const data = await fetchComprehensiveMediaDetails(name, type, tmdb_id, includeBlurhash);

    logger.info(`User ${req.user.email} requested comprehensive ${type} details for: ${name || `ID ${tmdb_id}`}${includeBlurhash ? ' with blurhash' : ''}`);
    return sendJsonWithETag(req, res, data);
  } catch (error) {
    logger.error('Comprehensive details error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get detailed information for movie or TV show
router.get('/details/:type', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type } = req.params;
    const { tmdb_id, blurhash } = req.query;
    
    if (!tmdb_id) {
      return res.status(400).json({ error: 'tmdb_id parameter is required' });
    }
    
    const includeBlurhash = blurhash === 'true';
    const data = await getMediaDetails(type, tmdb_id, includeBlurhash);
    
    logger.info(`User ${req.user.email} requested ${type} details for ID: ${tmdb_id}${includeBlurhash ? ' with blurhash' : ''}`);
    res.json(data);
  } catch (error) {
    logger.error('Details error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get cast information
router.get('/cast/:type', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type } = req.params;
    const { tmdb_id } = req.query;
    
    if (!tmdb_id) {
      return res.status(400).json({ error: 'tmdb_id parameter is required' });
    }
    
    const cast = await getMediaCast(type, tmdb_id);
    
    logger.info(`User ${req.user.email} requested cast for ${type} ID: ${tmdb_id}`);
    res.json(cast);
  } catch (error) {
    logger.error('Cast error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get structured cast information (with recurring and optionally guest cast)
router.get('/structured-cast/:type', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type } = req.params;
    const { tmdb_id, include_guest } = req.query;
    
    if (!tmdb_id) {
      return res.status(400).json({ error: 'tmdb_id parameter is required' });
    }
    
    const includeGuestCast = include_guest === 'true';
    const castData = await getStructuredMediaCast(type, tmdb_id, includeGuestCast);
    
    logger.info(`User ${req.user.email} requested structured cast for ${type} ID: ${tmdb_id}${includeGuestCast ? ' with guest cast' : ''}`);
    res.json(castData);
  } catch (error) {
    logger.error('Structured cast error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get trailer information
router.get('/videos/:type', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type } = req.params;
    const { tmdb_id } = req.query;
    
    if (!tmdb_id) {
      return res.status(400).json({ error: 'tmdb_id parameter is required' });
    }
    
    const videos = await getMediaVideos(type, tmdb_id);
    
    logger.info(`User ${req.user.email} requested videos for ${type} ID: ${tmdb_id}`);
    res.json(videos);
  } catch (error) {
    logger.error('Videos error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get images (logos, backdrops, posters)
router.get('/images/:type', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type } = req.params;
    const { tmdb_id, blurhash } = req.query;
    
    if (!tmdb_id) {
      return res.status(400).json({ error: 'tmdb_id parameter is required' });
    }
    
    const includeBlurhash = blurhash === 'true';
    const images = await getMediaImages(type, tmdb_id, includeBlurhash);
    
    logger.info(`User ${req.user.email} requested images for ${type} ID: ${tmdb_id}${includeBlurhash ? ' with blurhash' : ''}`);
    res.json(images);
  } catch (error) {
    logger.error('Images error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get content ratings
router.get('/rating/:type', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type } = req.params;
    const { tmdb_id } = req.query;
    
    if (!tmdb_id) {
      return res.status(400).json({ error: 'tmdb_id parameter is required' });
    }
    
    const rating = await getMediaRating(type, tmdb_id);
    
    logger.info(`User ${req.user.email} requested rating for ${type} ID: ${tmdb_id}`);
    res.json(rating);
  } catch (error) {
    logger.error('Rating error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get TV episode details
router.get('/episode', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { tmdb_id, season, episode } = req.query;
    
    if (!tmdb_id || !season || !episode) {
      return res.status(400).json({ error: 'tmdb_id, season, and episode parameters are required' });
    }
    
    const data = await getEpisodeDetails(tmdb_id, season, episode);
    
    logger.info(`User ${req.user.email} requested episode details: ${tmdb_id} S${season}E${episode}`);
    res.json(data);
  } catch (error) {
    logger.error('Episode error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get episode images
router.get('/episode/images', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { tmdb_id, season, episode, blurhash } = req.query;
    
    if (!tmdb_id || !season || !episode) {
      return res.status(400).json({ error: 'tmdb_id, season, and episode parameters are required' });
    }
    
    const includeBlurhash = blurhash === 'true';
    const images = await getEpisodeImages(tmdb_id, season, episode, includeBlurhash);
    
    logger.info(`User ${req.user.email} requested episode images: ${tmdb_id} S${season}E${episode}${includeBlurhash ? ' with blurhash' : ''}`);
    res.json(images);
  } catch (error) {
    logger.error('Episode images error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Search movie collections
router.get('/search/collection', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { query, page = 1, blurhash } = req.query;
    
    const includeBlurhash = blurhash === 'true';
    const data = await searchCollections(query, page, includeBlurhash);
    
    logger.info(`User ${req.user.email} searched for collections: "${query}"${includeBlurhash ? ' with blurhash' : ''}`);
    res.json(data);
  } catch (error) {
    logger.error('Collection search error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get detailed information for movie collection
router.get('/collection', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { tmdb_id, enhanced, blurhash } = req.query;
    
    if (!tmdb_id) {
      return res.status(400).json({ error: 'tmdb_id parameter is required' });
    }
    
    const includeBlurhash = blurhash === 'true';
    let data;
    if (enhanced === 'true') {
      logger.info(`User ${req.user.email} requested enhanced collection details for ID: ${tmdb_id}`);
      data = await fetchEnhancedCollectionData(tmdb_id, includeBlurhash);
    } else {
      data = await getCollectionDetails(tmdb_id, includeBlurhash);
    }
    
    logger.info(`User ${req.user.email} requested ${enhanced === 'true' ? 'enhanced ' : ''}collection details for ID: ${tmdb_id}${includeBlurhash ? ' with blurhash' : ''}`);
    res.json(data);
  } catch (error) {
    logger.error('Collection details error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get images for movie collection
router.get('/collection/images', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { tmdb_id, blurhash } = req.query;
    
    if (!tmdb_id) {
      return res.status(400).json({ error: 'tmdb_id parameter is required' });
    }
    
    const includeBlurhash = blurhash === 'true';
    const images = await getCollectionImages(tmdb_id, includeBlurhash);
    
    logger.info(`User ${req.user.email} requested collection images for ID: ${tmdb_id}${includeBlurhash ? ' with blurhash' : ''}`);
    res.json(images);
  } catch (error) {
    logger.error('Collection images error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Admin-only endpoint reporting global TMDB integration status.
// A-4a (implemented): this route was GET /api/tmdb/config, which collided by
// name with the unrelated per-title `tmdb.config` editor at
// GET/PUT /api/admin/metadata/config (routes/admin.mjs). The read-only global
// resource was renamed to /status — it *is* a status report, and it sits
// naturally beside /api/tmdb/health. Breaking change by decision (no alias);
// external callers of the old path get the router's 404.
router.get('/status', authenticateUser, requireAdmin, async (req, res) => {
  try {
    const cacheStats = await getTmdbCacheStats();

    res.json({
      tmdb_configured: !!process.env.TMDB_API_KEY,
      base_url: 'https://api.themoviedb.org/3',
      image_base_url: 'https://image.tmdb.org/t/p/original',
      rate_limits: {
        // Matches the actual createRateLimiter(800, 60000) on these routes
        // (historically misreported as 100).
        requests_per_minute: 800,
        window_ms: 60000
      },
      cache: {
        enabled: true,
        default_ttl_hours: 1440, // 60 days
        database: 'tmdb_cache.db',
        stats: cacheStats
      }
    });
  } catch (error) {
    logger.error('Status error:', error);
    res.status(500).json({ error: 'Failed to fetch TMDB status' });
  }
});

// Admin-only endpoint to get cache statistics
router.get('/cache/stats', authenticateUser, requireAdmin, async (req, res) => {
  try {
    const stats = await getTmdbCacheStats();

    logger.info(`Admin ${req.user.email} requested TMDB cache stats`);
    res.json(stats);
  } catch (error) {
    logger.error('Cache stats error:', error);
    res.status(500).json({ error: 'Failed to fetch cache statistics' });
  }
});

// Admin-only endpoint to clear cache
router.delete('/cache', authenticateUser, requireAdmin, async (req, res) => {
  try {
    const { pattern } = req.query;
    
    const deletedCount = await clearTmdbCache(pattern || null);

    logger.info(`Admin ${req.user.email} cleared TMDB cache${pattern ? ` with pattern: ${pattern}` : ''} - ${deletedCount} entries deleted`);
    res.json({
      success: true,
      deletedCount,
      message: pattern ? `Cleared ${deletedCount} cache entries matching pattern: ${pattern}` : `Cleared all ${deletedCount} cache entries`
    });
  } catch (error) {
    logger.error('Cache clear error:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Admin-only endpoint to clear expired cache entries
router.delete('/cache/expired', authenticateUser, requireAdmin, async (req, res) => {
  try {
    const deletedCount = await clearExpiredTmdbCache();

    logger.info(`Admin ${req.user.email} cleared expired TMDB cache - ${deletedCount} entries deleted`);
    res.json({
      success: true,
      deletedCount,
      message: `Cleared ${deletedCount} expired cache entries`
    });
  } catch (error) {
    logger.error('Cache clear expired error:', error);
    res.status(500).json({ error: 'Failed to clear expired cache' });
  }
});

// Admin-only endpoint to force refresh specific cache entry: drops the stale
// row, then eagerly refetches through makeTmdbRequest(forceRefresh) so the
// fresh response is re-cached via the normal setTmdbCache() path.
// Limitation: blurhash-enhanced responses live under a different custom key
// (generateBlurhashCacheKey in utils/tmdbBlurhash.mjs) that this endpoint
// cannot address — only the plain variant of {endpoint, params} is refreshed;
// a stale blurhash variant ages out via its TTL.
router.post('/cache/refresh', authenticateUser, requireAdmin, async (req, res) => {
  try {
    const { endpoint, params = {} } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint parameter is required' });
    }

    // `refreshed` keeps its original meaning — "a cached row existed and was
    // dropped" — so existing consumers of the field are unaffected.
    const refreshed = await refreshTmdbCacheEntry(endpoint, params);

    try {
      await makeTmdbRequest(endpoint, params, 3, 1440, /* forceRefresh */ true);
    } catch (fetchError) {
      logger.error(`Cache refresh refetch failed for ${endpoint}: ${fetchError.message}`);
      return res.status(502).json({
        success: false,
        refreshed,
        fetched: false,
        error: `Stale entry ${refreshed ? 'cleared' : 'not found'}, but the TMDB refetch failed: ${fetchError.message}`
      });
    }

    logger.info(`Admin ${req.user.email} refreshed TMDB cache for endpoint: ${endpoint} (stale row ${refreshed ? 'dropped' : 'absent'}, fresh data fetched and re-cached)`);
    res.json({
      success: true,
      refreshed,
      fetched: true,
      message: 'Fresh TMDB data fetched and re-cached'
    });
  } catch (error) {
    logger.error('Cache refresh error:', error);
    res.status(500).json({ error: 'Failed to refresh cache entry' });
  }
});

// Health check endpoint (no authentication required)
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    tmdb_configured: !!process.env.TMDB_API_KEY,
    service: 'tmdb-api',
    cache_enabled: true
  });
});

  return router;
}

export default setupTmdbRoutes();