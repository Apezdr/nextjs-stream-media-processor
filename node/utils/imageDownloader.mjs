import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import path from 'path';
import axios from 'axios';
import pLimit from 'p-limit';
import { createCategoryLogger } from '../lib/logger.mjs';
import { extractFileExtension, touchFile, pathExists, getFileAgeDays } from './fileUtils.mjs';
import { generateBlurhash } from './blurhashNative.mjs';
import { withApiRequestSpan, recordImageOutcome } from '../lib/apiTracer.mjs';
import { getConvention, resolveEffectiveImageUrl } from '../components/media-scanner/domain/image-conventions.mjs';
import { sidecarBlurhashSizeForImageType } from './blurhashSizePolicy.mjs';

const logger = createCategoryLogger('image-downloader');

// Configurable refresh intervals from environment variables
const season_poster_refresh_days = parseInt(process.env.SEASON_POSTER_REFRESH_DAYS) || 1;
const episode_thumbnail_refresh_days = parseInt(process.env.EPISODE_THUMBNAIL_REFRESH_DAYS) || 3;

const IMAGE_DOWNLOAD_MAX_RETRIES = parseInt(process.env.TMDB_IMAGE_MAX_RETRIES) || 5;
const IMAGE_DOWNLOAD_CONCURRENCY = parseInt(process.env.TMDB_IMAGE_CONCURRENCY) || 5;

async function fetchImageStream(imageUrl, timeout, imageType) {
  let lastError;
  let backoffSeconds = 1;

  for (let attempt = 0; attempt < IMAGE_DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      return await withApiRequestSpan(
        {
          service: 'tmdb-images',
          method: 'GET',
          url: imageUrl,
          endpoint: imageType || 'image'
        },
        async () =>
          axios({
            method: 'get',
            url: imageUrl,
            responseType: 'stream',
            timeout,
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; MetadataGenerator/1.0)'
            }
          })
      );
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const code = error.code;
      const retryable =
        status === 429 ||
        status === 503 ||
        code === 'ECONNABORTED' ||
        code === 'ENOTFOUND' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT';

      const isLastAttempt = attempt === IMAGE_DOWNLOAD_MAX_RETRIES - 1;
      if (!retryable || isLastAttempt) {
        throw error;
      }

      let waitSeconds = backoffSeconds;
      if (status === 429) {
        const retryAfter = parseInt(error.response.headers?.['retry-after']);
        if (!Number.isNaN(retryAfter)) waitSeconds = retryAfter;
      }

      logger.warn(
        `Image download attempt ${attempt + 1}/${IMAGE_DOWNLOAD_MAX_RETRIES} failed for ${imageUrl} ` +
        `(${status || code || error.message}); retrying in ${waitSeconds}s`
      );
      await new Promise((r) => setTimeout(r, waitSeconds * 1000));
      backoffSeconds *= 2;
    }
  }

  throw lastError;
}

/**
 * Download an image from URL and save to local path
 * @param {string} imageUrl - URL of image to download
 * @param {string} destPath - Destination file path
 * @param {Object} options - Download options
 * @param {boolean} options.forceDownload - Force re-download even if file exists
 * @param {number} options.timeout - Request timeout in milliseconds (default: 30000)
 * @param {string} options.imageType - Image kind ('poster' | 'backdrop' | 'logo' | 'season-poster' | 'episode-thumbnail') for telemetry endpoint tagging
 * @param {string} options.mediaName - Show or movie name for structured logging
 * @param {string} options.mediaType - 'tv' | 'movie' for structured logging + metrics
 * @param {boolean} options.skipExistsCheck - If true, the caller already decided to download; skip the file-exists short-circuit and do not record a cache-hit outcome here
 * @returns {Promise<boolean>} Whether download was successful
 */
