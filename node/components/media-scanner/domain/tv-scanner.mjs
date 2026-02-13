import { promises as fs } from 'fs';
import { join, normalize } from 'path';
import { createHash } from 'crypto';
import { createCategoryLogger } from '../../../lib/logger.mjs';
import {
  fileExists,
  getStoredBlurhash,
  deriveEpisodeTitle
} from '../../../utils/utils.mjs';
import { getInfo } from '../../../infoManager.mjs';
import { generateChapters } from '../../../chapter-generator.mjs';
import {
  getExistingTVShows,
  getMissingMediaData,
  saveTVShow,
  removeTVShow,
  markMediaAsMissingData
} from '../data-access/scanner-repository.mjs';

const logger = createCategoryLogger('tv-scanner');

// Constants
const RETRY_INTERVAL_HOURS = 24;

/**
 * Helper function to generate chapter files if they don't exist
 * @param {string} chaptersPath - Path to chapters file
 * @param {string} mediaPath - Path to media file
 * @param {boolean} quietMode - Whether to suppress logging
 */
async function generateChapterFileIfNotExists(chaptersPath, mediaPath, quietMode = false) {
  if (!(await fileExists(chaptersPath))) {
    try {
      await generateChapters(mediaPath, quietMode);
    } catch (error) {
      logger.error(`Failed to generate chapters for ${mediaPath}: ${error.message}`);
    }
  }
}

/**
 * Process show assets (poster, logo, backdrop)
 * @param {string} showPath - Path to show directory
 * @param {string} encodedShowName - URL-encoded show name
 * @param {string} prefixPath - URL prefix path
 * @param {string} basePath - Base path for media files
 * @returns {Promise<Object>} Object containing asset URLs and flags
 */
async function processShowAssets(showPath, encodedShowName, prefixPath, basePath) {
  let poster = '';
  let posterBlurhash = '';
  let logo = '';
  let logoBlurhash = '';
  let backdrop = '';
  let backdropBlurhash = '';
  let runDownloadTmdbImagesFlag = false;

  // Helper to add image with hash and blurhash
  const addImage = async (fileName, urlKey, blurhashKey) => {
    const imagePath = join(showPath, fileName);
    if (await fileExists(imagePath)) {
      const imageStats = await fs.stat(imagePath);
      const imageHash = createHash('md5')
        .update(imageStats.mtime.toISOString())
        .digest('hex')
        .substring(0, 10);
      
      const url = `${prefixPath}/tv/${encodedShowName}/${fileName}?hash=${imageHash}`;
      const blurhash = await getStoredBlurhash(imagePath, basePath);
      
      return { url, blurhash, found: true };
    }
    return { url: '', blurhash: '', found: false };
  };

  // Handle show poster
  const posterResult = await addImage('show_poster.jpg');
  if (posterResult.found) {
    poster = posterResult.url;
    if (posterResult.blurhash) posterBlurhash = posterResult.blurhash;
  } else {
    runDownloadTmdbImagesFlag = true;
  }

  // Handle show logo
  const logoExtensions = ['svg', 'jpg', 'png', 'gif'];
  let logoFound = false;
  for (const ext of logoExtensions) {
    const logoResult = await addImage(`show_logo.${ext}`);
    if (logoResult.found) {
      logo = logoResult.url;
      if (ext !== 'svg' && logoResult.blurhash) {
        logoBlurhash = logoResult.blurhash;
      }
      logoFound = true;
      break;
    }
  }
  if (!logoFound) {
    runDownloadTmdbImagesFlag = true;
  }

  // Handle show backdrop
  const backdropExtensions = ['jpg', 'png', 'gif'];
  let backdropFound = false;
  for (const ext of backdropExtensions) {
    const backdropResult = await addImage(`show_backdrop.${ext}`);
    if (backdropResult.found) {
      backdrop = backdropResult.url;
      if (backdropResult.blurhash) backdropBlurhash = backdropResult.blurhash;
      backdropFound = true;
      break;
    }
  }
  if (!backdropFound) {
    runDownloadTmdbImagesFlag = true;
  }

  return {
    poster,
    posterBlurhash,
    logo,
    logoBlurhash,
    backdrop,
    backdropBlurhash,
    runDownloadTmdbImagesFlag,
    logoExtensions,
    backdropExtensions
  };
}

