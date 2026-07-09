import { promises as fs } from 'fs';
import { join } from 'path';
import { createCategoryLogger } from '../../../lib/logger.mjs';
import {
  calculateDirectoryHash,
  fileExists,
  getLastModifiedTime,
  getStoredBlurhash
} from '../../../utils/utils.mjs';
import { getInfo } from '../../../infoManager.mjs';
import { generateChapters } from '../../../chapter-generator.mjs';
import { parseSubtitleFilename } from './subtitle-filename.mjs';
import {
  getExistingMovies,
  getMissingMediaData,
  saveMovie,
  removeMovie,
  markMediaAsMissingData,
  clearMissingMediaData,
  getDatabaseInstance,
  RETRY_INTERVAL_HOURS
} from '../data-access/scanner-repository.mjs';
import { generateMovieHashes } from '../../../sqlite/metadataHashes.mjs';
import { loadTmdbConfig, isUpdateAllowed, getMetadataOverrides } from '../../../utils/tmdbConfig.mjs';
import { isFrozenReason } from '../../../lib/metadataGenerator.mjs';
import { resolveCooldownAction } from './cooldown-policy.mjs';
import { detectBackdropFocal } from '../../../utils/backdropFocalDetector.mjs';
import {
  iterateConventions,
  findExistingImageInSet,
  resolveImage,
  imageHashesFromResolved,
} from './image-conventions.mjs';

const logger = createCategoryLogger('movie-scanner');

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
 * Classify which TMDB-derived files (if any) are missing or stale for a movie
 * directory. Splits the result into two independent booleans so the caller
 * can apply different retry policies:
 *
 *   - `missingMetadata` — `metadata.json` is missing or older than `tmdb.config`.
 *     Indicates a TMDB *lookup* problem (e.g. no match for the title); the
 *     scanner applies the 24h `RETRY_INTERVAL_HOURS` cooldown to this case.
 *
 *   - `missingImages` — at least one of poster / backdrop / logo is missing
 *     or stale. Indicates a *download* problem (e.g. transient image-CDN
 *     flake); the scanner bypasses the cooldown for this case so retries
 *     happen every scan tick. Reasoning is in
 *     https://learn.microsoft.com/en-us/azure/architecture/best-practices/transient-faults
 *
 *   - `staleByConfig` — true specifically when tmdb.config is newer than an
 *     EXISTING metadata.json (an id/config edit), as opposed to metadata.json
 *     being plain absent. Mirrors `processShowMetadata`'s flag of the same
 *     name in tv-scanner.mjs; the caller uses it to force a forceRefresh
 *     image repull (wipe-then-redownload) for the new id instead of leaving
 *     the previous id's art on disk under the download's existence checks.
 *
 * @param {Set<string>} fileSet - Set of files in directory
 * @param {string} dirPath - Directory path
 * @param {string} dirName - Directory name
 * @param {Date} tmdbConfigLastModified - Last modified time of tmdb.config
 * @returns {Promise<{missingMetadata: boolean, missingImages: boolean, staleByConfig: boolean}>}
 */
async function checkTMDBImagesNeeded(fileSet, dirPath, dirName, tmdbConfigLastModified) {
  let missingMetadata = false;
  let missingImages = false;
  let staleByConfig = false;

  // Check each image kind via the shared convention. Multi-extension
  // discovery is symmetric with the TV scanner — a TMDB-served .svg movie
  // logo (or a user's manually-placed .gif backdrop) is now visible.
  for (const [, convention] of iterateConventions('movie')) {
    const found = findExistingImageInSet(fileSet, convention);
    let stale = false;
    if (found && tmdbConfigLastModified) {
      const resolvedPath = join(dirPath, dirName, found.fileName);
      const imageLastModified = await getLastModifiedTime(resolvedPath);
      if (imageLastModified && tmdbConfigLastModified > imageLastModified) {
        stale = true;
      }
    }
    if (!found || stale) {
      missingImages = true;
    }
  }

  // metadata.json is its own concern (fixed filename, gated by 24h cooldown
  // for the lookup-failure case rather than the transient-download case).
  const metadataExists = fileSet.has('metadata.json');
  let metadataStale = false;
  if (metadataExists && tmdbConfigLastModified) {
    const metadataPath = join(dirPath, dirName, 'metadata.json');
    const metadataLastModified = await getLastModifiedTime(metadataPath);
    if (metadataLastModified && tmdbConfigLastModified > metadataLastModified) {
      metadataStale = true;
      staleByConfig = true;
    }
  }
  if (!metadataExists || metadataStale) {
    missingMetadata = true;
  }

  return { missingMetadata, missingImages, staleByConfig };
}