export async function downloadImage(imageUrl, destPath, options = {}) {
  const {
    forceDownload = false,
    timeout = 30000,
    imageType,
    mediaName,
    mediaType,
    skipExistsCheck = false
  } = options;

  const logMeta = {
    'image.type': imageType,
    'image.url': imageUrl,
    'image.dest': destPath,
    'media.name': mediaName,
    'media.type': mediaType
  };

  try {
    // Check if image already exists and skip if not forcing download.
    // Callers that already performed their own freshness check (e.g.
    // downloadMediaImages, downloadSeasonPoster) pass skipExistsCheck=true
    // so this branch doesn't double-count their cache-hit decision.
    if (!skipExistsCheck && !forceDownload && await pathExists(destPath)) {
      logger.debug(`Image already exists at ${destPath}. Skipping download.`, logMeta);
      recordImageOutcome({ imageType, outcome: 'cache-hit', mediaType });
      return true;
    }

    // Ensure destination directory exists
    const destDir = path.dirname(destPath);
    await fs.mkdir(destDir, { recursive: true });

    // Download the image (instrumented + retried on 429/network errors)
    logger.debug(`Downloading image from ${imageUrl} to ${destPath}`, logMeta);

    const response = await fetchImageStream(imageUrl, timeout, imageType);

    // Check response status
    if (response.status !== 200) {
      logger.warn(`Failed to download image. HTTP Status: ${response.status}`, logMeta);
      recordImageOutcome({ imageType, outcome: 'failed', mediaType });
      return false;
    }

    // Create write stream and pipe response
    const writeStream = createWriteStream(destPath);

    try {
      // Pipe the response data to the write stream
      response.data.pipe(writeStream);

      // Wait for the stream to finish using async/await approach
      await finished(writeStream);

      // Verify file was written and has content
      const stats = await fs.stat(destPath);
      if (stats.size > 0) {
        logger.info(`Image successfully downloaded and saved to ${destPath}`, logMeta);
        recordImageOutcome({ imageType, outcome: 'downloaded', mediaType });
        return true;
      } else {
        logger.error(`Downloaded file is empty: ${destPath}`, logMeta);
        recordImageOutcome({ imageType, outcome: 'failed', mediaType });
        // Clean up empty file
        await fs.unlink(destPath).catch(() => {});
        return false;
      }

    } catch (error) {
      logger.error(`Error during stream operation: ${error.message}`, logMeta);
      recordImageOutcome({ imageType, outcome: 'failed', mediaType });
      // Clean up partial file
      await fs.unlink(destPath).catch(() => {});
      return false;
    }

  } catch (error) {
    logger.error(`HTTP error occurred while downloading image from ${imageUrl}: ${error.message}`, logMeta);
    recordImageOutcome({ imageType, outcome: 'failed', mediaType });
    return false;
  }
}

/**
 * Download image and generate blurhash
 * Matches Python script's download_image_file function
 * @param {string} imageUrl - URL of image to download
 * @param {string} destPath - Destination file path
 * @param {Object} options - Download options
 * @param {boolean} options.forceDownload - Force re-download even if file exists
 * @param {boolean} options.generateBlurhash - Whether to generate blurhash (default: true)
 * @param {string} options.imageType - Image type ('backdrop', 'poster', 'logo') for size optimization
 * @returns {Promise<Object>} Result object with success status and blurhash
 */
