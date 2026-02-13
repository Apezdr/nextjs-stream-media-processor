import express from 'express';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createCategoryLogger } from '../lib/logger.mjs';
import { authenticateUser, requireAdmin } from '../middleware/auth.mjs';
import { fileExists } from '../utils/utils.mjs';
import { sessionCache } from '../middleware/sessionCache.mjs';
import { MetadataGenerator } from '../lib/metadataGenerator.mjs';
import { searchMedia } from '../utils/tmdb.mjs';
import { loadTmdbConfig, saveTmdbConfig, getTmdbConfigFilePath } from '../utils/tmdbConfig.mjs';

const logger = createCategoryLogger('admin-routes');

// BASE_PATH is the path to the media files directory
const BASE_PATH = process.env.BASE_PATH ? process.env.BASE_PATH : "/var/www/html";

/**
 * Initialize and configure admin routes
 * @returns {object} Configured Express router
 */
export function setupAdminRoutes() {
  const router = express.Router();

/**
 * Route to save changes to subtitle files
 * POST /admin/subtitles/save
 * Requires authentication and admin privileges
 * 
 * Request body:
 * {
 *   subtitleContent: "WEBVTT\n\n1\n00:00:36.630 --> 00:00:37.795\nText content\n\n...",
 *   mediaType: "tv" or "movie",
 *   mediaTitle: "Show Name" or "Movie Name",
 *   language: "English",
 *   season: "1" (required for TV shows),
 *   episode: "1" (required for TV shows)
 * }
 */
router.post('/subtitles/save', authenticateUser, requireAdmin, async (req, res) => {
    try {
        // Extract required parameters from request body
        const { subtitleContent, mediaType, mediaTitle, language, season, episode } = req.body;

        // Validate required parameters
        if (!subtitleContent) {
            return res.status(400).json({ error: 'Missing subtitle content' });
        }
        if (!mediaType || (mediaType !== 'tv' && mediaType !== 'movie')) {
            return res.status(400).json({ error: 'Invalid or missing media type' });
        }
        if (!mediaTitle) {
            return res.status(400).json({ error: 'Missing media title' });
        }
        if (!language) {
            return res.status(400).json({ error: 'Missing language' });
        }
        if (mediaType === 'tv' && (!season || !episode)) {
            return res.status(400).json({ error: 'Season and episode required for TV shows' });
        }

        // Get language code from language name
        const langCode = getLanguageCode(language);
        if (!langCode) {
            return res.status(400).json({ error: `Unsupported language: ${language}` });
        }

        // Determine path to subtitle file
        let subtitleFilePath;
        let mediaFilePath;
        const isHearingImpaired = language.toLowerCase().includes('hearing impaired');
        
        if (mediaType === 'movie') {
            // For movies
            const decodedMediaTitle = decodeURIComponent(mediaTitle);
            const movieDir = join(BASE_PATH, 'movies', decodedMediaTitle);
            
            // Find the main movie file to determine the subtitle filename
            const files = await fs.readdir(movieDir);
            const mp4File = files.find(file => file.endsWith('.mp4'));
            
            if (!mp4File) {
                return res.status(404).json({ error: 'Movie file not found' });
            }
            
            const baseFileName = mp4File.replace('.mp4', '');
            const subtitleFileName = isHearingImpaired
                ? `${baseFileName}.${langCode}.hi.srt`
                : `${baseFileName}.${langCode}.srt`;
                
            subtitleFilePath = join(movieDir, subtitleFileName);
            mediaFilePath = join(movieDir, mp4File);
            
        } else {
            // For TV shows
            const decodedMediaTitle = decodeURIComponent(mediaTitle);
            const seasonDir = join(BASE_PATH, 'tv', decodedMediaTitle, `Season ${season}`);
            
            // Find the episode file
            const files = await fs.readdir(seasonDir);
            
            // Look for file matching S01E01 pattern (case insensitive)
            const paddedSeason = season.toString().padStart(2, '0');
            const paddedEpisode = episode.toString().padStart(2, '0');
            const episodePattern = new RegExp(`S${paddedSeason}E${paddedEpisode}`, 'i');
            
            const episodeFile = files.find(file => 
                file.endsWith('.mp4') && episodePattern.test(file)
            );
            
            if (!episodeFile) {
                return res.status(404).json({ error: 'Episode file not found' });
            }
            
            const baseFileName = episodeFile.replace('.mp4', '');
            const subtitleFileName = isHearingImpaired
                ? `${baseFileName}.${langCode}.hi.srt`
                : `${baseFileName}.${langCode}.srt`;
                
            subtitleFilePath = join(seasonDir, subtitleFileName);
            mediaFilePath = join(seasonDir, episodeFile);
        }

        // Make sure the directory exists
        await fs.mkdir(dirname(subtitleFilePath), { recursive: true });

        // Check if we need to convert from WEBVTT to SRT format
        let finalContent = subtitleContent;
        if (subtitleContent.startsWith('WEBVTT')) {
            finalContent = convertWebVttToSrt(subtitleContent);
        }

        // Write the subtitle content to the file
        await fs.writeFile(subtitleFilePath, finalContent);

        // Force file modification time update to ensure ETag regeneration
        const now = new Date();
        await fs.utimes(subtitleFilePath, now, now);

        logger.info(`Subtitle file updated: ${subtitleFilePath} by user ${req.user.email}`);
        
        return res.status(200).json({
            success: true,
            message: 'Subtitle file updated successfully',
            path: subtitleFilePath,
            mediaType,
            mediaTitle,
            language,
            ...(mediaType === 'tv' && { season, episode })
        });
    } catch (error) {
        logger.error(`Error saving subtitle changes: ${error.message}`);
        return res.status(500).json({ 
            error: 'Failed to save subtitle changes',
            message: error.message
        });
    }
});

/**
 * Route to get session cache statistics
 * GET /admin/cache/session-stats
 * Requires authentication and admin privileges
 *
 * Returns statistics about the in-memory session cache including:
 * - Total cached sessions
 * - Active vs expired sessions
 * - Cache hit rate
 * - Configuration details
 */
router.get('/cache/session-stats', authenticateUser, requireAdmin, (req, res) => {
    try {
        const stats = sessionCache.getStats();
        
        logger.info(`Admin ${req.user.email} requested session cache statistics`);
        
        return res.status(200).json({
            success: true,
            cache: stats,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error(`Error fetching session cache statistics: ${error.message}`);
        return res.status(500).json({
            error: 'Failed to fetch session cache statistics',
            message: error.message
        });
    }
});

/**
 * Route to clear all session cache entries
 * DELETE /admin/cache/session-cache
 * Requires authentication and admin privileges
 *
 * This will force all users to re-authenticate on their next request.
 * Useful for security events or when user permissions have been changed.
 */
router.delete('/cache/session-cache', authenticateUser, requireAdmin, (req, res) => {
    try {
        const statsBefore = sessionCache.getStats();
        sessionCache.clear();
        
        logger.warn(`Admin ${req.user.email} cleared all session cache entries (${statsBefore.total} entries removed)`);
        
        return res.status(200).json({
            success: true,
            message: 'All session cache entries cleared',
            entriesRemoved: statsBefore.total,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error(`Error clearing session cache: ${error.message}`);
        return res.status(500).json({
            error: 'Failed to clear session cache',
            message: error.message
        });
    }
});

/**
 * Route to reset session cache statistics counters
 * POST /admin/cache/session-stats/reset
 * Requires authentication and admin privileges
 *
 * Resets the hit/miss counters without clearing cached sessions.
 * Useful for monitoring cache performance over specific time periods.
 */
router.post('/cache/session-stats/reset', authenticateUser, requireAdmin, (req, res) => {
    try {
        sessionCache.resetStats();
        
        logger.info(`Admin ${req.user.email} reset session cache statistics`);
        
        return res.status(200).json({
            success: true,
            message: 'Session cache statistics reset',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error(`Error resetting session cache statistics: ${error.message}`);
        return res.status(500).json({
            error: 'Failed to reset session cache statistics',
            message: error.message
        });
    }
});

/**
 * Route to generate metadata for a TV show
 * POST /admin/metadata/show
 * Requires authentication and admin privileges
 *
 * Request body:
 * {
 *   showName: "Show Name",
 *   forceRefresh: false,
 *   generateBlurhash: true
 * }
 */
router.post('/metadata/show', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { showName, forceRefresh = false, generateBlurhash = true } = req.body;
        
        if (!showName) {
            return res.status(400).json({ error: 'Show name is required' });
        }

        logger.info(`Admin ${req.user.email} requested metadata generation for show: ${showName}`);

        const generator = await MetadataGenerator.create({
            basePath: BASE_PATH,
            forceRefresh,
            generateBlurhash
        });

        const result = await generator.generateForShow(showName);

        if (result.success) {
            logger.info(`Metadata generation completed for show: ${showName}`, { 
                result: result.updated ? 'updated' : result.reason,
                transactionId: result.transactionId 
            });

            return res.status(200).json({
                success: true,
                showName,
                updated: result.updated,
                reason: result.reason,
                tmdbId: result.tmdbId,
                transactionId: result.transactionId,
                seasonResults: result.seasonResults || [],
                imageResults: result.imageResults || {}
            });
        } else {
            logger.error(`Metadata generation failed for show: ${showName}`, { 
                error: result.error,
                transactionId: result.transactionId 
            });

            return res.status(500).json({
                success: false,
                error: result.error,
                transactionId: result.transactionId
            });
        }

    } catch (error) {
        logger.error(`Error in metadata generation for show: ${error.message}`);
        return res.status(500).json({
            error: 'Failed to generate metadata',
            message: error.message
        });
    }
});

/**
 * Route to generate metadata for a movie
 * POST /admin/metadata/movie
 * Requires authentication and admin privileges
 *
 * Request body:
 * {
 *   movieName: "Movie Name",
 *   forceRefresh: false,
 *   generateBlurhash: true
 * }
 */
router.post('/metadata/movie', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { movieName, forceRefresh = false, generateBlurhash = true } = req.body;
        
        if (!movieName) {
            return res.status(400).json({ error: 'Movie name is required' });
        }

        logger.info(`Admin ${req.user.email} requested metadata generation for movie: ${movieName}`);

        const generator = await MetadataGenerator.create({
            basePath: BASE_PATH,
            forceRefresh,
            generateBlurhash
        });

        const result = await generator.generateForMovie(movieName);

        if (result.success) {
            logger.info(`Metadata generation completed for movie: ${movieName}`, { 
                result: result.updated ? 'updated' : result.reason,
                transactionId: result.transactionId 
            });

            return res.status(200).json({
                success: true,
                movieName,
                updated: result.updated,
                reason: result.reason,
                tmdbId: result.tmdbId,
                transactionId: result.transactionId,
                imageResults: result.imageResults || {}
            });
        } else {
            logger.error(`Metadata generation failed for movie: ${movieName}`, { 
                error: result.error,
                transactionId: result.transactionId 
            });

            return res.status(500).json({
                success: false,
                error: result.error,
                transactionId: result.transactionId
            });
        }

    } catch (error) {
        logger.error(`Error in metadata generation for movie: ${error.message}`);
        return res.status(500).json({
            error: 'Failed to generate metadata',
            message: error.message
        });
    }
});

/**
 * Route to generate metadata for all shows or movies
 * POST /admin/metadata/bulk
 * Requires authentication and admin privileges
 *
 * Request body:
 * {
 *   type: "tv" or "movies",
 *   forceRefresh: false,
 *   generateBlurhash: true,
 *   maxConcurrent: 3
 * }
 */
router.post('/metadata/bulk', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { 
            type, 
            forceRefresh = false, 
            generateBlurhash = true, 
            maxConcurrent = 3 
        } = req.body;
        
        if (!type || !['tv', 'movies'].includes(type)) {
            return res.status(400).json({ error: 'Type must be "tv" or "movies"' });
        }

        logger.info(`Admin ${req.user.email} requested bulk metadata generation for: ${type}`);

        const generator = await MetadataGenerator.create({
            basePath: BASE_PATH,
            forceRefresh,
            generateBlurhash,
            maxConcurrent
        });

        // Start long-running process
        const result = await generator.processDirectory(type);

        if (result.success) {
            logger.info(`Bulk metadata generation completed for: ${type}`, { 
                processed: result.processed,
                success: result.successCount,
                errors: result.errorCount,
                transactionId: result.transactionId 
            });

            return res.status(200).json({
                success: true,
                type,
                processed: result.processed,
                successCount: result.successCount,
                errorCount: result.errorCount,
                transactionId: result.transactionId,
                results: result.results || []
            });
        } else {
            logger.error(`Bulk metadata generation failed for: ${type}`, { 
                error: result.error,
                transactionId: result.transactionId 
            });

            return res.status(500).json({
                success: false,
                error: result.error,
                transactionId: result.transactionId
            });
        }

    } catch (error) {
        logger.error(`Error in bulk metadata generation: ${error.message}`);
        return res.status(500).json({
            error: 'Failed to generate bulk metadata',
            message: error.message
        });
    }
});

/**
 * Route to get TMDB configuration for a specific media
 * GET /admin/metadata/config
 * Requires authentication and admin privileges
 *
 * Query parameters:
 * - mediaType: "tv" or "movie"
 * - mediaName: "Media Name"
 */
router.get('/metadata/config', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { mediaType, mediaName } = req.query;
        
        if (!mediaType || !['tv', 'movie'].includes(mediaType)) {
            return res.status(400).json({ error: 'Valid mediaType (tv or movie) is required' });
        }
        
        if (!mediaName) {
            return res.status(400).json({ error: 'mediaName is required' });
        }

        const mediaDir = join(BASE_PATH, mediaType === 'tv' ? 'tv' : 'movies', mediaName);
        const configPath = getTmdbConfigFilePath(mediaDir);
        
        logger.info(`Admin ${req.user.email} requested TMDB config for ${mediaType}: ${mediaName}`);

        const config = await loadTmdbConfig(configPath);

        return res.status(200).json({
            success: true,
            mediaType,
            mediaName,
            config,
            configPath
        });

    } catch (error) {
        logger.error(`Error reading TMDB config: ${error.message}`);
        return res.status(500).json({
            error: 'Failed to read TMDB configuration',
            message: error.message
        });
    }
});