/**
 * Process show metadata
 * @param {string} showPath - Path to show directory
 * @param {string} encodedShowName - URL-encoded show name
 * @param {string} prefixPath - URL prefix path
 * @returns {Promise<Object>} Object containing metadata URL and content
 */
async function processShowMetadata(showPath, encodedShowName, prefixPath) {
  let metadataUrl = '';
  let metadata = '';
  let runDownloadTmdbImagesFlag = false;

  const metadataFilePath = join(showPath, 'metadata.json');
  if (await fileExists(metadataFilePath)) {
    metadataUrl = `${prefixPath}/tv/${encodedShowName}/metadata.json`;
    metadata = JSON.stringify(JSON.parse(await fs.readFile(metadataFilePath, 'utf8')));
  } else {
    runDownloadTmdbImagesFlag = true;
  }

  return { metadataUrl, metadata, runDownloadTmdbImagesFlag };
}

/**
 * Process episode subtitles
 * @param {string} seasonPath - Path to season directory
 * @param {string} episode - Episode filename
 * @param {string} encodedShowName - URL-encoded show name
 * @param {string} encodedSeasonName - URL-encoded season name
 * @param {string} prefixPath - URL prefix path
 * @param {Object} langMap - Language code mapping
 * @returns {Promise<Object>} Subtitles object
 */
async function processEpisodeSubtitles(seasonPath, episode, encodedShowName, encodedSeasonName, prefixPath, langMap) {
  const subtitles = {};
  const subtitleFiles = await fs.readdir(seasonPath);
  
  for (const subtitleFile of subtitleFiles) {
    if (subtitleFile.startsWith(episode.replace('.mp4', '')) && subtitleFile.endsWith('.srt')) {
      const parts = subtitleFile.split('.');
      const srtIndex = parts.lastIndexOf('srt');
      const isHearingImpaired = parts[srtIndex - 1] === 'hi';
      const langCode = isHearingImpaired ? parts[srtIndex - 2] : parts[srtIndex - 1];
      const langName = langMap[langCode] || langCode;
      const subtitleKey = isHearingImpaired ? `${langName} Hearing Impaired` : langName;
      
      subtitles[subtitleKey] = {
        url: `${prefixPath}/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(subtitleFile)}`,
        srcLang: langCode,
        lastModified: (await fs.stat(join(seasonPath, subtitleFile))).mtime.toISOString()
      };
    }
  }
  
  return subtitles;
}

/**
 * Process a single episode
 * @param {string} episode - Episode filename
 * @param {string} seasonPath - Path to season directory
 * @param {string} showName - Show name
 * @param {string} encodedShowName - URL-encoded show name
 * @param {string} encodedSeasonName - URL-encoded season name
 * @param {string} seasonNumber - Season number (padded)
 * @param {string} prefixPath - URL prefix path
 * @param {string} basePath - Base path for media files
 * @param {Object} langMap - Language code mapping
 * @returns {Promise<Object|null>} Episode data object or null if processing fails
 */