export async function downloadImageWithBlurhash(imageUrl, destPath, options = {}) {
  const {
    forceDownload = false,
    generateBlurhash: shouldGenerateBlurhash = true,
    imageType = 'poster', // Default to poster for backwards compatibility
    mediaName,
    mediaType,
    skipExistsCheck = false
  } = options;
  
  // Encode size comes from the shared sidecar policy (B-2b) — the single
  // source both sidecar writers draw from, so this pipeline and the lazy
  // getStoredBlurhash() path cannot drift apart again.
  const blurhashSize = sidecarBlurhashSizeForImageType(imageType);

  try {
    const blurhashPath = `${destPath}.blurhash`;
    
    // Check if download is actually needed first
    const imageExists = await pathExists(destPath);
    const blurhashExists = await pathExists(blurhashPath);
    const needsDownload = forceDownload || !imageExists;
    
    // Only remove blurhash file if we're actually going to re-download the image
    if (needsDownload && blurhashExists) {
      try {
        await fs.unlink(blurhashPath);
        logger.debug(`Deleted existing blurhash file for re-download: ${blurhashPath}`);
      } catch (error) {
        logger.warn(`Error deleting blurhash file: ${error.message}`);
      }
    }

    // Download the image
    const downloadSuccess = await downloadImage(imageUrl, destPath, {
      forceDownload,
      imageType,
      mediaName,
      mediaType,
      skipExistsCheck
    });
    
    if (!downloadSuccess) {
      return {
        success: false,
        downloadSuccess: false,
        blurhashGenerated: false,
        error: 'Image download failed'
      };
    }

    let blurhashGenerated = false;
    let blurhashValue = null;

    // Generate blurhash if requested and file exists
    if (shouldGenerateBlurhash && await pathExists(destPath)) {
      // Only generate blurhash if it doesn't exist or we just downloaded the image
      const blurhashNeedsGeneration = !await pathExists(blurhashPath) || needsDownload;
      
      if (blurhashNeedsGeneration) {
        try {
          const stats = await fs.stat(destPath);
          if (stats.size > 0) {
            blurhashValue = await generateImageBlurhash(destPath, blurhashPath, blurhashSize);
            blurhashGenerated = !!blurhashValue;
          } else {
            logger.warn(`Cannot generate blurhash for empty file: ${destPath}`);
          }
        } catch (error) {
          logger.warn(`Failed to generate blurhash for ${destPath}: ${error.message}`);
        }
      } else {
        // Blurhash already exists and image wasn't re-downloaded, just read it
        try {
          blurhashValue = await fs.readFile(blurhashPath, 'utf8');
          blurhashGenerated = false; // Not newly generated, but exists
          logger.debug(`Using existing blurhash for ${destPath}`);
        } catch (error) {
          logger.debug(`Could not read existing blurhash, will regenerate: ${error.message}`);
          // Fall back to generating it
          try {
            const stats = await fs.stat(destPath);
            if (stats.size > 0) {
              blurhashValue = await generateImageBlurhash(destPath, blurhashPath, blurhashSize);
              blurhashGenerated = !!blurhashValue;
            }
          } catch (genError) {
            logger.warn(`Failed to generate blurhash for ${destPath}: ${genError.message}`);
          }
        }
      }
    }

    return {
      success: true,
      downloadSuccess: needsDownload,
      blurhashGenerated,
      blurhash: blurhashValue
    };

  } catch (error) {
    logger.error(`Unexpected error in downloadImageWithBlurhash: ${error.message}`);
    return {
      success: false,
      downloadSuccess: false,
      blurhashGenerated: false,
      error: error.message
    };
  }
}

/**
 * Generate blurhash for an existing image file
 * @param {string} imagePath - Path to image file
 * @param {string} blurhashPath - Path to save blurhash file
 * @param {string} size - Size option: 'small' (16px), 'medium' (24px), 'large' (32px, default)
 * @returns {Promise<string|null>} Blurhash string or null if generation failed
 */
export async function generateImageBlurhash(imagePath, blurhashPath, size = 'large') {
  try {
    logger.debug(`Generating blurhash for ${imagePath} with size: ${size}`);
    
    // Generate blurhash using the existing native implementation with specified size
    const blurhashString = await generateBlurhash(imagePath, size);
    
    if (blurhashString && blurhashString.length > 0) {
      // Save blurhash to file
      await fs.writeFile(blurhashPath, blurhashString, 'utf8');
      logger.debug(`Blurhash saved to ${blurhashPath} (size: ${size})`);
      return blurhashString;
    } else {
      logger.warn(`No valid blurhash generated for ${imagePath}`);
      return null;
    }
    
  } catch (error) {
    logger.error(`Error generating blurhash for ${imagePath}: ${error.message}`);
    return null;
  }
}

/**
 * Download multiple image types for media (backdrop, poster, logo)
 * @param {Object} mediaData - TMDB media data
 * @param {string} mediaDir - Media directory path
 * @param {Object} config - TMDB config with potential overrides
 * @param {string} mediaType - 'tv' or 'movie' for file naming
 * @param {Object} options - Download options
 * @returns {Promise<Object>} Download results
 */