/**
 * Route to update TMDB configuration for a specific media
 * PUT /admin/metadata/config
 * Requires authentication and admin privileges
 *
 * Request body:
 * {
 *   mediaType: "tv" or "movie",
 *   mediaName: "Media Name",
 *   config: { tmdb_id: 1234, allow_updates: true, ... }
 * }
 */
router.put('/metadata/config', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const { mediaType, mediaName, config } = req.body;
        
        if (!mediaType || !['tv', 'movie'].includes(mediaType)) {
            return res.status(400).json({ error: 'Valid mediaType (tv or movie) is required' });
        }
        
        if (!mediaName) {
            return res.status(400).json({ error: 'mediaName is required' });
        }
        
        if (!config) {
            return res.status(400).json({ error: 'config object is required' });
        }

        const mediaDir = join(BASE_PATH, mediaType === 'tv' ? 'tv' : 'movies', mediaName);
        const configPath = getTmdbConfigFilePath(mediaDir);
        
        logger.info(`Admin ${req.user.email} updating TMDB config for ${mediaType}: ${mediaName}`);

        await saveTmdbConfig(configPath, config);

        return res.status(200).json({
            success: true,
            message: 'TMDB configuration updated successfully',
            mediaType,
            mediaName,
            config,
            configPath
        });

    } catch (error) {
        logger.error(`Error updating TMDB config: ${error.message}`);
        return res.status(500).json({
            error: 'Failed to update TMDB configuration',
            message: error.message
        });
    }
});

