import express from 'express';
import { createCategoryLogger } from '../lib/logger.mjs';
import { authenticateUser, createRateLimiter, requireAdmin, requireFullAccess } from '../middleware/auth.mjs';
import {
  searchMedia,
  getMediaDetails,
  getMediaCast,
  getMediaVideos,
  getMediaImages,
  getMediaRating,
  getEpisodeDetails,
  getEpisodeImages,
  fetchComprehensiveMediaDetails,
  searchCollections,
  getCollectionDetails,
  getCollectionImages,
  fetchEnhancedCollectionData
} from '../utils/tmdb.mjs';
import {
  initializeDatabase,
  releaseDatabase,
  getTmdbCacheStats,
  clearTmdbCache,
  clearExpiredTmdbCache,
  refreshTmdbCacheEntry
} from '../sqliteDatabase.mjs';

const router = express.Router();
const logger = createCategoryLogger('tmdb-api');

// Create rate limiter middleware (100 requests per minute)
const rateLimiter = createRateLimiter(100, 60000);

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
    res.json(data);
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

// Admin-only endpoint to get TMDB configuration
router.get('/config', authenticateUser, requireAdmin, async (req, res) => {
  try {
    const cacheStats = await getTmdbCacheStats();

    res.json({
      tmdb_configured: !!process.env.TMDB_API_KEY,
      base_url: 'https://api.themoviedb.org/3',
      image_base_url: 'https://image.tmdb.org/t/p/original',
      rate_limits: {
        requests_per_minute: 100,
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
    logger.error('Config error:', error);
    res.status(500).json({ error: 'Failed to fetch configuration' });
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

// Admin-only endpoint to force refresh specific cache entry
router.post('/cache/refresh', authenticateUser, requireAdmin, async (req, res) => {
  try {
    const { endpoint, params = {} } = req.body;
    
    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint parameter is required' });
    }

    const refreshed = await refreshTmdbCacheEntry(endpoint, params);

    logger.info(`Admin ${req.user.email} refreshed TMDB cache for endpoint: ${endpoint}`);
    res.json({
      success: true,
      refreshed,
      message: refreshed ? 'Cache entry refreshed successfully' : 'Cache entry not found'
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

export default router;