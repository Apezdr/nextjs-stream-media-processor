import express from 'express';
import { createCategoryLogger } from '../lib/logger.mjs';
import { initializeDatabase, releaseDatabase, getMovieByName, getTVShowByName } from '../sqliteDatabase.mjs';
import { 
  getMediaTypeHashes, 
  getShowHashes, 
  getSeasonHashes, 
  generateMovieHashes, 
  getHash 
} from '../sqlite/metadataHashes.mjs';

const router = express.Router();
const logger = createCategoryLogger('metadataHashesRoutes');

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

/**
 * Get hash for specific title
 * @route GET /api/metadata-hashes/:mediaType/:title
 */
router.get('/metadata-hashes/:mediaType/:title', async (req, res) => {
  try {
    const { mediaType, title } = req.params;
    const decodedTitle = decodeURIComponent(title);
    
    if (mediaType !== 'movies' && mediaType !== 'tv') {
      return res.status(400).json({ 
        error: "Invalid media type. Must be 'movies' or 'tv'." 
      });
    }
    
    const db = await initializeDatabase();
    
    let result;
    if (mediaType === 'movies') {
      const movie = await getMovieByName(decodedTitle);
      if (!movie) {
        await releaseDatabase(db);
        return res.status(404).json({ error: "Movie not found" });
      }
      
      // Generate hash if needed
      await generateMovieHashes(db, movie);
      
      // Get the hash
      const hash = await getHash(db, 'movies', decodedTitle);
      result = {
        title: decodedTitle,
        hash: hash ? hash.hash : null,
        lastModified: hash ? hash.last_modified : null,
        generated: hash ? hash.hash_generated : null
      };
    } else {
      const show = await getTVShowByName(decodedTitle);
      if (!show) {
        await releaseDatabase(db);
        return res.status(404).json({ error: "TV show not found" });
      }
      
      // Get show hashes
      result = await getShowHashes(db, decodedTitle);
    }
    
    await releaseDatabase(db);
    
    // Set cache headers
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.set('ETag', `"${result.hash}"`);
    
    res.json(result);
  } catch (error) {
    logger.error(`Error getting hash for ${req.params.mediaType}/${req.params.title}: ${error.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Get hash for specific season (TV only)
 * @route GET /api/metadata-hashes/:mediaType/:title/:seasonNumber
 */
router.get('/metadata-hashes/:mediaType/:title/:seasonNumber', async (req, res) => {
  try {
    const { mediaType, title, seasonNumber } = req.params;
    const decodedTitle = decodeURIComponent(title);
    
    if (mediaType !== 'tv') {
      return res.status(400).json({ 
        error: "Invalid media type. This endpoint is for TV shows only." 
      });
    }
    
    const db = await initializeDatabase();
    
    const show = await getTVShowByName(decodedTitle);
    if (!show) {
      await releaseDatabase(db);
      return res.status(404).json({ error: "TV show not found" });
    }
    
    const seasonKey = `Season ${seasonNumber}`;
    if (!show.seasons[seasonKey]) {
      await releaseDatabase(db);
      return res.status(404).json({ error: "Season not found" });
    }
    
    // Get season hashes
    const result = await getSeasonHashes(db, decodedTitle, seasonNumber);
    
    await releaseDatabase(db);
    
    // Set cache headers
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.set('ETag', `"${result.hash}"`);
    
    res.json(result);
  } catch (error) {
    logger.error(`Error getting hash for ${req.params.mediaType}/${req.params.title}/${req.params.seasonNumber}: ${error.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
