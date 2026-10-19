import crypto from 'crypto';
import express from 'express';
import { createCategoryLogger } from '../lib/logger.mjs';
import { authenticateUser, createRateLimiter, requireFullAccess } from '../middleware/auth.mjs';
import {
  searchMedia,
  getMediaDetails,
  getMediaImages,
  getEpisodeImages,
  fetchComprehensiveMediaDetails,
  getCollectionDetails,
  fetchEnhancedCollectionData
} from '../utils/tmdb.mjs';
import { classifyTmdbError } from '../utils/tmdbErrors.mjs';

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
 * The hash input excludes fields that differ between content-identical
 * responses, so the ETag stays stable across fresh fetches, SQLite cache
 * hits, and TMDB 304 re-ups of the same underlying payload:
 *   - _cached/_cachedAt/_expiresAt/_etag/_notModified — makeTmdbRequest's
 *     cache bookkeeping, which takes a different shape on each of its three
 *     paths (cache hit / fresh fetch / TMDB 304 re-up); the same set
 *     fileUtils strips before persisting metadata.
 *   - last_updated — THIS SERVER's per-request assembly stamp
 *     (getMediaDetails/getEpisodeDetails/fetchComprehensiveMediaDetails),
 *     not a TMDB field. If TMDB ever ships a content field with this name,
 *     rename our stamp rather than removing the entry.
 *
 * INVARIANT: this list may only ever name server-stamped fields — stripping
 * a real TMDB content field would produce false 304s and pin stale data in
 * client caches. A missed volatile field merely degrades to extra 200s.
 *
 * Fields are removed from the HASH INPUT only; the body is sent unchanged.
 * The ETag is weak for the same reason — equivalent responses can still
 * differ byte-for-byte in these fields.
 */
const ETAG_VOLATILE_FIELDS = ['_cached', '_cachedAt', '_expiresAt', '_etag', '_notModified', 'last_updated'];

function sendJsonWithETag(req, res, data) {
  // Bare-array payloads cannot carry the bookkeeping fields;
  // hash them as serialized rather than spread into an {"0": ...} object.
  let hashInput = data;
  if (!Array.isArray(data)) {
    hashInput = { ...(data ?? {}) };
    for (const field of ETAG_VOLATILE_FIELDS) {
      delete hashInput[field];
    }
  }

  const hash = crypto.createHash('md5').update(JSON.stringify(hashInput)).digest('hex');
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
 * Answer a failed TMDB route with TMDB's own verdict (see classifyTmdbError):
 * a title TMDB doesn't have is a 404 the caller should give up on, an outage
 * a 502 or 429 it should retry. Callers read `code` to label the item.
 *
 * Logs at the answer's level: a 4xx (a dead title, bad parameters, TMDB rate
 * limiting) is an expected outcome and logs a warning without a stack; only
 * a 5xx is an error here.
 */
function sendTmdbError(res, error, label) {
  const { status, code, retryAfter } = classifyTmdbError(error);
  if (status < 500) {
    logger.warn(label, { status, code, endpoint: error.endpoint, error: error.message });
  } else {
    logger.error(label, error);
  }
  if (retryAfter != null) {
    res.set('Retry-After', String(retryAfter));
  }
  return res.status(status).json(code ? { error: error.message, code } : { error: error.message });
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
    sendTmdbError(res, error, 'Search error:');
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
    sendTmdbError(res, error, 'Comprehensive details error:');
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
    return sendJsonWithETag(req, res, data);
  } catch (error) {
    sendTmdbError(res, error, 'Details error:');
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
    return sendJsonWithETag(req, res, images);
  } catch (error) {
    sendTmdbError(res, error, 'Images error:');
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
    return sendJsonWithETag(req, res, images);
  } catch (error) {
    sendTmdbError(res, error, 'Episode images error:');
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
    sendTmdbError(res, error, 'Collection details error:');
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