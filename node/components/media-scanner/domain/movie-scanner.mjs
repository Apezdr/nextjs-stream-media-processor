import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { createCategoryLogger } from '../../../lib/logger.mjs';
import {
  calculateDirectoryHash,
  fileExists,
  getLastModifiedTime,
  getStoredBlurhash
} from '../../../utils/utils.mjs';
import { getInfo } from '../../../infoManager.mjs';
import { generateChapters } from '../../../chapter-generator.mjs';
import {
  getExistingMovies,
  getMissingMediaData,
  saveMovie,
  removeMovie,
  markMediaAsMissingData,
  getDatabaseInstance
} from '../data-access/scanner-repository.mjs';

const logger = createCategoryLogger('movie-scanner');

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
 * Check if a movie needs info file regeneration
 * @param {Array<string>} files - List of files in directory
 * @param {string} dirPath - Directory path
 * @param {string} dirName - Directory name
 * @param {number} currentVersion - Current info file version
 * @returns {Promise<boolean>} True if regeneration is needed
 */
async function needsInfoRegeneration(files, dirPath, dirName, currentVersion) {
  const mp4Files = files.filter(file => file.endsWith('.mp4'));
  
  for (const mp4File of mp4Files) {
    const filePath = join(dirPath, dirName, mp4File);
    const infoFile = `${filePath}.info`;
    
    if (await fileExists(infoFile)) {
      try {
        const fileInfo = await fs.readFile(infoFile, 'utf-8');
        const info = JSON.parse(fileInfo);
        
        if (!info.version || info.version < currentVersion) {
          logger.info(`Info file for ${mp4File} has outdated version (${info.version}), regeneration needed`);
          return true;
        }
      } catch (error) {
        logger.warn(`Error reading info file for ${mp4File}, regeneration needed: ${error}`);
        return true;
      }
    } else {
      logger.info(`Info file for ${mp4File} doesn't exist, regeneration needed`);
      return true;
    }
  }
  
  return false;
}

/**
 * Check if TMDB images need to be downloaded
 * @param {Set<string>} fileSet - Set of files in directory
 * @param {string} dirPath - Directory path
 * @param {string} dirName - Directory name
 * @param {Date} tmdbConfigLastModified - Last modified time of tmdb.config
 * @returns {Promise<boolean>} True if download is needed
 */
