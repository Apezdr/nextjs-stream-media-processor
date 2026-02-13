import express from 'express';
import { createCategoryLogger } from '../lib/logger.mjs';
import { initializeDatabase, releaseDatabase, getMovieByName, getTVShowByName, withRetry, getMovies, getTVShows } from '../sqliteDatabase.mjs';
import {
  getHashesModifiedSince, 
  getMovieBlurhashData, 
  getTVShowBlurhashData
} from '../sqlite/blurhashHashes.mjs';

const logger = createCategoryLogger('blurhashRoutes');

/**
 * Initialize and configure blurhash routes
 * @returns {object} Configured Express router
 */
export function setupBlurhashRoutes() {
  const router = express.Router();

  /**
   * Get changes since a specific timestamp
   * @route GET /api/blurhash-changes
   * @param {string} since - ISO timestamp to filter by
   */
  router.get('/blurhash-changes', async (req, res) => {
  try {
    const { since } = req.query;
    
    if (!since) {
      return res.status(400).json({ 
        error: "Missing 'since' parameter. Format should be an ISO timestamp (e.g., 2023-01-01T00:00:00.000Z)." 
      });
    }
    
    const db = await initializeDatabase();
    
    // Get the changed blurhash data
    const changes = await getHashesModifiedSince(db, since);
    
    // Extract unique media IDs from changes
    const movieIds = new Set();
    const tvShowIds = new Set();
    
    changes.forEach(change => {
      if (change.media_type === 'movies') {
        movieIds.add(change.media_id);
      } else if (change.media_type === 'tv') {
        tvShowIds.add(change.media_id);
      }
    });
    
    // Create maps to store fetched media data
    const moviesMap = new Map();
    const tvShowsMap = new Map();
    
    // Only fetch the movies and TV shows that are referenced in changes
    if (movieIds.size > 0) {
      // For movies, we need to get all and filter manually since mediaId is stored as additional_metadata
      const allMovies = await getMovies();
      
      for (const movie of allMovies) {
        // Parse the _id from additional_metadata if available
        const movieId = movie._id;
        
        if (movieId && movieIds.has(movieId)) {
          moviesMap.set(movieId, {
            id: movie.id,
            name: movie.name,
            urls: movie.urls || {}
          });
        }
      }
    }
    
    if (tvShowIds.size > 0) {
      // Get all TV shows and filter them
      const allShows = await getTVShows();
      
      for (const show of allShows) {
        // Generate standardized ID
        const showId = show._id || `tv_${show.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
        
        if (tvShowIds.has(showId)) {
          tvShowsMap.set(showId, {
            id: show.id,
            name: show.name,
            poster: show.poster,
            posterBlurhash: show.posterBlurhash,
            backdrop: show.backdrop,
            backdropBlurhash: show.backdropBlurhash,
            logo: show.logo,
            logoBlurhash: show.logoBlurhash,
            seasons: show.seasons || {}
          });
        }
      }
    }
    
    await releaseDatabase(db);
    
    // Format the response to include IDs, metadata, and relative paths
    const formattedChanges = changes.map(change => {
      // Ensure timestamps are in ISO 8601 format
      const lastModified = change.last_modified ? 
        (change.last_modified.endsWith('Z') ? change.last_modified : new Date(change.last_modified).toISOString()) : 
        null;
      
      const generated = change.hash_generated ?
        (change.hash_generated.endsWith('Z') ? change.hash_generated : new Date(change.hash_generated).toISOString()) :
        null;
      
      // Get relative path based on media type and image type
      let relativePath = '';
      
      if (change.media_type === 'movies') {
        const movie = moviesMap.get(change.media_id);
        if (movie && movie.urls) {
          if (change.image_type === 'poster' && movie.urls.posterBlurhash) {
            // Append .blurhash to get the blurhash file path
            relativePath = movie.urls.posterBlurhash;
          } else if (change.image_type === 'backdrop' && movie.urls.backdropBlurhash) {
            relativePath = movie.urls.backdropBlurhash;
          } else if (change.image_type === 'logo' && movie.urls.logoBlurhash) {
            relativePath = movie.urls.logoBlurhash;
          }
        }
      } else if (change.media_type === 'tv') {
        const show = tvShowsMap.get(change.media_id);
        if (show) {
          if (!change.season_number && !change.episode_key) {
            // Show-level image
            if (change.image_type === 'poster') {
              relativePath = show.posterBlurhash ? show.posterBlurhash : '';
            } else if (change.image_type === 'backdrop') {
              relativePath = show.backdropBlurhash ? show.backdropBlurhash : '';
            } else if (change.image_type === 'logo') {
              relativePath = show.logoBlurhash ? show.logoBlurhash : '';
            }
          } else if (change.season_number && !change.episode_key) {
            // Season-level image
            const seasonKey = `Season ${change.season_number}`;
            if (show.seasons && show.seasons[seasonKey]) {
              const season = show.seasons[seasonKey];
              if (change.image_type === 'season_poster') {
                relativePath = season.seasonPosterBlurhash ? season.seasonPosterBlurhash : '';
              }
            }
          } else if (change.season_number && change.episode_key) {
            // Episode-level image
            const seasonKey = `Season ${change.season_number}`;
            if (show.seasons && 
                show.seasons[seasonKey] && 
                show.seasons[seasonKey].episodes && 
                show.seasons[seasonKey].episodes[change.episode_key]) {
              const episode = show.seasons[seasonKey].episodes[change.episode_key];
              if (change.image_type === 'thumbnail') {
                relativePath = episode.thumbnailBlurhash ? episode.thumbnailBlurhash : '';
              }
            }
          }
        }
      }

      const returnValues = {
        mediaType: change.media_type,
        mediaId: change.media_id,
        title: change.title,
        imageType: change.image_type,
        hash: change.hash,
        relativePath: relativePath,
        lastModified: lastModified,
        generated: generated
      };

      if (change.season_number) {
        returnValues.seasonNumber = parseInt(change.season_number);
      }
      if (change.episode_key) {
        returnValues.episodeKey = change.episode_key;
      }
        
      return returnValues;
    });
    
    // Set cache headers
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    
    res.json({
      timestamp: new Date().toISOString(),
      count: formattedChanges.length,
      changes: formattedChanges
    });
  } catch (error) {
    logger.error(`Error getting blurhash changes: ${error.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Get blurhash data for a specific movie
 * @route GET /api/blurhash/movie/:movieName
 */
router.get('/blurhash/movie/:movieName', async (req, res) => {
  try {
    const { movieName } = req.params;
    
    const db = await initializeDatabase();
    
    // Get movie data from database
    const movie = await getMovieByName(movieName);
    
    if (!movie) {
      await releaseDatabase(db);
      return res.status(404).json({ error: "Movie not found" });
    }
    
    // Get blurhash data by movie ID (if available) or by name
    let blurhashData;
    if (movie._id) {
      blurhashData = await getMovieBlurhashData(movie._id);
    } else {
      // Fallback to query by title directly from the blurhash_hashes table
      const blurhashRecords = await db.all(
        `SELECT * FROM blurhash_hashes 
         WHERE media_type = 'movies' AND title = ?`,
        [movieName]
      );
      
      if (blurhashRecords.length > 0) {
        // Format the data in the same structure as getMovieBlurhashData
        blurhashData = {
          imageHashes: blurhashRecords.reduce((acc, record) => {
            // Ensure timestamps are in ISO 8601 format
            const lastModified = record.last_modified ? 
              (record.last_modified.endsWith('Z') ? record.last_modified : new Date(record.last_modified).toISOString()) : 
              null;
            
            const generated = record.hash_generated ?
              (record.hash_generated.endsWith('Z') ? record.hash_generated : new Date(record.hash_generated).toISOString()) :
              null;
              
            acc[record.image_type] = {
              hash: record.hash,
              lastModified: lastModified,
              generated: generated
            };
            return acc;
          }, {})
        };
      }
    }
    
    await releaseDatabase(db);
    
    if (!blurhashData) {
      return res.status(404).json({ error: "Blurhash data not found for movie" });
    }
    
    // Set cache headers
    res.set('Cache-Control', 'public, max-age=3600'); // 1 hour
    
    res.json(blurhashData);
  } catch (error) {
    logger.error(`Error getting blurhash data for movie ${req.params.movieName}: ${error.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Get blurhash data for a specific TV show
 * @route GET /api/blurhash/tv/:showName
 */
router.get('/blurhash/tv/:showName', async (req, res) => {
  try {
    const { showName } = req.params;
    
    const db = await initializeDatabase();
    
    // Get TV show data from database
    const show = await getTVShowByName(showName);
    
    if (!show) {
      await releaseDatabase(db);
      return res.status(404).json({ error: "TV show not found" });
    }
    
    // Generate a standardized ID if not available
    const showId = show._id || `tv_${showName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    
    // Get blurhash data by show ID
    const blurhashData = await getTVShowBlurhashData(showId);
    await releaseDatabase(db);
    
    if (!blurhashData) {
      return res.status(404).json({ error: "Blurhash data not found for TV show" });
    }
    
    // Set cache headers
    res.set('Cache-Control', 'public, max-age=3600'); // 1 hour
    
    res.json(blurhashData);
  } catch (error) {
    logger.error(`Error getting blurhash data for TV show ${req.params.showName}: ${error.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Process bulk blurhash data requests
 * @route POST /api/blurhash/bulk
 */
router.post('/blurhash/bulk', express.json(), async (req, res) => {
  try {
    const { mediaItems } = req.body;
    
    if (!mediaItems || !Array.isArray(mediaItems) || mediaItems.length === 0) {
      return res.status(400).json({ 
        error: "Request body must include 'mediaItems' as a non-empty array" 
      });
    }
    
    // Limit the number of items to process
    const maxItems = 50;
    const processItems = mediaItems.slice(0, maxItems);
    
    if (mediaItems.length > maxItems) {
      logger.warn(`Bulk blurhash request exceeded max items (${mediaItems.length} > ${maxItems}). Processing first ${maxItems} items.`);
    }
    
    const db = await initializeDatabase();
    
    // Process each media item concurrently with a reasonable limit
    const results = {};
    
    await Promise.all(processItems.map(async (item) => {
      // Each item should have a type and name
      // Example: { type: 'movie', name: 'The Matrix' } or { type: 'tv', name: 'Stranger Things' }
      if (!item || !item.type || !item.name) {
        logger.warn(`Invalid media item format: ${JSON.stringify(item)}`);
        return;
      }
      
      const { type, name } = item;
      const resultKey = `${type}_${name}`;
      
      try {
        if (type === 'tv') {
          const show = await getTVShowByName(name);
          if (show) {
            const showId = show._id || `tv_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
            const tvData = await getTVShowBlurhashData(showId);
            if (tvData) {
              results[resultKey] = tvData;
            }
          }
        } else if (type === 'movie') {
          const movie = await getMovieByName(name);
          if (movie) {
            let blurhashData;
            if (movie._id) {
              blurhashData = await getMovieBlurhashData(movie._id);
            } else {
              // Fallback to query by title
              const blurhashRecords = await db.all(
                `SELECT * FROM blurhash_hashes 
                WHERE media_type = 'movies' AND title = ?`,
                [name]
              );
              
              if (blurhashRecords.length > 0) {
                blurhashData = {
                  name,
                  imageHashes: blurhashRecords.reduce((acc, record) => {
                    // Ensure timestamps are in ISO 8601 format
                    const lastModified = record.last_modified ? 
                      (record.last_modified.endsWith('Z') ? record.last_modified : new Date(record.last_modified).toISOString()) : 
                      null;
                    
                    const generated = record.hash_generated ?
                      (record.hash_generated.endsWith('Z') ? record.hash_generated : new Date(record.hash_generated).toISOString()) :
                      null;
                    
                    acc[record.image_type] = {
                      hash: record.hash,
                      lastModified: lastModified,
                      generated: generated
                    };
                    return acc;
                  }, {})
                };
              }
            }
            
            if (blurhashData) {
              results[resultKey] = blurhashData;
            }
          }
        }
      } catch (error) {
        logger.error(`Error processing item ${JSON.stringify(item)}: ${error.message}`);
      }
    }));
    
    await releaseDatabase(db);
    
    // Set cache headers
    res.set('Cache-Control', 'public, max-age=3600'); // 1 hour
    
    res.json({
      timestamp: new Date().toISOString(),
      count: Object.keys(results).length,
      results
    });
  } catch (error) {
    logger.error(`Error processing bulk blurhash request: ${error.message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

  return router;
}

export default setupBlurhashRoutes();
