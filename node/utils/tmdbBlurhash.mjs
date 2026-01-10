import axios from 'axios';
import { promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import { createCategoryLogger } from '../lib/logger.mjs';
import { execAsync } from './utils.mjs';
import {
  getCachedTmdbBlurhashWithDb,
  cacheTmdbBlurhashWithDb,
  clearExpiredTmdbBlurhashCacheWithDb
} from '../sqlite/tmdbBlurhashCache.mjs';
import { generateBlurhashFromBuffer } from './blurhashNative.mjs';

const logger = createCategoryLogger('tmdb-blurhash');

// Feature flag: use native Node.js blurhash (faster) or Python subprocess (legacy)
const USE_NATIVE_BLURHASH = process.env.USE_NATIVE_BLURHASH !== 'false'; // Default to true

/**
 * Semaphore for limiting concurrent operations
 */
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.active >= this.max) {
      await new Promise((r) => this.queue.push(r));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// Limit concurrent download+python executions (tune with env var)
const downloadExecSem = new Semaphore(Number(process.env.BLURHASH_CONCURRENCY || 4));

// Deduplicate in-flight blurhash generation
const inflight = new Map(); // cacheKey -> Promise<string|null>

function dedupe(cacheKey, fn) {
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const p = (async () => {
    try {
      return await fn();
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, p);
  return p;
}

/**
 * Map blurhash size to appropriate TMDB image size (smaller = faster)
 * @param {string} size - Blurhash size: 'small', 'medium', 'large'
 * @returns {string} - TMDB image size
 */
function tmdbSizeForBlurhash(size) {
  switch (size) {
    case 'small': return 'w92';
    case 'medium': return 'w154';
    case 'large': return 'w342';
    default: return 'w342';
  }
}

/**
 * Normalize a TMDB image URL to use the specified size
 * @param {string} imageUrl - Full TMDB image URL
 * @param {string} blurhashSize - Blurhash size: 'small', 'medium', 'large'
 * @returns {string} - Normalized URL with correct size
 */
function normalizeTmdbImageUrl(imageUrl, blurhashSize) {
  const want = tmdbSizeForBlurhash(blurhashSize);
  
  // Replace /t/p/<size>/ with /t/p/<want>/
  // <size> is "original" or "w<number>"
  return imageUrl.replace(/(https:\/\/image\.tmdb\.org\/t\/p\/)(original|w\d+)(\/)/, `$1${want}$3`);
}

/**
 * Generate blurhash for a TMDB image URL
 * @param {string} imageUrl - Full TMDB image URL
 * @param {string} size - Size option: 'small' (64px), 'medium' (100px), 'large' (150px, default)
 * @returns {Promise<string|null>} - Base64 encoded blurhash or null if generation failed
 */
export async function generateTmdbImageBlurhash(imageUrl, size = 'large') {
  // Normalize URL and use it for cache key to avoid duplicates
  const canonicalUrl = normalizeTmdbImageUrl(imageUrl, size);
  const cacheKey = `${canonicalUrl}#${size}`;
  
  return dedupe(cacheKey, async () => {
    try {
      // Check cache first using encapsulated database function
      const cached = await getCachedTmdbBlurhashWithDb(cacheKey);
      if (cached) {
        logger.debug(`Blurhash cache hit for ${imageUrl} (${size})`);
        return cached;
      }
      
      // Limit concurrent download operations
      return await downloadExecSem.run(async () => {
        try {
          // Download image into memory (faster than disk I/O)
          const response = await axios({
            method: 'get',
            url: canonicalUrl,
            responseType: 'arraybuffer',  // Get raw bytes, no temp files needed
            timeout: 5000,
            maxContentLength: 5 * 1024 * 1024, // 5MB limit
            maxBodyLength: 5 * 1024 * 1024,
            validateStatus: (s) => s >= 200 && s < 300,
            headers: {
              'User-Agent': 'nextjs-stream-media-processor/1.0'
            }
          });
          
          const imageBuffer = Buffer.from(response.data);
          const fileSize = imageBuffer.length;
          
          let blurhashBase64;
          
          // Use native implementation if enabled, otherwise fall back to Python
          if (USE_NATIVE_BLURHASH) {
            try {
              blurhashBase64 = await generateBlurhashFromBuffer(imageBuffer, size);
              logger.debug(`Generated blurhash using native implementation for ${imageUrl} (${size})`);
            } catch (nativeError) {
              logger.warn(`Native blurhash failed, falling back to Python: ${nativeError.message}`);
              // Fall through to Python implementation below
              blurhashBase64 = null;
            }
          }
          
          // Python fallback if native is disabled or failed
          if (!blurhashBase64) {
            // Use system temp directory for Python subprocess
            let tempDir = path.join(os.tmpdir(), 'tmdb_images');
            try {
              await fs.mkdir(tempDir, { recursive: true });
            } catch (error) {
              tempDir = path.join(os.tmpdir(), `tmdb_images_${Date.now()}`);
              await fs.mkdir(tempDir, { recursive: true });
            }
            
            const imageExt = path.extname(imageUrl) || '.jpg';
            const uniqueFilename = `tmdb_${Date.now()}_${Math.random().toString(36).substring(2, 15)}${imageExt}`;
            const imagePath = path.join(tempDir, uniqueFilename);
            
            try {
              // Write buffer to disk for Python script
              await fs.writeFile(imagePath, imageBuffer);
              
              // Generate blurhash using Python script
              const pythonExecutable = process.env.PYTHON_EXECUTABLE || (process.platform === "win32" ? "python" : "python3");
              const blurhashCli = path.join(process.cwd(), 'scripts', 'utils', 'blurhash_cli.py');
              
              const result = await execAsync(`"${pythonExecutable}" "${blurhashCli}" "${imagePath}" "${size}"`);
              blurhashBase64 = result.stdout.trim();
              
              if (result.stderr && result.stderr.trim()) {
                logger.warn(`Python script warnings for ${imageUrl} (${size}): ${result.stderr}`);
              }
              
              logger.debug(`Generated blurhash using Python for ${imageUrl} (${size})`);
            } finally {
              // Clean up temp file
              try {
                await fs.unlink(imagePath);
              } catch (cleanupError) {
                // Ignore cleanup errors
              }
            }
          }
          
          if (!blurhashBase64) {
            logger.error(`Failed to generate blurhash for ${imageUrl} (${size})`);
            return null;
          }
          
          // Cache the result
          await cacheTmdbBlurhashWithDb(cacheKey, blurhashBase64, 2160, { file_size: fileSize });
          logger.debug(`Cached blurhash for ${imageUrl} (${size})`);
          
          return blurhashBase64;
        } catch (error) {
          logger.error(`Error in blurhash generation pipeline: ${error.message}`);
          return null;
        }
      });
    } catch (error) {
      logger.error(`Error generating blurhash for ${imageUrl} (${size}): ${error.message}`);
      return null;
    }
  });
}

/**
 * Generate a small blurhash optimized for search results
 * @param {string} imageUrl - Full TMDB image URL
 * @returns {Promise<string|null>} - Small base64 encoded blurhash
 */
export async function generateSmallTmdbImageBlurhash(imageUrl) {
  return await generateTmdbImageBlurhash(imageUrl, 'small');
}

/**
 * Get TMDB image URL with specified size
 * @param {string} filePath - TMDB image file path
 * @param {string} size - Image size (e.g., 'original', 'w780', 'w500')
 * @returns {string} Full image URL
 */
function getTMDBImageURL(filePath, size = 'original') {
  if (!filePath) return null;
  return `https://image.tmdb.org/t/p/${size}${filePath}`;
}

/**
 * Map items with a concurrency limit
 * @param {Array} items - Items to map
 * @param {number} limit - Maximum concurrent operations
 * @param {Function} mapper - Async mapper function
 * @returns {Promise<Array>} - Mapped results
 */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let i = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      // Best-effort: return original item if mapper fails
      try {
        results[idx] = await mapper(items[idx], idx);
      } catch (error) {
        logger.warn(`mapLimit: mapper failed for item ${idx}: ${error.message}`);
        results[idx] = items[idx];
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Enhance a TMDB response with blurhash data for images
 * @param {Object} response - TMDB API response
 * @param {string} endpoint - The API endpoint that was called
 * @returns {Promise<Object>} - Enhanced response with blurhash data
 */
export async function enhanceTmdbResponseWithBlurhash(response, endpoint) {
  const enhancedResponse = { ...response };
  
  try {
    // Concurrency limit for image enhancement
    const enhanceConcurrency = Number(process.env.TMDB_IMAGES_ENHANCE_CONCURRENCY || 6);
    
    // Process main poster/backdrop/logo if present
    if (enhancedResponse.poster_path) {
      const posterUrl = getTMDBImageURL(enhancedResponse.poster_path, tmdbSizeForBlurhash('large'));
      const posterBlurhash = await generateTmdbImageBlurhash(posterUrl);
      if (posterBlurhash) {
        enhancedResponse.poster_blurhash = posterBlurhash;
      }
    }
    
    if (enhancedResponse.backdrop_path) {
      const backdropUrl = getTMDBImageURL(enhancedResponse.backdrop_path, tmdbSizeForBlurhash('large'));
      const backdropBlurhash = await generateTmdbImageBlurhash(backdropUrl);
      if (backdropBlurhash) {
        enhancedResponse.backdrop_blurhash = backdropBlurhash;
      }
    }
    
    if (enhancedResponse.logo_path) {
      const logoUrl = getTMDBImageURL(enhancedResponse.logo_path, tmdbSizeForBlurhash('large'));
      const logoBlurhash = await generateTmdbImageBlurhash(logoUrl);
      if (logoBlurhash) {
        enhancedResponse.logo_blurhash = logoBlurhash;
      }
    }
    
    // Process images collection if present (for /images endpoint)
    if (endpoint.includes('/images') && enhancedResponse.backdrops) {
      // Process backdrops with concurrency limit
      enhancedResponse.backdrops = await mapLimit(
        enhancedResponse.backdrops,
        enhanceConcurrency,
        async (backdrop) => {
          if (!backdrop.file_path) return backdrop;
          const imageUrl = getTMDBImageURL(backdrop.file_path, tmdbSizeForBlurhash('large'));
          const blurhash = await generateTmdbImageBlurhash(imageUrl);
          return blurhash ? { ...backdrop, blurhash } : backdrop;
        }
      );
    }
    
    if (endpoint.includes('/images') && enhancedResponse.posters) {
      // Process posters with concurrency limit
      enhancedResponse.posters = await mapLimit(
        enhancedResponse.posters,
        enhanceConcurrency,
        async (poster) => {
          if (!poster.file_path) return poster;
          const imageUrl = getTMDBImageURL(poster.file_path, tmdbSizeForBlurhash('large'));
          const blurhash = await generateTmdbImageBlurhash(imageUrl);
          return blurhash ? { ...poster, blurhash } : poster;
        }
      );
    }
    
    if (endpoint.includes('/images') && enhancedResponse.logos) {
      // Process logos with concurrency limit
      enhancedResponse.logos = await mapLimit(
        enhancedResponse.logos,
        enhanceConcurrency,
        async (logo) => {
          if (!logo.file_path) return logo;
          const imageUrl = getTMDBImageURL(logo.file_path, tmdbSizeForBlurhash('large'));
          const blurhash = await generateTmdbImageBlurhash(imageUrl);
          return blurhash ? { ...logo, blurhash } : logo;
        }
      );
    }
    
    // Process collection parts if present
    if (enhancedResponse.parts && Array.isArray(enhancedResponse.parts)) {
      // Process collection parts with concurrency limit
      enhancedResponse.parts = await mapLimit(
        enhancedResponse.parts,
        enhanceConcurrency,
        async (part) => {
          const enhancedPart = { ...part };
          
          if (enhancedPart.poster_path) {
            const posterUrl = getTMDBImageURL(enhancedPart.poster_path, tmdbSizeForBlurhash('large'));
            const posterBlurhash = await generateTmdbImageBlurhash(posterUrl);
            if (posterBlurhash) {
              enhancedPart.poster_blurhash = posterBlurhash;
            }
          }
          
          if (enhancedPart.backdrop_path) {
            const backdropUrl = getTMDBImageURL(enhancedPart.backdrop_path, tmdbSizeForBlurhash('large'));
            const backdropBlurhash = await generateTmdbImageBlurhash(backdropUrl);
            if (backdropBlurhash) {
              enhancedPart.backdrop_blurhash = backdropBlurhash;
            }
          }
          
          return enhancedPart;
        }
      );
    }
    
    // Process search results if present
    if (enhancedResponse.results && Array.isArray(enhancedResponse.results)) {
      // Process search results with SMALL blurhashes and concurrency limit
      // Only process poster for search results - backdrop adds minimal value and doubles processing time
      enhancedResponse.results = await mapLimit(
        enhancedResponse.results,
        enhanceConcurrency,
        async (result) => {
          const enhancedResult = { ...result };
          
          // Only process poster for search results (50% faster than including backdrop)
          if (enhancedResult.poster_path) {
            const posterUrl = getTMDBImageURL(enhancedResult.poster_path, tmdbSizeForBlurhash('small'));
            const posterBlurhash = await generateSmallTmdbImageBlurhash(posterUrl);
            if (posterBlurhash) {
              enhancedResult.poster_blurhash = posterBlurhash;
            }
          }
          
          // Backdrop intentionally skipped for search results to improve performance
          // Detail endpoints (comprehensive, details, images, etc.) will still include backdrop blurhash
          
          return enhancedResult;
        }
      );
    }
    
    return enhancedResponse;
  } catch (error) {
    logger.error(`Error enhancing response with blurhash: ${error.message}`);
    return response; // Return original response if enhancement fails
  }
}

/**
 * Generate a cache key that includes blurhash indicator
 * @param {string} endpoint - TMDB API endpoint
 * @param {Object} params - Request parameters
 * @param {boolean} includeBlurhash - Whether blurhash is included
 * @returns {string} - Cache key
 */
export function generateBlurhashCacheKey(endpoint, params, includeBlurhash) {
  if (!includeBlurhash) {
    return null; // Use default cache key generation
  }
  
  // Sort params for consistent cache keys
  const sortedParams = Object.keys(params)
    .sort()
    .reduce((result, key) => {
      result[key] = params[key];
      return result;
    }, {});
  
  return `${endpoint}_${JSON.stringify(sortedParams)}_blurhash`;
}
