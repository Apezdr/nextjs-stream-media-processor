import express from 'express';
import { createCategoryLogger } from '../lib/logger.mjs';
import { initializeDatabase, releaseDatabase } from '../sqliteDatabase.mjs';
import { getMediaTypeHashes } from '../sqlite/metadataHashes.mjs';

const logger = createCategoryLogger('metadataHashesRoutes');

/**
 * Initialize and configure metadata hashes routes
 * @returns {object} Configured Express router
 */
export function setupMetadataHashesRoutes() {
  const router = express.Router();

  /**
   * Get all media type hashes
   * @route GET /api/metadata-hashes/:mediaType
   */
  router.get('/metadata-hashes/:mediaType', async (req, res) => {
  try {
    const { mediaType } = req.params;
    
    if (mediaType !== 'movies' && mediaType !== 'tv') {
      return res.status(400).json({ 
        error: "Invalid media type. Must be 'movies' or 'tv'." 
      });
    }
    
    const db = await initializeDatabase();
    const hashes = await getMediaTypeHashes(db, mediaType);
    await releaseDatabase(db);
    
    // Set cache headers
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.set('ETag', `"${hashes.hash}"`);
    
    res.json(hashes);
  } catch (error) {
    logger.error(`Error getting ${req.params.mediaType} hashes: ${error.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

  return router;
}

export default setupMetadataHashesRoutes();
