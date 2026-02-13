import { promises as fs } from 'fs';
import path from 'path';
import { createCategoryLogger } from '../lib/logger.mjs';

const logger = createCategoryLogger('tmdb-config');

/**
 * Load TMDB configuration from tmdb.config file
 * Provides fallback for missing files and handles JSON parsing errors gracefully
 * @param {string} configPath - Path to tmdb.config file
 * @returns {Promise<Object>} Configuration object
 */
export async function loadTmdbConfig(configPath) {
  try {
    const exists = await fs.access(configPath).then(() => true).catch(() => false);
    
    if (!exists) {
      logger.debug(`Config file does not exist: ${configPath}, returning defaults`);
      return createDefaultConfig();
    }

    const content = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(content);
    
    // Validate and apply defaults for missing fields
    const validatedConfig = validateTmdbConfig(config);
    
    logger.debug(`Loaded TMDB config from: ${configPath}`);
    return validatedConfig;
    
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.error(`Invalid JSON in config file ${configPath}: ${error.message}`);
      throw new Error(`Invalid JSON in TMDB config: ${error.message}`);
    }
    logger.error(`Failed to load TMDB config from ${configPath}: ${error.message}`);
    throw error;
  }
}

/**
 * Save TMDB configuration to tmdb.config file
 * @param {string} configPath - Path to tmdb.config file
 * @param {Object} config - Configuration object to save
 * @returns {Promise<void>}
 */
export async function saveTmdbConfig(configPath, config) {
  try {
    // Ensure directory exists
    const configDir = path.dirname(configPath);
    await fs.mkdir(configDir, { recursive: true });
    
    // Validate config before saving
    const validatedConfig = validateTmdbConfig(config);
    
    // Write with proper formatting
    const configJson = JSON.stringify(validatedConfig, null, 2);
    await fs.writeFile(configPath, configJson, 'utf8');
    
    logger.debug(`Saved TMDB config to: ${configPath}`);
    
  } catch (error) {
    logger.error(`Failed to save TMDB config to ${configPath}: ${error.message}`);
    throw error;
  }
}

/**
 * Update TMDB config file with new TMDB ID if not present
 * Matches Python script behavior
 * @param {string} configPath - Path to tmdb.config file
 * @param {number} tmdbId - TMDB ID to set
 * @param {string} mediaName - Name of media for logging
 * @returns {Promise<Object>} Updated configuration
 */
export async function updateTmdbConfigWithId(configPath, tmdbId, mediaName) {
  try {
    const config = await loadTmdbConfig(configPath);
    
    if (!config.tmdb_id) {
      config.tmdb_id = tmdbId;
      await saveTmdbConfig(configPath, config);
      logger.info(`Added tmdb_id ${tmdbId} to config for '${mediaName}'`);
    } else {
      logger.debug(`TMDB ID already exists in config for '${mediaName}', not overwriting`);
    }
    
    return config;
    
  } catch (error) {
    logger.error(`Failed to update TMDB config for '${mediaName}': ${error.message}`);
    throw error;
  }
}

/**
 * Validate TMDB configuration object and apply defaults
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validated configuration with defaults applied
 */
export function validateTmdbConfig(config) {
  if (!config || typeof config !== 'object') {
    return createDefaultConfig();
  }
  
  const validated = {
    ...createDefaultConfig(),
    ...config
  };
  
  // Validate specific fields
  if (validated.tmdb_id && (!Number.isInteger(validated.tmdb_id) || validated.tmdb_id <= 0)) {
    logger.warn(`Invalid tmdb_id: ${validated.tmdb_id}, removing from config`);
    delete validated.tmdb_id;
  }
  
  if (validated.update_metadata !== undefined && typeof validated.update_metadata !== 'boolean') {
    logger.warn(`Invalid update_metadata value: ${validated.update_metadata}, defaulting to true`);
    validated.update_metadata = true;
  }
  
  return validated;
}

/**
 * Create default TMDB configuration
 * @returns {Object} Default configuration
 */
function createDefaultConfig() {
  return {
    update_metadata: true
  };
}

/**
 * Check if metadata updates are allowed based on configuration
 * Matches Python script's is_metadata_update_allowed function
 * @param {Object} config - TMDB configuration object
 * @returns {boolean} Whether updates are allowed
 */
export function isUpdateAllowed(config) {
  return config.update_metadata !== false; // Default to true if not specified
}

/**
 * Get override value for image or metadata field
 * @param {Object} config - TMDB configuration object
 * @param {string} field - Field name to get override for (e.g., 'backdrop', 'poster', 'logo')
 * @returns {string|null} Override value or null if not set
 */
export function getOverride(config, field) {
  const overrideKey = `override_${field}`;
  return config[overrideKey] || null;
}

/**
 * Check if config has metadata overrides
 * @param {Object} config - TMDB configuration object
 * @returns {Object|null} Metadata overrides or null if not set
 */
export function getMetadataOverrides(config) {
  return config.metadata || null;
}

/**
 * Apply metadata overrides to TMDB data
 * Matches Python script behavior for metadata updates
 * @param {Object} tmdbData - TMDB API response data
 * @param {Object} config - TMDB configuration object
 * @returns {Object} TMDB data with overrides applied
 */
export function applyMetadataOverrides(tmdbData, config) {
  const overrides = getMetadataOverrides(config);
  
  if (!overrides || typeof overrides !== 'object') {
    return tmdbData;
  }
  
  // Apply overrides by merging
  const result = {
    ...tmdbData,
    ...overrides
  };
  
  logger.debug(`Applied metadata overrides: ${Object.keys(overrides).join(', ')}`);
  return result;
}

/**
 * Get the path to tmdb.config file for a given media directory
 * @param {string} mediaPath - Path to media directory
 * @returns {string} Path to tmdb.config file
 */
export function getTmdbConfigFilePath(mediaPath) {
  return path.join(mediaPath, 'tmdb.config');
}
