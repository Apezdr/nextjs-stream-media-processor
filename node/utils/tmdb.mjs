import axios from 'axios';
import { createCategoryLogger } from '../lib/logger.mjs';
import {
  initializeDatabase,
  releaseDatabase,
  getTmdbCache,
  setTmdbCache,
  clearExpiredTmdbCache
} from '../sqliteDatabase.mjs';

const logger = createCategoryLogger('tmdb-utils');

// TMDB API configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

if (!TMDB_API_KEY) {
  logger.error('TMDB_API_KEY environment variable is not set');
}

/**
 * Helper function to make TMDB API requests with caching and retry logic
 * @param {string} endpoint - TMDB API endpoint (e.g., '/search/movie')
 * @param {Object} params - Query parameters
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} cacheTtlHours - Cache TTL in hours (default: 1440 = 60 days)
 * @param {boolean} forceRefresh - Force refresh cache (default: false)
 * @returns {Promise<Object>} TMDB API response data
 */
export const makeTmdbRequest = async (endpoint, params = {}, maxRetries = 3, cacheTtlHours = 1440, forceRefresh = false) => {
  const cacheDb = await initializeDatabase('tmdbCache');
  
  try {
    // Clean up expired cache entries periodically (10% chance)
    if (Math.random() < 0.1) {
      const deletedCount = await clearExpiredTmdbCache(cacheDb);
      if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} expired TMDB cache entries`);
      }
    }
    
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = await getTmdbCache(cacheDb, endpoint, params);
      if (cached) {
        logger.debug(`TMDB cache hit for ${endpoint}`);
        return {
          ...cached.data,
          _cached: true,
          _cachedAt: cached.cachedAt,
          _expiresAt: cached.expiresAt
        };
      }
    }
    
    // Make API request with retry logic
    let retries = 0;
    let backoffFactor = 1;
    let responseData;

    while (retries < maxRetries) {
      try {
        const response = await axios.get(`${TMDB_BASE_URL}${endpoint}`, {
          params: {
            api_key: TMDB_API_KEY,
            ...params
          },
          timeout: 10000
        });
        responseData = response.data;
        break;
      } catch (error) {
        if (error.response?.status === 429) {
          // Rate limited by TMDB
          const retryAfter = parseInt(error.response.headers['retry-after']) || backoffFactor;
          logger.warn(`TMDB rate limit hit, waiting ${retryAfter}s before retry ${retries + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          retries++;
          backoffFactor *= 2;
        } else if (error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND') {
          // Network/timeout error
          logger.warn(`Network error for ${endpoint}, retry ${retries + 1}/${maxRetries}: ${error.message}`);
          retries++;
          await new Promise(resolve => setTimeout(resolve, backoffFactor * 1000));
          backoffFactor *= 2;
        } else {
          logger.error(`TMDB API error for ${endpoint}:`, error.message);
          throw new Error(`TMDB API request failed: ${error.message}`);
        }
      }
    }
    
    if (!responseData) {
      throw new Error(`TMDB API request failed after ${maxRetries} retries`);
    }
    
    // Cache the response
    await setTmdbCache(cacheDb, endpoint, params, responseData, cacheTtlHours);
    logger.debug(`TMDB response cached for ${endpoint}`);
    
    return {
      ...responseData,
      _cached: false,
      _cachedAt: new Date().toISOString()
    };
    
  } finally {
    await releaseDatabase(cacheDb);
  }
};

/**
 * Search for movies or TV shows
 * @param {string} type - 'movie' or 'tv'
 * @param {string} query - Search query
 * @param {number} page - Page number (default: 1)
 * @returns {Promise<Object>} Search results
 */
export const searchMedia = async (type, query, page = 1) => {
  if (!['movie', 'tv'].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }
  
  if (!query) {
    throw new Error('Query parameter is required');
  }
  
  return await makeTmdbRequest(`/search/${type}`, { query, page });
};

/**
 * Get detailed information for a movie or TV show
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @returns {Promise<Object>} Media details with last_updated timestamp
 */
export const getMediaDetails = async (type, id) => {
  if (!['movie', 'tv'].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }
  
  const data = await makeTmdbRequest(`/${type}/${id}`);
  
  // Add last updated timestamp like the Python script
  data.last_updated = new Date().toISOString();
  
  return data;
};

/**
 * Get cast information for a movie or TV show
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @returns {Promise<Array>} Formatted cast array
 */
export const getMediaCast = async (type, id) => {
  if (!['movie', 'tv'].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }
  
  const data = await makeTmdbRequest(`/${type}/${id}/credits`);
  
  // Format cast data similar to Python script
  return data.cast?.map(member => ({
    id: member.id,
    name: member.name,
    character: member.character || '',
    profile_path: member.profile_path ? `https://image.tmdb.org/t/p/original${member.profile_path}` : null
  })) || [];
};

/**
 * Get videos/trailers for a movie or TV show
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @returns {Promise<Object>} Videos data with trailer_url
 */