/**
 * Route to test metadata generation configuration
 * GET /admin/metadata/test
 * Requires authentication and admin privileges
 *
 * Tests TMDB connectivity and configuration without generating actual metadata
 */
router.get('/metadata/test', authenticateUser, requireAdmin, async (req, res) => {
    try {
        logger.info(`Admin ${req.user.email} requested metadata configuration test`);

        // Test environment variables
        const tmdbApiKey = process.env.TMDB_API_KEY;
        
        if (!tmdbApiKey) {
            return res.status(400).json({
                success: false,
                error: 'TMDB_API_KEY environment variable is not set',
                checks: {
                    tmdbApiKey: false,
                    tmdbConnectivity: false,
                    metadataGenerator: false
                }
            });
        }

        // Test TMDB connectivity
        const testResult = await searchMedia('tv', 'Breaking Bad');
        
        const tmdbConnected = testResult.results && testResult.results.length > 0;

        // Test metadata generator initialization
        const generator = await MetadataGenerator.create({
            basePath: BASE_PATH,
            forceRefresh: false,
            generateBlurhash: false
        });

        const generatorInitialized = !!generator;

        logger.info(`Metadata configuration test completed`, { 
            tmdbApiKey: !!tmdbApiKey,
            tmdbConnected,
            generatorInitialized 
        });

        return res.status(200).json({
            success: true,
            message: 'Configuration test completed',
            checks: {
                tmdbApiKey: !!tmdbApiKey,
                tmdbConnectivity: tmdbConnected,
                metadataGenerator: generatorInitialized
            },
            basePath: BASE_PATH,
            testResults: {
                tmdbSearchResults: testResult.results?.length || 0
            }
        });

    } catch (error) {
        logger.error(`Error in metadata configuration test: ${error.message}`);
        return res.status(500).json({
            success: false,
            error: 'Configuration test failed',
            message: error.message
        });
    }
});

