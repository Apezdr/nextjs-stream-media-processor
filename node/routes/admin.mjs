import express from 'express';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createCategoryLogger } from '../lib/logger.mjs';
import { authenticateUser, requireAdmin } from '../middleware/auth.mjs';
import { fileExists } from '../utils/utils.mjs';

const router = express.Router();
const logger = createCategoryLogger('admin-routes');

// BASE_PATH is the path to the media files directory
const BASE_PATH = process.env.BASE_PATH ? process.env.BASE_PATH : "/var/www/html";

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

export default router;
