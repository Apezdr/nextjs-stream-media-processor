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

// Search movies or TV shows
router.get('/search/:type', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type } = req.params;
    const { query, page = 1 } = req.query;
    
    const data = await searchMedia(type, query, page);
    
    logger.info(`User ${req.user.email} searched for ${type}: "${query}"`);
    res.json(data);
  } catch (error) {
    logger.error('Search error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get detailed information for movie or TV show
router.get('/details/:type/:id', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type, id } = req.params;
    
    const data = await getMediaDetails(type, id);
    
    logger.info(`User ${req.user.email} requested ${type} details for ID: ${id}`);
    res.json(data);
  } catch (error) {
    logger.error('Details error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get comprehensive details (similar to Python script's fetch_tmdb_media_details)
router.get('/comprehensive/:type', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type } = req.params;
    const { name, tmdb_id } = req.query;
    
    if (!name && !tmdb_id) {
      return res.status(400).json({ error: 'Either name or tmdb_id parameter is required' });
    }
    
    const data = await fetchComprehensiveMediaDetails(name, type, tmdb_id);
    
    logger.info(`User ${req.user.email} requested comprehensive ${type} details for: ${name || `ID ${tmdb_id}`}`);
    res.json(data);
  } catch (error) {
    logger.error('Comprehensive details error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get cast information
router.get('/cast/:type/:id', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type, id } = req.params;
    
    const cast = await getMediaCast(type, id);
    
    logger.info(`User ${req.user.email} requested cast for ${type} ID: ${id}`);
    res.json(cast);
  } catch (error) {
    logger.error('Cast error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get trailer information
router.get('/videos/:type/:id', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type, id } = req.params;
    
    const videos = await getMediaVideos(type, id);
    
    logger.info(`User ${req.user.email} requested videos for ${type} ID: ${id}`);
    res.json(videos);
  } catch (error) {
    logger.error('Videos error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get images (logos, backdrops, posters)
router.get('/images/:type/:id', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type, id } = req.params;
    
    const images = await getMediaImages(type, id);
    
    logger.info(`User ${req.user.email} requested images for ${type} ID: ${id}`);
    res.json(images);
  } catch (error) {
    logger.error('Images error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get content ratings
router.get('/rating/:type/:id', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { type, id } = req.params;
    
    const rating = await getMediaRating(type, id);
    
    logger.info(`User ${req.user.email} requested rating for ${type} ID: ${id}`);
    res.json(rating);
  } catch (error) {
    logger.error('Rating error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get TV episode details
router.get('/episode/:showId/:season/:episode', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { showId, season, episode } = req.params;
    
    const data = await getEpisodeDetails(showId, season, episode);
    
    logger.info(`User ${req.user.email} requested episode details: ${showId} S${season}E${episode}`);
    res.json(data);
  } catch (error) {
    logger.error('Episode error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get episode images
router.get('/episode/:showId/:season/:episode/images', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { showId, season, episode } = req.params;
    
    const images = await getEpisodeImages(showId, season, episode);
    
    logger.info(`User ${req.user.email} requested episode images: ${showId} S${season}E${episode}`);
    res.json(images);
  } catch (error) {
    logger.error('Episode images error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Search movie collections
router.get('/search/collection', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { query, page = 1 } = req.query;
    
    const data = await searchCollections(query, page);
    
    logger.info(`User ${req.user.email} searched for collections: "${query}"`);
    res.json(data);
  } catch (error) {
    logger.error('Collection search error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get detailed information for movie collection
router.get('/collection/:id', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { enhanced } = req.query;
    
    let data;
    if (enhanced === 'true') {
      logger.info(`User ${req.user.email} requested enhanced collection details for ID: ${id}`);
      data = await fetchEnhancedCollectionData(id);
    } else {
      data = await getCollectionDetails(id);
    }
    
    logger.info(`User ${req.user.email} requested ${enhanced === 'true' ? 'enhanced ' : ''}collection details for ID: ${id}`);
    res.json(data);
  } catch (error) {
    logger.error('Collection details error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Get images for movie collection
router.get('/collection/:id/images', authenticateUser, rateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    
    const images = await getCollectionImages(id);
    
    logger.info(`User ${req.user.email} requested collection images for ID: ${id}`);
    res.json(images);
  } catch (error) {
    logger.error('Collection images error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Admin-only endpoint to get TMDB configuration
router.get('/config', authenticateUser, requireAdmin, async (req, res) => {
  try {
    const cacheDb = await initializeDatabase('tmdbCache');
    const cacheStats = await getTmdbCacheStats(cacheDb);
    await releaseDatabase(cacheDb);

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
    const cacheDb = await initializeDatabase('tmdbCache');
    const stats = await getTmdbCacheStats(cacheDb);
    await releaseDatabase(cacheDb);

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
    const cacheDb = await initializeDatabase('tmdbCache');
    
    const deletedCount = await clearTmdbCache(cacheDb, pattern || null);
    await releaseDatabase(cacheDb);

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
    const cacheDb = await initializeDatabase('tmdbCache');
    const deletedCount = await clearExpiredTmdbCache(cacheDb);
    await releaseDatabase(cacheDb);

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

    const cacheDb = await initializeDatabase('tmdbCache');
    const refreshed = await refreshTmdbCacheEntry(cacheDb, endpoint, params);
    await releaseDatabase(cacheDb);

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