export async function downloadMediaImages(mediaData, mediaDir, config, mediaType, options = {}) {
  const {
    forceDownload = false,
    generateBlurhash: shouldGenerateBlurhash = true
  } = options;
  const mediaName = options.mediaName || path.basename(mediaDir);

  const results = {
    backdrop: { success: false, path: null },
    poster: { success: false, path: null },
    logo: { success: false, path: null }
  };

  // Image type mappings. Prefixes come from the shared image-conventions
  // module so the scanner's discovery rules and the downloader's write
  // rules stay in sync.
  const imageTypes = {
    backdrop_path: {
      key: 'backdrop',
      prefix: getConvention(mediaType, 'backdrop').prefix,
      overrideKey: 'override_backdrop'
    },
    poster_path: {
      key: 'poster',
      prefix: getConvention(mediaType, 'poster').prefix,
      overrideKey: 'override_poster'
    },
    logo_path: {
      key: 'logo',
      prefix: getConvention(mediaType, 'logo').prefix,
      overrideKey: 'override_logo'
    }
  };

  const limit = pLimit(IMAGE_DOWNLOAD_CONCURRENCY);

  await Promise.all(
    Object.entries(imageTypes).map(([dataKey, imageInfo]) =>
      limit(async () => {
        const logMeta = {
          'image.type': imageInfo.key,
          'media.name': mediaName,
          'media.type': mediaType
        };
        try {
          // Effective-URL precedence and CDN prefixing live in the shared
          // resolver (I-5); full-URL override values pass through verbatim
          // instead of being prefixed into garbage (I-7a).
          const imageUrl = resolveEffectiveImageUrl({
            tmdbConfig: config,
            metadata: mediaData,
            imageKey: imageInfo.key
          });
          if (config?.[imageInfo.overrideKey]) {
            logger.debug(`Using override ${imageInfo.key} image: ${config[imageInfo.overrideKey]}`, logMeta);
          }

          if (!imageUrl) {
            logger.debug(`No ${imageInfo.key} image URL found for media`, logMeta);
            recordImageOutcome({ imageType: imageInfo.key, outcome: 'no-url', mediaType });
            return;
          }

          // Determine file extension and create destination path
          const extension = extractFileExtension(imageUrl) || '.jpg';
          const fileName = `${imageInfo.prefix}${extension}`;
          const destPath = path.join(mediaDir, fileName);

          if (!forceDownload && await pathExists(destPath)) {
            // Skip download if file exists and not forcing. `url` carries the
            // CURRENT effective URL (not necessarily what the existing file was
            // downloaded from) — consumers must treat it as adoption-quality
            // provenance only (I-3: adopted when nothing better is stored).
            logger.debug(`${imageInfo.key} image already exists: ${fileName}`, logMeta);
            recordImageOutcome({ imageType: imageInfo.key, outcome: 'cache-hit', mediaType });
            results[imageInfo.key] = { success: true, path: destPath, skipped: true, outcome: 'cache-hit', url: imageUrl };
            return;
          }

          // Download image with appropriate blurhash size for image type
          const result = await downloadImageWithBlurhash(imageUrl, destPath, {
            forceDownload,
            generateBlurhash: shouldGenerateBlurhash,
            imageType: imageInfo.key, // Pass image type for size optimization (backdrop = small, poster/logo = large)
            mediaName,
            mediaType,
            skipExistsCheck: true // we already did the existence check above
          });

          if (result.success) {
            results[imageInfo.key] = {
              success: true,
              path: destPath,
              blurhash: result.blurhash,
              downloaded: true,
              outcome: 'downloaded',
              // True download provenance (I-3): the bytes at destPath came
              // from exactly this URL.
              url: imageUrl
            };
            logger.info(`Successfully downloaded ${imageInfo.key} image: ${fileName}`, logMeta);
          } else {
            results[imageInfo.key] = { success: false, path: destPath, error: result.error, outcome: 'failed', url: imageUrl };
            logger.warn(`Failed to download ${imageInfo.key} image: ${result.error}`, logMeta);
          }
        } catch (error) {
          logger.error(`Error processing ${imageInfo.key} image: ${error.message}`, logMeta);
          recordImageOutcome({ imageType: imageInfo.key, outcome: 'failed', mediaType });
          results[imageInfo.key] = { success: false, error: error.message, outcome: 'failed' };
        }
      })
    )
  );

  return results;
}

/**
 * Download season poster image
 * @param {string} seasonPosterUrl - Season poster URL from TMDB
 * @param {string} seasonDir - Season directory path
 * @param {Object} options - Download options
 * @returns {Promise<Object>} Download result
 */
