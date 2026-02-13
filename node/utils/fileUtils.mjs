import { promises as fs } from 'fs';
import path from 'path';
import { createCategoryLogger } from '../lib/logger.mjs';

const logger = createCategoryLogger('file-utils');

/**
 * Read JSON metadata file
 * @param {string} filePath - Path to JSON file
 * @returns {Promise<Object>} Parsed JSON data
 */
export async function readMetadataFile(filePath) {
  try {
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    
    if (!exists) {
      logger.debug(`Metadata file does not exist: ${filePath}`);
      return null;
    }

    const content = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    
    logger.debug(`Read metadata from: ${filePath}`);
    return data;
    
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.error(`Invalid JSON in metadata file ${filePath}: ${error.message}`);
      throw new Error(`Invalid JSON in metadata file: ${error.message}`);
    }
    logger.error(`Failed to read metadata from ${filePath}: ${error.message}`);
    throw error;
  }
}

/**
 * Write JSON metadata file with proper formatting
 * @param {string} filePath - Path to write JSON file
 * @param {Object} data - Data to write
 * @returns {Promise<void>}
 */
export async function writeMetadataFile(filePath, data) {
  try {
    // Ensure directory exists
    const fileDir = path.dirname(filePath);
    await fs.mkdir(fileDir, { recursive: true });
    
    // Remove internal caching fields that shouldn't be saved to disk
    const cleanData = { ...data };
    delete cleanData._cached;
    delete cleanData._cachedAt;
    delete cleanData._etag;
    delete cleanData._expiresAt;
    
    // Add last_updated timestamp if not present
    const dataWithTimestamp = {
      ...cleanData,
      last_updated: cleanData.last_updated || new Date().toISOString()
    };
    
    // Write with proper formatting (matches Python script: indent=4, sort_keys=True)
    // Use a custom replacer to recursively sort keys at all levels
    const jsonContent = JSON.stringify(dataWithTimestamp, (key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Sort keys for objects (but not arrays)
        return Object.keys(value).sort().reduce((sorted, key) => {
          sorted[key] = value[key];
          return sorted;
        }, {});
      }
      return value;
    }, 4);
    await fs.writeFile(filePath, jsonContent, 'utf8');
    
    logger.info(`Successfully wrote clean metadata to: ${filePath}`);
    
  } catch (error) {
    logger.error(`Failed to write metadata to ${filePath}: ${error.message}`);
    throw error;
  }
}

/**
 * Get file modification time
 * @param {string} filePath - Path to file
 * @returns {Promise<Date|null>} Modification time or null if file doesn't exist
 */
export async function getFileModTime(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtime;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null; // File doesn't exist
    }
    throw error;
  }
}

/**
 * Check if metadata file needs refresh based on file modification times
 * Matches Python script's should_refresh_metadata function
 * @param {string} metadataPath - Path to metadata.json file
 * @param {string} configPath - Path to tmdb.config file
 * @param {number} maxAgeHours - Maximum age in hours before refresh (default: 24)
 * @returns {Promise<boolean>} Whether refresh is needed
 */
export async function shouldRefreshMetadata(metadataPath, configPath, maxAgeHours = 24) {
  try {
    const metadataModTime = await getFileModTime(metadataPath);
    
    // If metadata file doesn't exist, refresh is needed
    if (!metadataModTime) {
      logger.debug(`Metadata file does not exist: ${metadataPath} - refresh needed`);
      return true;
    }
    
    const now = new Date();
    const ageHours = (now - metadataModTime) / (1000 * 60 * 60);
    
    // Check if metadata is older than maxAge
    if (ageHours > maxAgeHours) {
      logger.debug(`Metadata file is ${ageHours.toFixed(1)} hours old (max: ${maxAgeHours}) - refresh needed`);
      return true;
    }
    
    // Check if config file was modified more recently than metadata
    const configModTime = await getFileModTime(configPath);
    if (configModTime && configModTime > metadataModTime) {
      logger.debug(`Config file was modified after metadata - refresh needed`);
      return true;
    }
    
    logger.debug(`Metadata file is up to date - no refresh needed`);
    return false;
    
  } catch (error) {
    logger.error(`Error checking if metadata should be refreshed: ${error.message}`);
    // Default to refresh on error
    return true;
  }
}

/**
 * Touch a file to update its modification time (similar to Unix touch command)
 * Matches Python script's touch function with filesystem permission handling
 * @param {string} filePath - Path to file to touch
 * @returns {Promise<boolean>} Whether touch was successful
 */