async function processEpisode(episode, seasonPath, showName, encodedShowName, encodedSeasonName, seasonNumber, prefixPath, basePath, langMap) {
  const episodePath = join(seasonPath, episode);
  const encodedEpisodePath = encodeURIComponent(episode);

  let derivedEpisodeName = deriveEpisodeTitle(episode);
  let fileLength, fileDimensions, hdrInfo, mediaQuality, additionalMetadata, uuid;

  try {
    const info = await getInfo(episodePath);
    fileLength = info.length;
    fileDimensions = info.dimensions;
    hdrInfo = info.hdr;
    mediaQuality = info.mediaQuality;
    additionalMetadata = info.additionalMetadata;
    uuid = info.uuid;
  } catch (error) {
    logger.error(`Failed to retrieve info for ${episodePath}: ${error}`);
  }

  // Extract episode number
  const episodeNumberMatch = episode.match(/S\d+E(\d+)/i);
  const episodeNumber = episodeNumberMatch ? episodeNumberMatch[1] : (episode.match(/\d+/) || ['0'])[0];
  
  if (!episodeNumber || !seasonNumber) {
    logger.warn(`Could not extract episode or season number from ${episode}, skipping.`);
    return null;
  }

  const paddedEpisodeNumber = episodeNumber.padStart(2, '0');
  const episodeKey = `S${seasonNumber}E${paddedEpisodeNumber}`;

  const episodeData = {
    _id: uuid,
    filename: episode,
    videoURL: `${prefixPath}/tv/${encodedShowName}/${encodedSeasonName}/${encodedEpisodePath}`,
    mediaLastModified: (await fs.stat(episodePath)).mtime.toISOString(),
    hdr: hdrInfo || null,
    mediaQuality: mediaQuality || null,
    additionalMetadata: additionalMetadata || {},
    episodeNumber: parseInt(episodeNumber, 10),
    derivedEpisodeName: derivedEpisodeName,
    length: parseInt(fileLength, 10),
    dimensions: fileDimensions
  };

  // Handle thumbnail
  const thumbnailPath = join(seasonPath, `${episodeNumber} - Thumbnail.jpg`);
  if (await fileExists(thumbnailPath)) {
    const thumbnailStats = await fs.stat(thumbnailPath);
    const thumbnailImageHash = createHash('md5')
      .update(thumbnailStats.mtime.toISOString())
      .digest('hex')
      .substring(0, 10);
    
    episodeData.thumbnail = `${prefixPath}/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(
      `${episodeNumber} - Thumbnail.jpg`
    )}?hash=${thumbnailImageHash}`;
    
    const blurhash = await getStoredBlurhash(thumbnailPath, basePath);
    if (blurhash) {
      episodeData.thumbnailBlurhash = blurhash;
    }
  }

  // Handle episode metadata
  const episodeMetadataPath = join(seasonPath, `${episodeNumber}_metadata.json`);
  if (await fileExists(episodeMetadataPath)) {
    episodeData.metadata = `${prefixPath}/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(
      `${episodeNumber}_metadata.json`
    )}`;
  }

  // Handle chapters
  const chaptersPath = join(
    seasonPath,
    'chapters',
    `${showName} - S${seasonNumber}E${paddedEpisodeNumber}_chapters.vtt`
  );
  
  await generateChapterFileIfNotExists(chaptersPath, episodePath, true);
  
  if (await fileExists(chaptersPath)) {
    episodeData.chapters = `${prefixPath}/tv/${encodedShowName}/${encodedSeasonName}/chapters/${encodeURIComponent(
      `${showName} - S${seasonNumber}E${paddedEpisodeNumber}_chapters.vtt`
    )}`;
  }

  // Process subtitles
  const subtitles = await processEpisodeSubtitles(
    seasonPath,
    episode,
    encodedShowName,
    encodedSeasonName,
    prefixPath,
    langMap
  );
  
  if (Object.keys(subtitles).length > 0) {
    episodeData.subtitles = subtitles;
  }

  return { episodeKey, episodeData, length: parseInt(fileLength, 10), dimensions: fileDimensions };
}

/**
 * Process a single season
 * @param {Object} season - Season directory entry
 * @param {string} showPath - Path to show directory
 * @param {string} showName - Show name
 * @param {string} encodedShowName - URL-encoded show name
 * @param {string} prefixPath - URL prefix path
 * @param {string} basePath - Base path for media files
 * @param {Object} langMap - Language code mapping
 * @returns {Promise<Object|null>} Season data object or null if no episodes
 */
