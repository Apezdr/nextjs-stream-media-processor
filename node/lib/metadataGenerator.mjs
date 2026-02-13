import { randomUUID } from 'crypto';
import path from 'path';
import { createCategoryLogger } from './logger.mjs';
import { 
  loadTmdbConfig, 
  updateTmdbConfigWithId, 
  isUpdateAllowed, 
  applyMetadataOverrides 
} from '../utils/tmdbConfig.mjs';
import {
  writeMetadataFile,
  shouldRefreshMetadata,
  getDirectories,
  getMetadataFilePath,
  getTmdbConfigFilePath,
  getEpisodeMetadataPath,
  pathExists,
  getFileAgeDays
} from '../utils/fileUtils.mjs';
import {
  downloadMediaImages,
  downloadSeasonPoster,
  downloadEpisodeThumbnail
} from '../utils/imageDownloader.mjs';
import {
  fetchComprehensiveMediaDetails,
  getEpisodeDetails,
  makeTmdbRequest
} from '../utils/tmdb.mjs';

const logger = createCategoryLogger('metadata-generator');
const episode_metadata_refresh_days = parseInt(process.env.EPISODE_METADATA_REFRESH_DAYS) || 4;

/**
 * MetadataGenerator - Main orchestrator for generating metadata files
 * Follows Node.js best practices with explicit initialization and business logic separation
 */
export class MetadataGenerator {
  constructor(config) {
    this.config = config;
    this.transactionId = randomUUID();
    this.logger = createCategoryLogger('metadata-generator');
    
    this.logger.info('MetadataGenerator initialized', { 
      transactionId: this.transactionId,
      basePath: config.basePath 
    });
  }

  /**
   * Static factory method for creating MetadataGenerator instance
   * Follows Node.js best practice 3.13 - explicit initialization, no effects at import
   * @param {Object} config - Configuration object
   * @param {string} config.basePath - Base path for media directories
   * @param {boolean} config.forceRefresh - Force refresh all metadata
   * @param {boolean} config.generateBlurhash - Generate blurhash for images
   * @returns {Promise<MetadataGenerator>} Initialized metadata generator
   */
  static async create(config) {
    const validatedConfig = {
      basePath: config.basePath || process.env.BASE_PATH || '/var/www/html',
      forceRefresh: config.forceRefresh || false,
      generateBlurhash: config.generateBlurhash !== false, // Default true
      maxConcurrent: config.maxConcurrent || 3,
      ...config
    };

    return new MetadataGenerator(validatedConfig);
  }

  /**
   * Generate metadata for a TV show
   * Matches Python script's process_show functionality
   * @param {string} showName - Name of the TV show directory
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generation results
   */
  async generateForShow(showName, options = {}) {
    const transactionId = randomUUID();
    this.logger.info('Starting show metadata generation', { 
      showName, 
      transactionId,
      forceRefresh: this.config.forceRefresh 
    });

    try {
      const showDir = path.join(this.config.basePath, 'tv', showName);
      const metadataPath = getMetadataFilePath(showDir);
      const configPath = getTmdbConfigFilePath(showDir);

      // Check if show-level metadata refresh is needed (unless forcing)
      let needsShowRefresh = true;
      if (!this.config.forceRefresh) {
        needsShowRefresh = await shouldRefreshMetadata(metadataPath, configPath);
        if (!needsShowRefresh) {
          this.logger.info(`Show metadata is up to date: ${showName}`, { transactionId });
          // Don't return early - still process seasons/episodes for new content
        }
      }

      // Load TMDB configuration
      const tmdbConfig = await loadTmdbConfig(configPath);
      
      // Check if updates are allowed
      if (!isUpdateAllowed(tmdbConfig)) {
        this.logger.info(`Metadata updates disabled for show: ${showName}`, { transactionId });
        return { success: true, updated: false, reason: 'updates-disabled' };
      }

      // Get TMDB data (either fetch fresh or use existing ID for seasons/episodes)
      let tmdbData;
      let imageResults = null;
      
      if (needsShowRefresh || this.config.forceRefresh) {
        // Fetch fresh TMDB data for show metadata
        if (tmdbConfig.tmdb_id) {
          // Use existing TMDB ID
          tmdbData = await fetchComprehensiveMediaDetails(showName, 'tv', tmdbConfig.tmdb_id, this.config.generateBlurhash);
        } else {
          // Search for TMDB ID
          tmdbData = await fetchComprehensiveMediaDetails(showName, 'tv', null, this.config.generateBlurhash);
          
          // Update config with found TMDB ID
          if (tmdbData.id) {
            await updateTmdbConfigWithId(configPath, tmdbData.id, showName);
          }
        }

        // Apply any metadata overrides from config
        const enhancedMetadata = applyMetadataOverrides(tmdbData, tmdbConfig);

        // Download images
        imageResults = await downloadMediaImages(
          enhancedMetadata, 
          showDir, 
          tmdbConfig, 
          'tv',
          { 
            forceDownload: this.config.forceRefresh,
            generateBlurhash: this.config.generateBlurhash 
          }
        );

        // Write metadata file
        await writeMetadataFile(metadataPath, enhancedMetadata);
      } else {
        // Show metadata is up-to-date, but we still need TMDB ID for seasons/episodes
        if (tmdbConfig.tmdb_id) {
          tmdbData = { id: tmdbConfig.tmdb_id };
        } else {
          // Need to get TMDB ID to process seasons
          this.logger.info(`Show metadata up-to-date but need TMDB ID for ${showName}, fetching...`);
          tmdbData = await fetchComprehensiveMediaDetails(showName, 'tv', null, false); // Don't generate blurhash for this lookup
          if (tmdbData.id) {
            await updateTmdbConfigWithId(configPath, tmdbData.id, showName);
          }
        }
      }

      // Always process seasons and episodes (even if show metadata is up-to-date)
      const seasonResults = await this.processShowSeasons(showDir, tmdbData.id, transactionId);

      this.logger.info(`Completed show metadata generation: ${showName}`, { 
        transactionId,
        seasonsProcessed: seasonResults.length,
        imagesDownloaded: imageResults ? Object.values(imageResults).filter(r => r.success).length : 0
      });

      return { 
        success: true, 
        updated: needsShowRefresh, // Only mark as updated if show metadata was actually refreshed
        tmdbId: tmdbData.id,
        imageResults: imageResults || {},
        seasonResults,
        transactionId
      };

    } catch (error) {
      this.logger.error(`Failed to generate metadata for show: ${showName}`, { 
        transactionId, 
        error: error.message 
      });
      return { success: false, error: error.message, transactionId };
    }
  }