export async function downloadSeasonPoster(seasonPosterUrl, seasonDir, options = {}) {
  const {
    forceDownload = false,
    generateBlurhash: shouldGenerateBlurhash = true,
    mediaName,
    mediaType = 'tv'
  } = options;

  const fileName = 'season_poster.jpg';
  const destPath = path.join(seasonDir, fileName);
  const logMeta = {
    'image.type': 'season-poster',
    'image.dest': destPath,
    'media.name': mediaName,
    'media.type': mediaType
  };

  try {
    // Check if refresh is needed (matches Python script logic)
    if (!forceDownload && await pathExists(destPath)) {
      const daysSinceModified = await getFileAgeDays(destPath);
      if (daysSinceModified !== null && daysSinceModified < season_poster_refresh_days) {
        logger.debug(`Season poster is recent, skipping download: ${destPath}`, logMeta);
        recordImageOutcome({ imageType: 'season-poster', outcome: 'cache-hit-fresh', mediaType });
        return { success: true, path: destPath, skipped: true, outcome: 'cache-hit-fresh' };
      }
    }

    const result = await downloadImageWithBlurhash(seasonPosterUrl, destPath, {
      forceDownload,
      generateBlurhash: shouldGenerateBlurhash,
      imageType: 'season-poster',
      mediaName,
      mediaType,
      skipExistsCheck: true
    });

    if (result.success) {
      // Touch the file to update timestamp (matches Python script)
      await touchFile(destPath);
    } else {
      // downloadImage already recorded a `failed` outcome at the HTTP layer if
      // it was a network failure; this branch covers the wrapper-only path.
      logger.warn(`Season poster download failed: ${result.error}`, logMeta);
    }

    return {
      success: result.success,
      path: destPath,
      blurhash: result.blurhash,
      error: result.error,
      outcome: result.success ? 'downloaded' : 'failed'
    };

  } catch (error) {
    logger.error(`Error downloading season poster: ${error.message}`, logMeta);
    recordImageOutcome({ imageType: 'season-poster', outcome: 'failed', mediaType });
    return { success: false, path: destPath, error: error.message, outcome: 'failed' };
  }
}

/**
 * Download episode thumbnail image
 * @param {string} thumbnailUrl - Episode thumbnail URL
 * @param {string} seasonDir - Season directory path  
 * @param {number} episodeNumber - Episode number
 * @param {Object} options - Download options
 * @returns {Promise<Object>} Download result
 */
export async function downloadEpisodeThumbnail(thumbnailUrl, seasonDir, episodeNumber, options = {}) {
  const {
    forceDownload = false,
    generateBlurhash: shouldGenerateBlurhash = true,
    mediaName,
    mediaType = 'tv'
  } = options;

  const fileName = `${episodeNumber.toString().padStart(2, '0')} - Thumbnail.jpg`;
  const destPath = path.join(seasonDir, fileName);
  const logMeta = {
    'image.type': 'episode-thumbnail',
    'image.dest': destPath,
    'media.name': mediaName,
    'media.type': mediaType,
    'episode.number': episodeNumber
  };

  try {
    // Check if refresh is needed (configurable refresh interval)
    if (!forceDownload && await pathExists(destPath)) {
      const daysSinceModified = await getFileAgeDays(destPath);
      if (daysSinceModified !== null && daysSinceModified < episode_thumbnail_refresh_days) {
        logger.debug(`Episode thumbnail is recent, skipping download: ${destPath}`, logMeta);
        recordImageOutcome({ imageType: 'episode-thumbnail', outcome: 'cache-hit-fresh', mediaType });
        return { success: true, path: destPath, skipped: true, outcome: 'cache-hit-fresh' };
      }
    }

    if (!thumbnailUrl) {
      logger.debug(`No thumbnail URL provided for episode ${episodeNumber}`, logMeta);
      recordImageOutcome({ imageType: 'episode-thumbnail', outcome: 'no-url', mediaType });
      return { success: false, path: destPath, error: 'No thumbnail URL', outcome: 'no-url' };
    }

    // Episode thumbnails are backdrop-style (16:9), so use 'backdrop' type for smaller blurhashes
    const result = await downloadImageWithBlurhash(thumbnailUrl, destPath, {
      forceDownload,
      generateBlurhash: shouldGenerateBlurhash,
      imageType: 'episode-thumbnail',
      mediaName,
      mediaType,
      skipExistsCheck: true
    });

    if (result.success) {
      // Touch the file to update timestamp
      await touchFile(destPath);
    } else {
      logger.warn(`Episode thumbnail download failed: ${result.error}`, logMeta);
    }

    return {
      success: result.success,
      path: destPath,
      blurhash: result.blurhash,
      error: result.error,
      outcome: result.success ? 'downloaded' : 'failed'
    };

  } catch (error) {
    logger.error(`Error downloading episode thumbnail: ${error.message}`, logMeta);
    recordImageOutcome({ imageType: 'episode-thumbnail', outcome: 'failed', mediaType });
    return { success: false, path: destPath, error: error.message, outcome: 'failed' };
  }
}