export const getMediaVideos = async (type, id) => {
  if (!['movie', 'tv'].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }
  
  const data = await makeTmdbRequest(`/${type}/${id}/videos`);
  
  // Find YouTube trailer (matching Python script logic)
  const trailer = data.results?.find(video => 
    video.type === 'Trailer' && video.site === 'YouTube'
  );
  
  const trailerUrl = trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null;
  
  return { 
    trailer_url: trailerUrl,
    videos: data.results || []
  };
};

/**
 * Get images for a movie or TV show
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @returns {Promise<Object>} Images data with logo_path
 */
export const getMediaImages = async (type, id) => {
  if (!['movie', 'tv'].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }
  
  const data = await makeTmdbRequest(`/${type}/${id}/images`, {
    include_image_language: 'en,null'
  });
  
  // Find English logo (matching Python script logic)
  const logo = data.logos?.find(image => image.iso_639_1 === 'en');
  const logoPath = logo ? `https://image.tmdb.org/t/p/original${logo.file_path}` : null;
  
  return {
    logo_path: logoPath,
    backdrops: data.backdrops || [],
    posters: data.posters || [],
    logos: data.logos || []
  };
};

/**
 * Get content rating for a movie or TV show
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} id - TMDB ID
 * @returns {Promise<Object>} Rating data
 */
export const getMediaRating = async (type, id) => {
  if (!['movie', 'tv'].includes(type)) {
    throw new Error('Type must be "movie" or "tv"');
  }
  
  const endpoint = type === 'movie' ? 'release_dates' : 'content_ratings';
  const data = await makeTmdbRequest(`/${type}/${id}/${endpoint}`);
  
  let rating = null;
  
  // Match Python script logic for rating extraction
  if (type === 'movie' && data.results) {
    const usRelease = data.results.find(country => country.iso_3166_1 === 'US');
    const certifiedRelease = usRelease?.release_dates?.find(release => release.certification);
    rating = certifiedRelease?.certification || null;
  } else if (type === 'tv' && data.results) {
    const usRating = data.results.find(ratingInfo => ratingInfo.iso_3166_1 === 'US');
    rating = usRating?.rating || null;
  }
  
  return { rating };
};

/**
 * Get TV episode details
 * @param {string|number} showId - TMDB show ID
 * @param {string|number} season - Season number
 * @param {string|number} episode - Episode number
 * @returns {Promise<Object>} Episode details with last_updated timestamp
 */
export const getEpisodeDetails = async (showId, season, episode) => {
  const data = await makeTmdbRequest(`/tv/${showId}/season/${season}/episode/${episode}`);
  
  // Add last updated timestamp like Python script
  data.last_updated = new Date().toISOString();
  
  return data;
};

/**
 * Get TV episode images
 * @param {string|number} showId - TMDB show ID
 * @param {string|number} season - Season number
 * @param {string|number} episode - Episode number
 * @returns {Promise<Object>} Episode images with thumbnail_url
 */
export const getEpisodeImages = async (showId, season, episode) => {
  const data = await makeTmdbRequest(`/tv/${showId}/season/${season}/episode/${episode}/images`);
  
  const thumbnailUrl = data.stills?.[0]?.file_path ? 
    `https://image.tmdb.org/t/p/original${data.stills[0].file_path}` : null;
  
  return {
    thumbnail_url: thumbnailUrl,
    stills: data.stills || []
  };
};

/**
 * Fetch comprehensive media details including cast, trailer, logo, and rating
 * Similar to the Python script's fetch_tmdb_media_details function
 * @param {string} name - Media name for search
 * @param {string} type - 'movie' or 'tv'
 * @param {string|number} tmdbId - Optional TMDB ID (if known)
 * @returns {Promise<Object>} Comprehensive media details
 */
export const fetchComprehensiveMediaDetails = async (name, type = 'tv', tmdbId = null) => {
  let id = tmdbId;
  
  // If no TMDB ID provided, search for it
  if (!id) {
    const searchResults = await searchMedia(type, name);
    if (!searchResults.results || searchResults.results.length === 0) {
      // Try removing year from name and search again
      const nameWithoutYear = name.replace(/\s*\(\d{4}\)/, '');
      const retryResults = await searchMedia(type, nameWithoutYear);
      if (!retryResults.results || retryResults.results.length === 0) {
        throw new Error(`No results found for ${type}: ${name}`);
      }
      id = retryResults.results[0].id;
    } else {
      id = searchResults.results[0].id;
    }
  }
  
  // Fetch all details in parallel
  const [details, cast, videos, images, rating] = await Promise.all([
    getMediaDetails(type, id),
    getMediaCast(type, id),
    getMediaVideos(type, id),
    getMediaImages(type, id),
    getMediaRating(type, id)
  ]);
  
  // Combine all data similar to Python script
  return {
    ...details,
    cast,
    trailer_url: videos.trailer_url,
    logo_path: images.logo_path,
    rating: rating.rating,
    last_updated: new Date().toISOString()
  };
};