  /**
   * Generate metadata for a movie
   * @param {string} movieName - Name of the movie directory
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generation results
   */
  async generateForMovie(movieName, options = {}) {
    const transactionId = randomUUID();
    this.logger.info('Starting movie metadata generation', { 
      movieName, 
      transactionId,
      forceRefresh: this.config.forceRefresh 
    });

    try {
      const movieDir = path.join(this.config.basePath, 'movies', movieName);
      const metadataPath = getMetadataFilePath(movieDir);
      const configPath = getTmdbConfigFilePath(movieDir);

      // Check if refresh is needed (unless forcing)
      if (!this.config.forceRefresh) {
        const needsRefresh = await shouldRefreshMetadata(metadataPath, configPath);
        if (!needsRefresh) {
          this.logger.info(`Movie metadata is up to date: ${movieName}`, { transactionId });
          return { success: true, updated: false, reason: 'up-to-date' };
        }
      }

      // Load TMDB configuration
      const tmdbConfig = await loadTmdbConfig(configPath);
      
      // Check if updates are allowed
      if (!isUpdateAllowed(tmdbConfig)) {
        this.logger.info(`Metadata updates disabled for movie: ${movieName}`, { transactionId });
        return { success: true, updated: false, reason: 'updates-disabled' };
      }

      // Fetch TMDB data
      let tmdbData;
      if (tmdbConfig.tmdb_id) {
        // Use existing TMDB ID
        tmdbData = await fetchComprehensiveMediaDetails(movieName, 'movie', tmdbConfig.tmdb_id, this.config.generateBlurhash);
      } else {
        // Search for TMDB ID
        tmdbData = await fetchComprehensiveMediaDetails(movieName, 'movie', null, this.config.generateBlurhash);
        
        // Update config with found TMDB ID
        if (tmdbData.id) {
          await updateTmdbConfigWithId(configPath, tmdbData.id, movieName);
        }
      }

      // Apply any metadata overrides from config
      const enhancedMetadata = applyMetadataOverrides(tmdbData, tmdbConfig);

      // Download images
      const imageResults = await downloadMediaImages(
        enhancedMetadata, 
        movieDir, 
        tmdbConfig, 
        'movie',
        { 
          forceDownload: this.config.forceRefresh,
          generateBlurhash: this.config.generateBlurhash 
        }
      );

      // Write metadata file
      await writeMetadataFile(metadataPath, enhancedMetadata);

      this.logger.info(`Completed movie metadata generation: ${movieName}`, { 
        transactionId,
        tmdbId: enhancedMetadata.id,
        imagesDownloaded: Object.values(imageResults).filter(r => r.success).length
      });

      return { 
        success: true, 
        updated: true,
        tmdbId: enhancedMetadata.id,
        imageResults,
        transactionId
      };

    } catch (error) {
      this.logger.error(`Failed to generate metadata for movie: ${movieName}`, { 
        transactionId, 
        error: error.message 
      });
      return { success: false, error: error.message, transactionId };
    }
  }