/**
 * Gets a language code from a language name
 * @param {string} languageName - Full language name (e.g. "English", "Spanish")
 * @returns {string|null} - ISO 639-1 (2-character) language code or null if not found
 */
function getLanguageCode(languageName) {
    // Strip "Hearing Impaired" suffix if present
    const cleanName = languageName.replace(/\s+hearing\s+impaired$/i, '').trim();
    
    // Use same language mapping as in app.mjs but create a reverse mapping to 2-character codes
    const langMap = {
        en: "English",
        eng: "English",
        es: "Spanish",
        spa: "Spanish",
        tl: "Tagalog",
        tgl: "Tagalog",
        zh: "Chinese",
        zho: "Chinese",
        cs: "Czech",
        cze: "Czech",
        da: "Danish",
        dan: "Danish",
        nl: "Dutch",
        dut: "Dutch",
        fi: "Finnish",
        fin: "Finnish",
        fr: "French",
        fre: "French",
        de: "German",
        ger: "German",
        el: "Greek",
        gre: "Greek",
        hu: "Hungarian",
        hun: "Hungarian",
        it: "Italian",
        ita: "Italian",
        ja: "Japanese",
        jpn: "Japanese",
        ko: "Korean",
        kor: "Korean",
        no: "Norwegian",
        nor: "Norwegian",
        pl: "Polish",
        pol: "Polish",
        pt: "Portuguese",
        por: "Portuguese",
        ro: "Romanian",
        ron: "Romanian",
        rum: "Romanian",
        sk: "Slovak",
        slo: "Slovak",
        sv: "Swedish",
        swe: "Swedish",
        tr: "Turkish",
        tur: "Turkish",
        ar: "Arabic",
        ara: "Arabic",
        bg: "Bulgarian",
        bul: "Bulgarian",
        chi: "Chinese",
        et: "Estonian",
        est: "Estonian",
        he: "Hebrew",
        heb: "Hebrew",
        hi: "Hindi",
        hin: "Hindi",
        id: "Indonesian",
        ind: "Indonesian",
        lv: "Latvian",
        lav: "Latvian",
        lt: "Lithuanian",
        lit: "Lithuanian",
        ms: "Malay",
        may: "Malay",
        ru: "Russian",
        rus: "Russian",
        sl: "Slovenian",
        slv: "Slovenian",
        ta: "Tamil",
        tam: "Tamil",
        te: "Telugu",
        tel: "Telugu",
        th: "Thai",
        tha: "Thai",
        uk: "Ukrainian",
        ukr: "Ukrainian",
        vi: "Vietnamese",
        vie: "Vietnamese",
    };
    
    // Create a reverse mapping from language names to 2-character codes
    const reverseMap = {};
    
    // Populate the reverse map - prioritize 2-character codes
    for (const [code, name] of Object.entries(langMap)) {
        // Only use 2-character codes for the reverse mapping
        if (code.length === 2) {
            reverseMap[name.toLowerCase()] = code;
        }
    }
    
    return reverseMap[cleanName.toLowerCase()] || null;
}