async function checkTMDBImagesNeeded(fileSet, dirPath, dirName, tmdbConfigLastModified) {
  const imagesToCheck = [
    { name: 'backdrop.jpg', path: join(dirPath, dirName, 'backdrop.jpg') },
    { name: 'poster.jpg', path: join(dirPath, dirName, 'poster.jpg') },
    { name: 'movie_logo.png', path: join(dirPath, dirName, 'movie_logo.png'), alt: 'logo.png' },
    { name: 'metadata.json', path: join(dirPath, dirName, 'metadata.json') }
  ];

  for (const image of imagesToCheck) {
    const exists = fileSet.has(image.name) || (image.alt && fileSet.has(image.alt));
    
    if (!exists) {
      return true;
    }

    // Check if tmdb.config has been updated more recently than the image
    if (exists && tmdbConfigLastModified) {
      const imagePath = fileSet.has(image.name) ? image.path : 
                        (image.alt ? join(dirPath, dirName, image.alt) : image.path);
      const imageLastModified = await getLastModifiedTime(imagePath);
      
      if (imageLastModified && tmdbConfigLastModified > imageLastModified) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Build URL objects for a movie's assets
 * @param {Set<string>} fileSet - Set of files in directory
 * @param {string} dirPath - Directory path
 * @param {string} dirName - Directory name
 * @param {string} prefixPath - URL prefix path
 * @param {string} basePath - Base path for media files
 * @returns {Promise<Object>} URLs object
 */
async function buildMovieURLs(fileSet, dirPath, dirName, prefixPath, basePath) {
  const urls = {};
  const encodedDirName = encodeURIComponent(dirName);

  // Helper to add image URL with hash and blurhash
  const addImageURL = async (fileName, urlKey, blurhashKey) => {
    const imagePath = join(dirPath, dirName, fileName);
    const imageStats = await fs.stat(imagePath);
    const imageHash = createHash('md5')
      .update(imageStats.mtime.toISOString())
      .digest('hex')
      .substring(0, 10);
    
    urls[urlKey] = `${prefixPath}/movies/${encodedDirName}/${encodeURIComponent(fileName)}?hash=${imageHash}`;
    
    if (await fileExists(`${imagePath}.blurhash`)) {
      urls[blurhashKey] = `${prefixPath}/movies/${encodedDirName}/${encodeURIComponent(fileName)}.blurhash`;
    } else {
      await getStoredBlurhash(imagePath, basePath);
    }
  };

  // Backdrop
  if (fileSet.has('backdrop.jpg')) {
    await addImageURL('backdrop.jpg', 'backdrop', 'backdropBlurhash');
  }

  // Poster
  if (fileSet.has('poster.jpg')) {
    await addImageURL('poster.jpg', 'poster', 'posterBlurhash');
  }

  // Logo
  if (fileSet.has('movie_logo.png')) {
    await addImageURL('movie_logo.png', 'logo', 'logoBlurhash');
  } else if (fileSet.has('logo.png')) {
    await addImageURL('logo.png', 'logo', 'logoBlurhash');
  }

  // Metadata
  if (fileSet.has('metadata.json')) {
    urls['metadata'] = `${prefixPath}/movies/${encodedDirName}/${encodeURIComponent('metadata.json')}`;
  }

  return urls;
}

/**
 * Process subtitles for a movie
 * @param {Array<string>} fileNames - List of file names
 * @param {string} dirPath - Directory path
 * @param {string} dirName - Directory name
 * @param {string} prefixPath - URL prefix path
 * @param {Object} langMap - Language code mapping
 * @returns {Promise<Object>} Subtitles object
 */
async function processSubtitles(fileNames, dirPath, dirName, prefixPath, langMap) {
  const subtitles = {};
  const encodedDirName = encodeURIComponent(dirName);

  for (const file of fileNames) {
    if (file.endsWith('.srt')) {
      const filePath = join(dirPath, dirName, file);
      const encodedFilePath = encodeURIComponent(file);
      const parts = file.split('.');
      const srtIndex = parts.lastIndexOf('srt');
      const isHearingImpaired = parts[srtIndex - 1] === 'hi';
      const langCode = isHearingImpaired ? parts[srtIndex - 2] : parts[srtIndex - 1];
      const langName = langMap[langCode] || langCode;
      const subtitleKey = isHearingImpaired ? `${langName} Hearing Impaired` : langName;

      subtitles[subtitleKey] = {
        url: `${prefixPath}/movies/${encodedDirName}/${encodedFilePath}`,
        srcLang: langCode,
        lastModified: (await fs.stat(filePath)).mtime.toISOString()
      };
    }
  }

  return subtitles;
}

/**
 * Process video files and generate URLs
 * @param {Array<string>} fileNames - List of file names
 * @param {string} dirPath - Directory path
 * @param {string} dirName - Directory name
 * @param {string} prefixPath - URL prefix path
 * @returns {Promise<Object>} Object containing file lengths, dimensions, urls, and video metadata
 */
async function processVideoFiles(fileNames, dirPath, dirName, prefixPath) {
  const fileLengths = {};
  const fileDimensions = {};
  const urls = {};
  let hdrInfo, mediaQuality, additionalMetadata, _id;
  const encodedDirName = encodeURIComponent(dirName);

  for (const file of fileNames) {
    if (file.endsWith('.mp4')) {
      const filePath = join(dirPath, dirName, file);
      const encodedFilePath = encodeURIComponent(file);

      try {
        const info = await getInfo(filePath);
        fileLengths[file] = parseInt(info.length, 10);
        fileDimensions[file] = info.dimensions;
        hdrInfo = info.hdr;
        mediaQuality = info.mediaQuality;
        additionalMetadata = info.additionalMetadata;
        _id = info.uuid;
      } catch (error) {
        logger.error(`Failed to retrieve info for ${filePath}: ${error}`);
      }

      urls['mp4'] = `${prefixPath}/movies/${encodedDirName}/${encodedFilePath}`;
      urls['mediaLastModified'] = (await fs.stat(filePath)).mtime.toISOString();
    }
  }

  return { fileLengths, fileDimensions, urls, hdrInfo, mediaQuality, additionalMetadata, _id };
}

/**
 * Process chapters for a movie
 * @param {string} dirPath - Directory path
 * @param {string} dirName - Directory name
 * @param {Array<string>} fileNames - List of file names
 * @param {string} prefixPath - URL prefix path
 * @returns {Promise<string|null>} Chapters URL or null
 */
async function processChapters(dirPath, dirName, fileNames, prefixPath) {
  const encodedDirName = encodeURIComponent(dirName);
  const mp4Filename = fileNames.find(e => e.endsWith('.mp4') && !e.endsWith('.mp4.info'))?.replace('.mp4', '');
  
  if (!mp4Filename) return null;

  const mediaPath = join(dirPath, dirName, `${mp4Filename}.mp4`);
  if (!(await fileExists(mediaPath))) return null;

  const chaptersPath = join(dirPath, dirName, 'chapters', `${dirName}_chapters.vtt`);
  const chaptersPath2 = join(dirPath, dirName, 'chapters', `${mp4Filename}_chapters.vtt`);
  
  await generateChapterFileIfNotExists(chaptersPath, mediaPath, true);
  
  if (!await fileExists(chaptersPath)) {
    await generateChapterFileIfNotExists(chaptersPath2, mediaPath, true);
  }
  
  if (await fileExists(chaptersPath)) {
    return `${prefixPath}/movies/${encodedDirName}/chapters/${encodeURIComponent(`${dirName}_chapters.vtt`)}`;
  } else if (await fileExists(chaptersPath2)) {
    return `${prefixPath}/movies/${encodedDirName}/chapters/${encodeURIComponent(`${mp4Filename}_chapters.vtt`)}`;
  }
  
  return null;
}

/**
 * Extract TMDB ID from config file
 * @param {string} tmdbConfigPath - Path to tmdb.config
 * @returns {Promise<string|null>} TMDB ID or null
 */
async function extractTMDBId(tmdbConfigPath) {
  if (!(await fileExists(tmdbConfigPath))) return null;

  try {
    const tmdbConfigContent = await fs.readFile(tmdbConfigPath, 'utf8');
    const tmdbConfig = JSON.parse(tmdbConfigContent);
    
    if (tmdbConfig.tmdb_id) {
      return `tmdb_${tmdbConfig.tmdb_id}`;
    }
  } catch (error) {
    logger.error(`Failed to parse tmdb.config: ${error}`);
  }

  return null;
}

/**
 * Scan and process all movies in a directory
 * @param {Object} db - Database instance
 * @param {string} dirPath - Directory path to scan
 * @param {string} prefixPath - URL prefix path
 * @param {string} basePath - Base path for media files
 * @param {Object} langMap - Language code mapping
 * @param {number} currentVersion - Current info file version
 * @param {boolean} isDebugMode - Debug mode flag
 * @param {Function} downloadTMDBImages - Function to download TMDB images
 * @returns {Promise<void>}
 */
export async function scanMovies(db, dirPath, prefixPath, basePath, langMap, currentVersion, isDebugMode, downloadTMDBImages) {
  const dirs = await fs.readdir(dirPath, { withFileTypes: true });
  const missingDataMovies = await getMissingMediaData();
  const now = new Date();

  // Get the list of movies currently in the database
  const existingMovies = await getExistingMovies();
  const existingMovieNames = new Set(existingMovies.map(movie => movie.name));

  await Promise.all(
    dirs.map(async (dir, index) => {
      if (isDebugMode) {
        logger.info(`Processing movie: ${dir.name}: ${index + 1} of ${dirs.length}`);
      }
      
      if (!dir.isDirectory()) return;

      const dirName = dir.name;
      const fullDirPath = join(dirPath, dirName);
      const files = await fs.readdir(join(dirPath, dirName));
      const hash = await calculateDirectoryHash(fullDirPath);

      const existingMovie = await db.get('SELECT * FROM movies WHERE name = ?', [dirName]);
      existingMovieNames.delete(dirName);
      const dirHashChanged = existingMovie && existingMovie.directory_hash !== hash;

      // Check if we need to regenerate info files due to version updates
      let needInfoRegeneration = false;
      if (!dirHashChanged && existingMovie) {
        needInfoRegeneration = await needsInfoRegeneration(files, dirPath, dirName, currentVersion);
        
        if (!needInfoRegeneration) {
          if (isDebugMode) {
            logger.info(`No changes detected in ${dirName}, skipping processing.`);
          }
          return;
        } else {
          logger.info(`Processing ${dirName} to update info files`);
        }
      }

      logger.info(`Directory Hash invalidated for, ${dirName}`);

      const fileSet = new Set(files);
      const fileNames = files.filter(file =>
        file.endsWith('.mp4') ||
        file.endsWith('.srt') ||
        file.endsWith('.json') ||
        file.endsWith('.info') ||
        file.endsWith('.nfo') ||
        file.endsWith('.jpg') ||
        file.endsWith('.png')
      );

      let runDownloadTmdbImagesFlag = false;
      const tmdbConfigPath = join(dirPath, dirName, 'tmdb.config');
      let tmdbConfigLastModified = null;

      if (await fileExists(tmdbConfigPath)) {
        tmdbConfigLastModified = await getLastModifiedTime(tmdbConfigPath);
      }

      // Extract TMDB ID
      let _id = await extractTMDBId(tmdbConfigPath);

      // Check if TMDB images need to be downloaded
      runDownloadTmdbImagesFlag = await checkTMDBImagesNeeded(
        fileSet,
        dirPath,
        dirName,
        tmdbConfigLastModified
      );

      // Process video files
      const videoData = await processVideoFiles(fileNames, dirPath, dirName, prefixPath);
      if (videoData._id) _id = videoData._id;

      // Build URLs
      const urls = await buildMovieURLs(fileSet, dirPath, dirName, prefixPath, basePath);
      Object.assign(urls, videoData.urls);

      // Process subtitles
      const subtitles = await processSubtitles(fileNames, dirPath, dirName, prefixPath, langMap);
      if (Object.keys(subtitles).length > 0) {
        urls.subtitles = subtitles;
      }

      // Check if movie is in missing data table and should be retried
      const missingDataMovie = missingDataMovies.find(movie => movie.name === dirName);
      if (missingDataMovie && !dirHashChanged) {
        const lastAttempt = new Date(missingDataMovie.lastAttempt);
        const hoursSinceLastAttempt = (now - lastAttempt) / (1000 * 60 * 60);
        if (hoursSinceLastAttempt >= RETRY_INTERVAL_HOURS) {
          runDownloadTmdbImagesFlag = true;
        } else {
          runDownloadTmdbImagesFlag = false;
        }
      } else if (dirHashChanged) {
        runDownloadTmdbImagesFlag = true;
      }

      // Download TMDB images if needed
      if (runDownloadTmdbImagesFlag) {
        await markMediaAsMissingData(dirName);
        await downloadTMDBImages(null, dirName);
        
        // Retry fetching the data after running the script
        const retryFiles = await fs.readdir(join(dirPath, dirName));
        const retryFileSet = new Set(retryFiles);
        const retryURLs = await buildMovieURLs(retryFileSet, dirPath, dirName, prefixPath, basePath);
        Object.assign(urls, retryURLs);
      }

      // Process chapters
      const chaptersUrl = await processChapters(dirPath, dirName, fileNames, prefixPath);
      if (chaptersUrl) {
        urls.chapters = chaptersUrl;
      }

      // Calculate final hash
      const final_hash = await calculateDirectoryHash(fullDirPath);

      // Extract file paths for direct access
      const posterFilePath = fileSet.has('poster.jpg') ? join(dirPath, dirName, 'poster.jpg') : null;
      const backdropFilePath = fileSet.has('backdrop.jpg') ? join(dirPath, dirName, 'backdrop.jpg') : null;
      const logoFilePath = fileSet.has('movie_logo.png')
        ? join(dirPath, dirName, 'movie_logo.png')
        : (fileSet.has('logo.png') ? join(dirPath, dirName, 'logo.png') : null);

      // Save to database
      await saveMovie(
        dirName,
        fileNames,
        videoData.fileLengths,
        videoData.fileDimensions,
        urls,
        urls.metadata || '',
        final_hash,
        videoData.hdrInfo,
        videoData.mediaQuality,
        videoData.additionalMetadata,
        _id,
        posterFilePath,
        backdropFilePath,
        logoFilePath,
        basePath
      );
    })
  );

  // Remove movies from the database that no longer exist in the file system
  for (const movieName of existingMovieNames) {
    await removeMovie(movieName);
  }
}