async function processSeason(season, showPath, showName, encodedShowName, prefixPath, basePath, langMap) {
  if (!season.isDirectory()) return null;

  const seasonName = season.name;
  const encodedSeasonName = encodeURIComponent(seasonName);
  const seasonPath = join(showPath, seasonName);
  const seasonNumberMatch = seasonName.match(/\d+/);
  const seasonNumber = seasonNumberMatch ? seasonNumberMatch[0].padStart(2, '0') : '00';

  const episodes = await fs.readdir(seasonPath);
  const validEpisodes = episodes.filter(
    episode => episode.endsWith('.mp4') && !episode.includes('-TdarrCacheFile-')
  );
  
  if (validEpisodes.length === 0) return null;

  const seasonData = {
    episodes: {},
    lengths: {},
    dimensions: {},
    seasonNumber: parseInt(seasonNumber, 10)
  };

  // Handle season poster
  const seasonPosterPath = join(seasonPath, 'season_poster.jpg');
  if (await fileExists(seasonPosterPath)) {
    const seasonPosterStats = await fs.stat(seasonPosterPath);
    const seasonPosterImageHash = createHash('md5')
      .update(seasonPosterStats.mtime.toISOString())
      .digest('hex')
      .substring(0, 10);
    
    seasonData.season_poster = `${prefixPath}/tv/${encodedShowName}/${encodedSeasonName}/season_poster.jpg?hash=${seasonPosterImageHash}`;
    
    const blurhash = await getStoredBlurhash(seasonPosterPath, basePath);
    if (blurhash) {
      seasonData.seasonPosterBlurhash = blurhash;
    }
  }

  // Process each episode
  for (const episode of validEpisodes) {
    const episodeResult = await processEpisode(
      episode,
      seasonPath,
      showName,
      encodedShowName,
      encodedSeasonName,
      seasonNumber,
      prefixPath,
      basePath,
      langMap
    );
    
    if (episodeResult) {
      seasonData.episodes[episodeResult.episodeKey] = episodeResult.episodeData;
      seasonData.lengths[episodeResult.episodeKey] = episodeResult.length;
      seasonData.dimensions[episodeResult.episodeKey] = episodeResult.dimensions;
    }
  }

  // Process all thumbnails to ensure blurhash is generated
  const thumbnailFiles = episodes.filter(file => file.endsWith(' - Thumbnail.jpg'));
  for (const thumbnailFile of thumbnailFiles) {
    const thumbnailPath = join(seasonPath, thumbnailFile);
    await getStoredBlurhash(thumbnailPath, basePath);
  }

  return { seasonName, seasonData };
}

/**
 * Scan and process all TV shows in a directory
 * @param {Object} db - Database instance
 * @param {string} dirPath - Directory path to scan
 * @param {string} prefixPath - URL prefix path
 * @param {string} basePath - Base path for media files
 * @param {Object} langMap - Language code mapping
 * @param {boolean} isDebugMode - Debug mode flag
 * @param {Function} downloadTMDBImages - Function to download TMDB images
 * @returns {Promise<void>}
 */