export async function touchFile(filePath) {
  try {
    // Check if file exists first
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    
    if (!exists) {
      logger.debug(`Touch: ${filePath} does not exist, skipping`);
      return false;
    }
    
    // Update access and modification times to current time
    const now = new Date();
    await fs.utimes(filePath, now, now);
    
    logger.debug(`Touched file: ${filePath}`);
    return true;
    
  } catch (error) {
    // Handle permission errors gracefully (matches Python script behavior)
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      logger.debug(`Skipping touch on ${filePath} (PermissionError)`);
      return false;
    }
    
    if (error.code === 'ENOENT') {
      logger.debug(`Skipping touch on ${filePath} (FileNotFound)`);
      return false;
    }
    
    logger.warn(`Failed to touch ${filePath}: ${error.message}`);
    return false;
  }
}

/**
 * Extract file extension from URL or file path
 * Matches Python script's extract_file_extension function
 * @param {string} urlOrPath - URL or file path
 * @returns {string} File extension including dot (e.g., '.jpg') or empty string
 */
export function extractFileExtension(urlOrPath) {
  try {
    // Handle URLs by extracting pathname
    let pathToCheck = urlOrPath;
    if (urlOrPath.startsWith('http')) {
      const url = new URL(urlOrPath);
      pathToCheck = url.pathname;
    }
    
    const ext = path.extname(pathToCheck);
    return ext || '';
    
  } catch (error) {
    logger.warn(`Failed to extract extension from: ${urlOrPath}`);
    return '';
  }
}

/**
 * Check if a file or directory exists
 * @param {string} filePath - Path to check
 * @returns {Promise<boolean>} Whether the path exists
 */
export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get directory listing filtered by directories only
 * @param {string} dirPath - Directory path to scan
 * @returns {Promise<string[]>} Array of directory names
 */
export async function getDirectories(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.debug(`Directory does not exist: ${dirPath}`);
      return [];
    }
    throw error;
  }
}

/**
 * Check file age in days
 * @param {string} filePath - Path to file
 * @returns {Promise<number|null>} Age in days or null if file doesn't exist
 */
export async function getFileAgeDays(filePath) {
  const modTime = await getFileModTime(filePath);
  if (!modTime) {
    return null;
  }
  
  const now = new Date();
  const ageDays = (now - modTime) / (1000 * 60 * 60 * 24);
  return ageDays;
}

/**
 * Check if file is older than specified number of days
 * @param {string} filePath - Path to file
 * @param {number} maxAgeDays - Maximum age in days
 * @returns {Promise<boolean>} Whether file is older than maxAge or doesn't exist
 */
export async function isFileOlderThan(filePath, maxAgeDays) {
  const ageDays = await getFileAgeDays(filePath);
  
  // If file doesn't exist, consider it as "old"
  if (ageDays === null) {
    return true;
  }
  
  return ageDays > maxAgeDays;
}

/**
 * Generate full file path for media-related files
 * @param {string} mediaDir - Media directory (TV show or movie)
 * @param {string} fileName - File name
 * @returns {string} Full file path
 */
export function getMediaFilePath(mediaDir, fileName) {
  return path.join(mediaDir, fileName);
}

/**
 * Get metadata file path for media directory
 * @param {string} mediaDir - Media directory path
 * @returns {string} Path to metadata.json
 */
export function getMetadataFilePath(mediaDir) {
  return getMediaFilePath(mediaDir, 'metadata.json');
}

/**
 * Get TMDB config file path for media directory
 * @param {string} mediaDir - Media directory path
 * @returns {string} Path to tmdb.config
 */
export function getTmdbConfigFilePath(mediaDir) {
  return getMediaFilePath(mediaDir, 'tmdb.config');
}

/**
 * Get season directory path
 * @param {string} showDir - Show directory path
 * @param {number} seasonNumber - Season number
 * @returns {string} Season directory path
 */
export function getSeasonDirPath(showDir, seasonNumber) {
  return path.join(showDir, `Season ${seasonNumber}`);
}

/**
 * Get episode metadata file path
 * @param {string} seasonDir - Season directory path
 * @param {number} episodeNumber - Episode number
 * @returns {string} Episode metadata file path
 */
export function getEpisodeMetadataPath(seasonDir, episodeNumber) {
  return path.join(seasonDir, `${episodeNumber.toString().padStart(2, '0')}_metadata.json`);
}