  /**
   * Process seasons and episodes for a TV show
   * @param {string} showDir - Show directory path
   * @param {number} tmdbId - TMDB show ID
   * @param {string} transactionId - Transaction ID for logging
   * @returns {Promise<Array>} Season processing results
   */
  async processShowSeasons(showDir, tmdbId, transactionId) {
    try {
      const directories = await getDirectories(showDir);
      const seasonDirs = directories.filter(dir => dir.startsWith('Season '));
      
      this.logger.info(`Found ${seasonDirs.length} seasons for processing`, { transactionId });

      const seasonResults = [];
      
      // Process seasons sequentially to avoid overwhelming TMDB API
      for (const seasonDir of seasonDirs) {
        try {
          const seasonNumber = parseInt(seasonDir.replace('Season ', ''));
          if (isNaN(seasonNumber)) continue;

          const seasonPath = path.join(showDir, seasonDir);
          const result = await this.processSeason(seasonPath, tmdbId, seasonNumber, transactionId);
          seasonResults.push({ season: seasonNumber, ...result });
          
        } catch (error) {
          this.logger.warn(`Failed to process season: ${seasonDir}`, { 
            transactionId, 
            error: error.message 
          });
          seasonResults.push({ season: seasonDir, success: false, error: error.message });
        }
      }

      return seasonResults;

    } catch (error) {
      this.logger.error('Failed to process show seasons', { transactionId, error: error.message });
      return [];
    }
  }