export async function scanTVShows(db, dirPath, prefixPath, basePath, langMap, isDebugMode, downloadTMDBImages) {
  const shows = await fs.readdir(dirPath, { withFileTypes: true });
  const missingDataMedia = await getMissingMediaData();
  const now = new Date();

  // Get the list of TV shows currently in the database
  const existingShows = await getExistingTVShows();
  const existingShowNames = new Set(existingShows.map(show => show.name));

  try {
    for (let index = 0; index < shows.length; index++) {
      const show = shows[index];
      
      if (isDebugMode) {
        logger.info(`Processing show: ${show.name}: ${index + 1} of ${shows.length}`);
      }
      
      if (!show.isDirectory()) continue;

      const showName = show.name;
      existingShowNames.delete(showName);
      const encodedShowName = encodeURIComponent(showName);
      const showPath = normalize(join(dirPath, showName));
      
      const allItems = await fs.readdir(showPath, { withFileTypes: true });
      const seasonFolders = allItems.filter(
        item => item.isDirectory() && item.name.startsWith('Season')
      );
      const sortedSeasonFolders = seasonFolders.sort((a, b) => {
        const aNum = parseInt(a.name.replace('Season', ''));
        const bNum = parseInt(b.name.replace('Season', ''));
        return aNum - bNum;
      });
      const otherItems = allItems.filter(item => !seasonFolders.includes(item));
      const seasons = [...sortedSeasonFolders, ...otherItems];

      // Process show assets
      const assetsResult = await processShowAssets(showPath, encodedShowName, prefixPath, basePath);
      let runDownloadTmdbImagesFlag = assetsResult.runDownloadTmdbImagesFlag;

      // Process metadata
      const metadataResult = await processShowMetadata(showPath, encodedShowName, prefixPath);
      if (metadataResult.runDownloadTmdbImagesFlag) {
        runDownloadTmdbImagesFlag = true;
      }

      // Handle missing data attempts
      const missingDataShow = missingDataMedia.find(media => media.name === showName);
      if (missingDataShow) {
        const lastAttempt = new Date(missingDataShow.lastAttempt);
        const hoursSinceLastAttempt = (now - lastAttempt) / (1000 * 60 * 60);
        if (hoursSinceLastAttempt >= RETRY_INTERVAL_HOURS) {
          runDownloadTmdbImagesFlag = true;
        } else {
          runDownloadTmdbImagesFlag = false;
        }
      }

      // Download TMDB images if needed
      if (runDownloadTmdbImagesFlag) {
        await markMediaAsMissingData(showName);
        await downloadTMDBImages(showName);
        
        // Retry fetching assets after download
        const retryAssetsResult = await processShowAssets(showPath, encodedShowName, prefixPath, basePath);
        Object.assign(assetsResult, retryAssetsResult);
      }

      // Process seasons
      const seasonsObj = {};
      await Promise.all(
        seasons.map(async season => {
          const seasonResult = await processSeason(
            season,
            showPath,
            showName,
            encodedShowName,
            prefixPath,
            basePath,
            langMap
          );
          
          if (seasonResult) {
            seasonsObj[seasonResult.seasonName] = seasonResult.seasonData;
          }
        })
      );

      // Sort seasons
      const sortedSeasons = Object.fromEntries(
        Object.entries(seasonsObj).sort((a, b) => {
          const seasonA = a[0].match(/\d+/)?.[0].padStart(3, '0') || '000';
          const seasonB = b[0].match(/\d+/)?.[0].padStart(3, '0') || '000';
          return seasonA.localeCompare(seasonB);
        })
      );

      // Extract file paths for direct access
      const posterFilePath = await fileExists(join(showPath, 'show_poster.jpg'))
        ? join(showPath, 'show_poster.jpg')
        : null;

      let logoFilePath = null;
      for (const ext of assetsResult.logoExtensions) {
        const logoPath = join(showPath, `show_logo.${ext}`);
        if (await fileExists(logoPath)) {
          logoFilePath = logoPath;
          break;
        }
      }

      let backdropFilePath = null;
      for (const ext of assetsResult.backdropExtensions) {
        const backdropPath = join(showPath, `show_backdrop.${ext}`);
        if (await fileExists(backdropPath)) {
          backdropFilePath = backdropPath;
          break;
        }
      }

      // Save to database
      await saveTVShow(
        showName,
        metadataResult.metadata,
        metadataResult.metadataUrl,
        assetsResult.poster,
        assetsResult.posterBlurhash,
        assetsResult.logo,
        assetsResult.logoBlurhash,
        assetsResult.backdrop,
        assetsResult.backdropBlurhash,
        sortedSeasons,
        posterFilePath,
        backdropFilePath,
        logoFilePath,
        basePath
      );
    }

    // Remove TV shows from the database that no longer exist in the file system
    for (const showName of existingShowNames) {
      await removeTVShow(showName);
    }
  } catch (error) {
    logger.error('Error during database update: ' + error);
  }
}
