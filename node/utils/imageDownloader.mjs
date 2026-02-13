import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import path from 'path';
import axios from 'axios';
import { createCategoryLogger } from '../lib/logger.mjs';
import { extractFileExtension, touchFile, pathExists, getFileAgeDays } from './fileUtils.mjs';
import { generateBlurhash } from './blurhashNative.mjs';

const logger = createCategoryLogger('image-downloader');

// Configurable refresh intervals from environment variables
const season_poster_refresh_days = parseInt(process.env.SEASON_POSTER_REFRESH_DAYS) || 1;
const episode_thumbnail_refresh_days = parseInt(process.env.EPISODE_THUMBNAIL_REFRESH_DAYS) || 3;

/**
 * Download an image from URL and save to local path
 * @param {string} imageUrl - URL of image to download
 * @param {string} destPath - Destination file path
 * @param {Object} options - Download options
 * @param {boolean} options.forceDownload - Force re-download even if file exists
 * @param {number} options.timeout - Request timeout in milliseconds (default: 30000)
 * @returns {Promise<boolean>} Whether download was successful
 */
export async function downloadImage(imageUrl, destPath, options = {}) {
  const {
    forceDownload = false,
    timeout = 30000
  } = options;

  try {
    // Check if image already exists and skip if not forcing download
    if (!forceDownload && await pathExists(destPath)) {
      logger.debug(`Image already exists at ${destPath}. Skipping download.`);
      return true;
    }

    // Ensure destination directory exists
    const destDir = path.dirname(destPath);
    await fs.mkdir(destDir, { recursive: true });

    // Download the image
    logger.debug(`Downloading image from ${imageUrl} to ${destPath}`);
    
    const response = await axios({
      method: 'get',
      url: imageUrl,
      responseType: 'stream',
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MetadataGenerator/1.0)'
      }
    });

    // Check response status
    if (response.status !== 200) {
      logger.warn(`Failed to download image. HTTP Status: ${response.status}`);
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
        logger.info(`Image successfully downloaded and saved to ${destPath}`);
        return true;
      } else {
        logger.error(`Downloaded file is empty: ${destPath}`);
        // Clean up empty file
        await fs.unlink(destPath).catch(() => {});
        return false;
      }
      
    } catch (error) {
      logger.error(`Error during stream operation: ${error.message}`);
      // Clean up partial file
      await fs.unlink(destPath).catch(() => {});
      return false;
    }

  } catch (error) {
    logger.error(`HTTP error occurred while downloading image from ${imageUrl}: ${error.message}`);
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
 * @returns {Promise<Object>} Result object with success status and blurhash
 */
export async function downloadImageWithBlurhash(imageUrl, destPath, options = {}) {
  const {
    forceDownload = false,
    generateBlurhash: shouldGenerateBlurhash = true
  } = options;

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
    const downloadSuccess = await downloadImage(imageUrl, destPath, { forceDownload });
    
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
            blurhashValue = await generateImageBlurhash(destPath, blurhashPath);
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
              blurhashValue = await generateImageBlurhash(destPath, blurhashPath);
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
 * @returns {Promise<string|null>} Blurhash string or null if generation failed
 */
export async function generateImageBlurhash(imagePath, blurhashPath) {
  try {
    logger.debug(`Generating blurhash for ${imagePath}`);
    
    // Generate blurhash using the existing native implementation
    const blurhashString = await generateBlurhash(imagePath);
    
    if (blurhashString && blurhashString.length > 0) {
      // Save blurhash to file
      await fs.writeFile(blurhashPath, blurhashString, 'utf8');
      logger.debug(`Blurhash saved to ${blurhashPath}`);
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

  const results = {
    backdrop: { success: false, path: null },
    poster: { success: false, path: null },
    logo: { success: false, path: null }
  };

  // Image type mappings
  const imageTypes = {
    backdrop_path: {
      key: 'backdrop',
      prefix: mediaType === 'tv' ? 'show_backdrop' : 'backdrop',
      overrideKey: 'override_backdrop'
    },
    poster_path: {
      key: 'poster', 
      prefix: mediaType === 'tv' ? 'show_poster' : 'poster',
      overrideKey: 'override_poster'
    },
    logo_path: {
      key: 'logo',
      prefix: mediaType === 'tv' ? 'show_logo' : 'logo', 
      overrideKey: 'override_logo'
    }
  };

  for (const [dataKey, imageInfo] of Object.entries(imageTypes)) {
    try {
      let imageUrl = null;

      // Check for override first (matches Python script priority)
      const overridePath = config[imageInfo.overrideKey];
      if (overridePath) {
        imageUrl = `https://image.tmdb.org/t/p/original${overridePath}`;
        logger.debug(`Using override ${imageInfo.key} image: ${overridePath}`);
      } else if (mediaData[dataKey]) {
        // Use TMDB image
        if (mediaData[dataKey].startsWith('http')) {
          imageUrl = mediaData[dataKey];
        } else {
          imageUrl = `https://image.tmdb.org/t/p/original${mediaData[dataKey]}`;
        }
      }

      if (!imageUrl) {
        logger.debug(`No ${imageInfo.key} image URL found for media`);
        continue;
      }

      // Determine file extension and create destination path
      const extension = extractFileExtension(imageUrl) || '.jpg';
      const fileName = `${imageInfo.prefix}${extension}`;
      const destPath = path.join(mediaDir, fileName);

      // Check if image needs updating (URL comparison like Python script)
      let needsUpdate = forceDownload;
      
      if (!forceDownload && await pathExists(destPath)) {
        // Could add URL comparison logic here similar to Python script
        // For now, skip download if file exists and not forcing
        logger.debug(`${imageInfo.key} image already exists: ${fileName}`);
        results[imageInfo.key] = { success: true, path: destPath, skipped: true };
        continue;
      }

      // Download image
      const result = await downloadImageWithBlurhash(imageUrl, destPath, {
        forceDownload,
        generateBlurhash: shouldGenerateBlurhash
      });

      if (result.success) {
        results[imageInfo.key] = { 
          success: true, 
          path: destPath, 
          blurhash: result.blurhash,
          downloaded: true 
        };
        logger.info(`Successfully downloaded ${imageInfo.key} image: ${fileName}`);
      } else {
        results[imageInfo.key] = { success: false, path: destPath, error: result.error };
        logger.warn(`Failed to download ${imageInfo.key} image: ${result.error}`);
      }

    } catch (error) {
      logger.error(`Error processing ${imageInfo.key} image: ${error.message}`);
      results[imageInfo.key] = { success: false, error: error.message };
    }
  }

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
    generateBlurhash: shouldGenerateBlurhash = true
  } = options;

  const fileName = 'season_poster.jpg';
  const destPath = path.join(seasonDir, fileName);

  try {
    // Check if refresh is needed (matches Python script logic)
    if (!forceDownload && await pathExists(destPath)) {
      const daysSinceModified = await getFileAgeDays(destPath);
      if (daysSinceModified !== null && daysSinceModified < season_poster_refresh_days) {
        logger.debug(`Season poster is recent, skipping download: ${destPath}`);
        return { success: true, path: destPath, skipped: true };
      }
    }

    const result = await downloadImageWithBlurhash(seasonPosterUrl, destPath, {
      forceDownload,
      generateBlurhash: shouldGenerateBlurhash
    });

    if (result.success) {
      // Touch the file to update timestamp (matches Python script)
      await touchFile(destPath);
    }

    return {
      success: result.success,
      path: destPath,
      blurhash: result.blurhash,
      error: result.error
    };

  } catch (error) {
    logger.error(`Error downloading season poster: ${error.message}`);
    return { success: false, path: destPath, error: error.message };
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
    generateBlurhash: shouldGenerateBlurhash = true
  } = options;

  const fileName = `${episodeNumber.toString().padStart(2, '0')} - Thumbnail.jpg`;
  const destPath = path.join(seasonDir, fileName);

  try {
    // Check if refresh is needed (configurable refresh interval)
    if (!forceDownload && await pathExists(destPath)) {
      const daysSinceModified = await getFileAgeDays(destPath);
      if (daysSinceModified !== null && daysSinceModified < episode_thumbnail_refresh_days) {
        logger.debug(`Episode thumbnail is recent, skipping download: ${destPath}`);
        return { success: true, path: destPath, skipped: true };
      }
    }

    if (!thumbnailUrl) {
      logger.debug(`No thumbnail URL provided for episode ${episodeNumber}`);
      return { success: false, path: destPath, error: 'No thumbnail URL' };
    }

    const result = await downloadImageWithBlurhash(thumbnailUrl, destPath, {
      forceDownload,
      generateBlurhash: shouldGenerateBlurhash
    });

    if (result.success) {
      // Touch the file to update timestamp
      await touchFile(destPath);
    }

    return {
      success: result.success,
      path: destPath,
      blurhash: result.blurhash,
      error: result.error
    };

  } catch (error) {
    logger.error(`Error downloading episode thumbnail: ${error.message}`);
    return { success: false, path: destPath, error: error.message };
  }
}