  /**
   * Process individual season
   * @param {string} seasonPath - Season directory path
   * @param {number} tmdbId - TMDB show ID
   * @param {number} seasonNumber - Season number
   * @param {string} transactionId - Transaction ID for logging
   * @returns {Promise<Object>} Season processing result
   */
  async processSeason(seasonPath, tmdbId, seasonNumber, transactionId) {
    try {
      this.logger.debug(`Processing Season ${seasonNumber}`, { transactionId });

      // Get season details from TMDB
      const seasonData = await this.getSeasonDetails(tmdbId, seasonNumber);
      
      // Download season poster if available
      let posterResult = null;
      if (seasonData?.poster_path) {
        const posterUrl = `https://image.tmdb.org/t/p/original${seasonData.poster_path}`;
        posterResult = await downloadSeasonPoster(posterUrl, seasonPath, {
          forceDownload: this.config.forceRefresh,
          generateBlurhash: this.config.generateBlurhash
        });
      }

      // Process episodes
      const episodeResults = await this.processSeasonEpisodes(seasonPath, tmdbId, seasonNumber, seasonData, transactionId);

      return {
        success: true,
        episodesProcessed: episodeResults.length,
        posterDownloaded: posterResult?.success || false,
        episodes: episodeResults
      };

    } catch (error) {
      this.logger.error(`Failed to process season ${seasonNumber}`, { 
        transactionId, 
        error: error.message 
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Get season details from TMDB
   * @param {number} tmdbId - TMDB show ID
   * @param {number} seasonNumber - Season number
   * @returns {Promise<Object>} Season data
   */
  async getSeasonDetails(tmdbId, seasonNumber) {
    try {
      // Use the correct TMDB API endpoint for season details
      const data = await makeTmdbRequest(`/tv/${tmdbId}/season/${seasonNumber}`);
      return data;
    } catch (error) {
      this.logger.warn(`Failed to get season ${seasonNumber} details for show ${tmdbId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Process episodes in a season
   * @param {string} seasonPath - Season directory path
   * @param {number} tmdbId - TMDB show ID
   * @param {number} seasonNumber - Season number
   * @param {Object} seasonData - Season data from TMDB
   * @param {string} transactionId - Transaction ID for logging
   * @returns {Promise<Array>} Episode processing results
   */
  async processSeasonEpisodes(seasonPath, tmdbId, seasonNumber, seasonData, transactionId) {
    try {
      const episodeResults = [];
      
      // Get episodes from season data or scan directory
      const episodes = seasonData?.episodes || [];
      
      // Process each episode
      for (const episode of episodes.slice(0, 50)) { // Limit to prevent excessive API calls
        try {
          const episodeNumber = episode.episode_number;
          const result = await this.processEpisode(seasonPath, tmdbId, seasonNumber, episodeNumber, episode, transactionId);
          episodeResults.push({ episode: episodeNumber, ...result });
          
        } catch (error) {
          this.logger.warn(`Failed to process episode ${episode.episode_number}`, { 
            transactionId, 
            error: error.message 
          });
        }
      }

      return episodeResults;

    } catch (error) {
      this.logger.error('Failed to process season episodes', { transactionId, error: error.message });
      return [];
    }
  }

  /**
   * Process individual episode
   * @param {string} seasonPath - Season directory path
   * @param {number} tmdbId - TMDB show ID
   * @param {number} seasonNumber - Season number
   * @param {number} episodeNumber - Episode number
   * @param {Object} episodeData - Episode data from season
   * @param {string} transactionId - Transaction ID for logging
   * @returns {Promise<Object>} Episode processing result
   */
  async processEpisode(seasonPath, tmdbId, seasonNumber, episodeNumber, episodeData, transactionId) {
    try {
      const episodeMetadataPath = getEpisodeMetadataPath(seasonPath, episodeNumber);

      // Check if episode metadata is recent (if not forcing refresh)
      if (!this.config.forceRefresh) {
        const exists = await pathExists(episodeMetadataPath);
        if (exists) {
          const ageDays = await getFileAgeDays(episodeMetadataPath);
          const refreshDays = episode_metadata_refresh_days;
          if (ageDays !== null && ageDays < refreshDays) {
            return { success: true, updated: false, reason: 'up-to-date' };
          }
        }
      }

      // Get detailed episode data
      const detailedEpisodeData = await getEpisodeDetails(tmdbId, seasonNumber, episodeNumber);
      
      // Write episode metadata
      await writeMetadataFile(episodeMetadataPath, detailedEpisodeData);

      // Download episode thumbnail if available
      let thumbnailResult = null;
      if (detailedEpisodeData?.still_path) {
        const thumbnailUrl = `https://image.tmdb.org/t/p/original${detailedEpisodeData.still_path}`;
        thumbnailResult = await downloadEpisodeThumbnail(thumbnailUrl, seasonPath, episodeNumber, {
          forceDownload: this.config.forceRefresh,
          generateBlurhash: this.config.generateBlurhash
        });
      }

      return {
        success: true,
        updated: true,
        thumbnailDownloaded: thumbnailResult?.success || false
      };

    } catch (error) {
      this.logger.error(`Failed to process episode ${episodeNumber}`, { 
        transactionId, 
        error: error.message 
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Process entire directory (TV shows and movies)
   * @param {string} directoryType - 'tv' or 'movies'
   * @param {Object} options - Processing options
   * @returns {Promise<Object>} Processing results
   */
  async processDirectory(directoryType, options = {}) {
    const transactionId = randomUUID();
    this.logger.info(`Starting ${directoryType} directory processing`, { transactionId });

    try {
      const dirPath = path.join(this.config.basePath, directoryType);
      const directories = await getDirectories(dirPath);
      
      this.logger.info(`Found ${directories.length} ${directoryType} directories`, { transactionId });

      const results = [];
      let successCount = 0;
      let errorCount = 0;

      // Process directories with controlled concurrency
      const chunks = this.chunkArray(directories, this.config.maxConcurrent);
      
      for (const chunk of chunks) {
        const chunkPromises = chunk.map(async (dirName) => {
          try {
            let result;
            if (directoryType === 'tv') {
              result = await this.generateForShow(dirName);
            } else {
              result = await this.generateForMovie(dirName);
            }
            
            if (result.success) {
              successCount++;
            } else {
              errorCount++;
            }
            
            return { name: dirName, ...result };
          } catch (error) {
            errorCount++;
            this.logger.error(`Failed to process ${dirName}`, { 
              transactionId, 
              error: error.message 
            });
            return { name: dirName, success: false, error: error.message };
          }
        });

        const chunkResults = await Promise.all(chunkPromises);
        results.push(...chunkResults);
      }

      this.logger.info(`Completed ${directoryType} directory processing`, { 
        transactionId,
        total: directories.length,
        success: successCount,
        errors: errorCount
      });

      return {
        success: true,
        transactionId,
        processed: directories.length,
        successCount,
        errorCount,
        results
      };

    } catch (error) {
      this.logger.error(`Failed to process ${directoryType} directory`, { 
        transactionId, 
        error: error.message 
      });
      return { success: false, error: error.message, transactionId };
    }
  }

  /**
   * Utility method to chunk array for controlled concurrency
   * @param {Array} array - Array to chunk
   * @param {number} size - Chunk size
   * @returns {Array} Array of chunks
   */
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}