/**
 * Converts WebVTT format to SRT format
 * @param {string} webvttContent - Content in WebVTT format
 * @returns {string} - Content converted to SRT format
 */
function convertWebVttToSrt(webvttContent) {
    // Split content by lines
    const lines = webvttContent.split('\n');
    const srtLines = [];
    
    let index = 1;
    let inCue = false;
    
    // Skip WebVTT header
    let i = 0;
    while (i < lines.length && !lines[i].includes('-->')) {
        i++;
    }
    
    for (; i < lines.length; i++) {
        const line = lines[i];
        
        // Check for timestamp line
        if (line.includes('-->')) {
            // Add cue number
            srtLines.push(index.toString());
            index++;
            
            // Convert timestamp format from WebVTT to SRT
            // WebVTT: 00:00:36.630 --> 00:00:37.795
            // SRT:    00:00:36,630 --> 00:00:37,795
            const convertedTimestamp = line.replace(/\./g, ',');
            srtLines.push(convertedTimestamp);
            
            inCue = true;
        } else if (inCue) {
            if (line.trim() === '') {
                // Empty line marks the end of a cue
                srtLines.push(''); // Empty line between cues
                inCue = false;
            } else {
                // Add content line
                srtLines.push(line);
            }
        }
    }
    
    return srtLines.join('\n');
}

  return router;
}

export default setupAdminRoutes();