/**
 * Build URL objects for a movie's assets
 * @param {Set<string>} fileSet - Set of files in directory
 * @param {string} dirPath - Directory path
 * @param {string} dirName - Directory name
 * @param {string} prefixPath - URL prefix path
 * @param {string} basePath - Base path for media files
 * @returns {Promise<{urls: Object, resolved: {poster: ?Object, backdrop: ?Object, logo: ?Object}}>}
 *   `urls` is the URL map; `resolved` carries each kind's single resolveImage()
 *   result (file path + mtime + cache-bust hash) so the caller can feed the DB
 *   the exact file/hash that produced the URL — no second stat, no drift.
 */
async function buildMovieURLs(fileSet, dirPath, dirName, prefixPath, basePath) {
  const urls = {};
  const encodedDirName = encodeURIComponent(dirName);
  const movieDir = join(dirPath, dirName);
  const resolved = { poster: null, backdrop: null, logo: null };

  // Discover each image kind via the shared convention (multi-extension) with a
  // single readdir-set lookup + single stat per kind. The same resolution drives
  // the URL filename, the baked `?hash=` token, and (via `resolved`) the DB row.
  const blurhashKeyMap = {
    poster:   'posterBlurhash',
    backdrop: 'backdropBlurhash',
    logo:     'logoBlurhash',
  };
  for (const [imageKey, convention] of iterateConventions('movie')) {
    const r = await resolveImage({ dirPath: movieDir, fileSet, convention });
    if (!r) continue;
    resolved[imageKey] = r;
    const encodedFileName = encodeURIComponent(r.fileName);
    urls[imageKey] = `${prefixPath}/movies/${encodedDirName}/${encodedFileName}?hash=${r.hash}`;

    // SVG sources have no usable raster blurhash representation (`sharp` may
    // error or emit a junk hash), so skip blurhash for them. Mirrors TV.
    if (r.ext === 'svg') continue;
    if (await fileExists(`${r.path}.blurhash`)) {
      urls[blurhashKeyMap[imageKey]] = `${prefixPath}/movies/${encodedDirName}/${encodedFileName}.blurhash`;
    } else {
      await getStoredBlurhash(r.path, basePath);
    }
  }

  // Metadata
  if (fileSet.has('metadata.json')) {
    urls['metadata'] = `${prefixPath}/movies/${encodedDirName}/${encodeURIComponent('metadata.json')}`;
  }

  return { urls, resolved };
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
      const parsed = parseSubtitleFilename(file, langMap);
      if (!parsed) continue;

      const filePath = join(dirPath, dirName, file);
      const encodedFilePath = encodeURIComponent(file);

      subtitles[parsed.subtitleKey] = {
        url: `${prefixPath}/movies/${encodedDirName}/${encodedFilePath}`,
        srcLang: parsed.langCode,
        autoGenerated: parsed.isAutoGenerated,
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

      // Extract TMDB ID, freeze flag, and manual focal override from config.
      // loadTmdbConfig THROWS on unparseable JSON — tolerate it per movie
      // (warn-and-continue) so one corrupt config can't reject the whole
      // Promise.all pass. Fail CLOSED on the freeze flag (§4.2): an
      // unreadable config means the freeze state is unknown, so no TMDB
      // write paths may open off assumed defaults.
      let tmdbConfig;
      try {
        tmdbConfig = await loadTmdbConfig(tmdbConfigPath);
      } catch (err) {
        logger.warn(`Unparseable tmdb.config for ${dirName}, treating as frozen this pass: ${err.message}`);
        tmdbConfig = { update_metadata: false, backdrop_focal: null };
      }
      const updateAllowed = isUpdateAllowed(tmdbConfig);
      const hasOverrides = getMetadataOverrides(tmdbConfig) !== null;
      let _id = tmdbConfig.tmdb_id ? `tmdb_${tmdbConfig.tmdb_id}` : null;
      const manualFocal = tmdbConfig.backdrop_focal ?? null;

      // Classify which TMDB-derived files (if any) are missing/stale.
      const { missingMetadata, missingImages, staleByConfig } = await checkTMDBImagesNeeded(
        fileSet,
        dirPath,
        dirName,
        tmdbConfigLastModified
      );

      // Process video files
      const videoData = await processVideoFiles(fileNames, dirPath, dirName, prefixPath);
      if (videoData._id) _id = videoData._id;

      // Build URLs. The resolution map (file path + mtime + hash per kind) comes
      // from the same pass that builds the URLs, so the DB row below stores the
      // exact file + hash the URL points at. Reassigned to the post-download
      // resolution inside the download block when a re-pull happens.
      const built = await buildMovieURLs(fileSet, dirPath, dirName, prefixPath, basePath);
      const urls = built.urls;
      let resolvedImages = built.resolved;
      Object.assign(urls, videoData.urls);

      // Process subtitles
      const subtitles = await processSubtitles(fileNames, dirPath, dirName, prefixPath, langMap);
      if (Object.keys(subtitles).length > 0) {
        urls.subtitles = subtitles;
      }

      // Compute the retry gate. The 24h cooldown (RETRY_INTERVAL_HOURS)
      // applies ONLY to the metadata-missing path — that case represents a
      // TMDB *lookup* failure that's not worth retrying every 3 minutes.
      // Image-download failures bypass the cooldown because they are
      // typically transient (image CDN flake, network glitch); see
      // https://learn.microsoft.com/en-us/azure/architecture/best-practices/transient-faults
      // dirHashChanged forces a retry of either kind regardless.
      const missingDataMovie = missingDataMovies.find(movie => movie.name === dirName);
      const metadataGateAllowsRetry =
        !missingDataMovie ||
        ((now - new Date(missingDataMovie.lastAttempt)) / (1000 * 60 * 60)) >= RETRY_INTERVAL_HOURS;

      // Freeze-aware retry gates (Branch 3, §4.2 narrowed contract):
      //  - images-missing consults the freeze flag so a frozen movie with a
      //    permanently missing image (e.g. TMDB has no logo) can't re-invoke
      //    the generator every tick forever.
      //  - metadata-missing opens for a frozen movie ONLY when tmdb.config
      //    carries metadata overrides — the one frozen case with real work
      //    to do (_applyOverridesWhileFrozen), and it self-resolves by
      //    writing metadata.json. A frozen movie with no overrides is left
      //    alone: since the post-attempt bookkeeping clears (not marks) its
      //    cooldown row, an ungated branch would re-run the movie on every
      //    tick its hash keeps it reachable. A config edit / unfreeze is
      //    still picked up immediately — any tmdb.config write bumps its
      //    mtime, which flips dirHashChanged and that term bypasses everything.
      runDownloadTmdbImagesFlag =
        dirHashChanged ||
        (missingImages && updateAllowed) ||
        (missingMetadata && metadataGateAllowsRetry && (updateAllowed || hasOverrides));

      // Download TMDB images if needed. The bypass log is emitted AFTER
      // the download attempt, conditional on actual work having happened
      // — items where TMDB has nothing to offer for the missing slot
      // become silent no-ops, which keeps the log channel clean for
      // genuine retry activity.
      if (runDownloadTmdbImagesFlag) {
        // Previously-managed file paths from the DB row. MetadataGenerator's
        // reconcile step uses these to detect orphans (the path we'd write
        // now differs from the path we wrote last time, e.g. override URL
        // extension changed). Null on first scan; safe.
        const previousPaths = existingMovie ? {
          poster:   existingMovie.poster_file_path || null,
          backdrop: existingMovie.backdrop_file_path || null,
          logo:     existingMovie.logo_file_path || null,
        } : null;
        // A tmdb.config edit (id change) forces a forceRefresh repull so the
        // generator wipes the previous id's images first, then re-downloads —
        // otherwise the downloader's existence check would leave the old id's
        // art on disk. Symmetric with the TV path's `fullScan: metadataResult.staleByConfig`.
        const downloadResult = await downloadTMDBImages({
          movieName: dirName,
          previousPaths,
          fullScan: staleByConfig,
        });

        // Post-condition observability: only log when the images-only
        // bypass produced real download or failure events. cache-hit /
        // no-url outcomes are uninteresting at the scanner level.
        const summary = downloadResult?.imageSummary;
        const didWork =
          summary &&
          ((summary.downloaded ?? 0) > 0 || (summary.failed ?? 0) > 0);
        if (didWork && missingImages && !missingMetadata && !dirHashChanged) {
          logger.info('scanner: images-only retry performed work', {
            'media.name': dirName,
            'media.type': 'movie',
            imageSummary: summary
          });
        }

        // Retry fetching the data after running the script
        const retryFiles = await fs.readdir(join(dirPath, dirName));
        const retryFileSet = new Set(retryFiles);
        // Rebuild URLs + resolution map against the POST-download contents: a
        // download may have changed an image's extension (e.g. an override logo
        // svg→png), so both the URL and the DB file_path/hash must track the
        // file that now exists on disk.
        const retryBuilt = await buildMovieURLs(retryFileSet, dirPath, dirName, prefixPath, basePath);
        Object.assign(urls, retryBuilt.urls);
        resolvedImages = retryBuilt.resolved;

        const after = await checkTMDBImagesNeeded(
          retryFileSet,
          dirPath,
          dirName,
          tmdbConfigLastModified
        );

        // Cooldown bookkeeping, decided AFTER the attempt from the generator's
        // returned reason plus the post-attempt disk state. The full decision
        // table lives in resolveCooldownAction (cooldown-policy.mjs); clears
        // are skipped when no row exists (missingDataMovie was null) to avoid
        // a no-op DELETE per tick.
        const cooldownAction = resolveCooldownAction({
          metadataStillMissing: after.missingMetadata,
          imagesStillMissing: after.missingImages,
          frozen: isFrozenReason(downloadResult?.reason),
          hasOverrides,
        });
        if (cooldownAction === 'mark') {
          await markMediaAsMissingData(dirName);
        } else if (cooldownAction === 'clear' && missingDataMovie) {
          await clearMissingMediaData(dirName);
        }
      }

      // Process chapters
      const chaptersUrl = await processChapters(dirPath, dirName, fileNames, prefixPath);
      if (chaptersUrl) {
        urls.chapters = chaptersUrl;
      }

      // Calculate final hash
      const final_hash = await calculateDirectoryHash(fullDirPath);

      // File paths + cache-bust hashes come from the SAME resolve that built the
      // URLs (resolveImage: one set lookup + one stat per kind). The URL
      // filename, *_file_path, and *_hash therefore cannot disagree — the drift
      // that once froze a movie logo on a stale hash is structurally impossible.
      const posterFilePath = resolvedImages.poster?.path ?? null;
      const backdropFilePath = resolvedImages.backdrop?.path ?? null;
      const logoFilePath = resolvedImages.logo?.path ?? null;
      const imageHashes = imageHashesFromResolved(resolvedImages);

      // Auto-detect backdrop focal point
      const backdropFocalSuggested = backdropFilePath ? await detectBackdropFocal(backdropFilePath) : null;

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
        basePath,
        manualFocal,
        backdropFocalSuggested,
        imageHashes
      );

      // Immediately regenerate the metadata hash using the fresh data just saved.
      // The scheduled hash job filters by mp4 mtime and would miss changes where
      // only tmdb.config or images changed, so we generate here to avoid the gap.
      //
      // metadata.json content is folded into the hash so it invalidates on
      // tmdb.config-driven regenerations — symmetric with the TV episode hash
      // (metadataHashes.mjs `metadata: episodeData.metadata`). Without it the
      // hash inputs only change when the mp4 mtime advances, so client caches
      // would keep serving stale metadata after a TMDB-id edit.
      //
      // Fallback chain: parsed JSON > {mtime,size} marker > null. The marker
      // keeps the hash advancing if the file exists but can't be parsed
      // (rare, but better than the hash silently freezing).
      if (dirHashChanged) {
        const metadataPath = join(dirPath, dirName, 'metadata.json');
        let metadataFingerprint = null;
        try {
          metadataFingerprint = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        } catch (readErr) {
          try {
            const st = await fs.stat(metadataPath);
            metadataFingerprint = { _stat: { mtimeMs: st.mtimeMs, size: st.size } };
          } catch {
            // file doesn't exist at all — leave as null
          }
        }
        await generateMovieHashes(db, {
          _id,
          name: dirName,
          urls,
          hdr: videoData.hdrInfo,
          mediaQuality: videoData.mediaQuality,
          metadataUrl: urls.metadata || '',
          metadata: metadataFingerprint,
        });
      }
    })
  );

  // Remove movies from the database that no longer exist in the file system
  for (const movieName of existingMovieNames) {
    await removeMovie(movieName);
  }
}
