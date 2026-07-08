import { promises as fs } from 'fs';
import { join, normalize, dirname } from 'path';
import pLimit from 'p-limit';
import { createCategoryLogger } from '../../../lib/logger.mjs';
import {
  fileExists,
  getStoredBlurhash,
  deriveEpisodeTitle,
  calculateDirectoryHash,
  getLastModifiedTime
} from '../../../utils/utils.mjs';
import { getInfo } from '../../../infoManager.mjs';
import { generateChapters } from '../../../chapter-generator.mjs';
import { chapterInfo } from '../../../ffmpeg/ffprobe.mjs';
import { parseSubtitleFilename } from './subtitle-filename.mjs';
import {
  getExistingTVShows,
  getExistingTVShowHashes,
  getMissingMediaData,
  saveTVShow,
  removeTVShow,
  markMediaAsMissingData,
  clearMissingMediaData,
  RETRY_INTERVAL_HOURS,
  getEpisodeRetryRows,
  recordEpisodeAttempt,
  clearEpisodeRetry
} from '../data-access/scanner-repository.mjs';
import { deleteHashesForMedia, generateTVShowHashes } from '../../../sqlite/metadataHashes.mjs';
import { getTVShowByName } from '../../../sqliteDatabase.mjs';
import { refreshMissingEpisodes } from '../../../lib/metadataGenerator.mjs';
import { loadTmdbConfig, getTmdbConfigFilePath, isUpdateAllowed } from '../../../utils/tmdbConfig.mjs';
import { detectBackdropFocal } from '../../../utils/backdropFocalDetector.mjs';
import {
  iterateConventions,
  resolveImage,
  imageHashFromMtimeMs,
  imageHashesFromResolved,
} from './image-conventions.mjs';

const logger = createCategoryLogger('tv-scanner');

// How deep `calculateDirectoryHash` recurses into each show directory.
// 2 catches "season folder added/removed" and "a file dropped at the show
// root or season root" — the cheapest depth that still detects the changes
// a sysadmin would expect to trigger a re-scan. Movie scanner uses the
// utility's default (5); TV defaults shallower because shows have far more
// nested content (per-episode subtitle files etc.) that doesn't warrant a
// scanner re-pass on its own. Override with `TV_DIR_HASH_MAX_DEPTH=N` if you
// want movie-style symmetry.
const TV_DIR_HASH_MAX_DEPTH = (() => {
  const raw = parseInt(process.env.TV_DIR_HASH_MAX_DEPTH ?? '2', 10);
  if (Number.isNaN(raw)) return 2;
  return Math.max(0, Math.min(5, raw));
})();

/**
 * Helper function to generate chapter files if they don't exist.
 * Writes the generated VTT content to disk (matching app.mjs pattern).
 * @param {string} chaptersPath - Path to chapters file
 * @param {string} mediaPath - Path to media file
 * @param {boolean} quietMode - Whether to suppress logging
 */
async function generateChapterFileIfNotExists(chaptersPath, mediaPath, quietMode = false) {
  if (!(await fileExists(chaptersPath))) {
    try {
      const chapterData = await chapterInfo(mediaPath);
      if (chapterData) {
        // Create the chapters directory if it doesn't exist
        await fs.mkdir(dirname(chaptersPath), { recursive: true });
        const chapterContent = await generateChapters(mediaPath, chapterData);
        await fs.writeFile(chaptersPath, chapterContent);
        if (!quietMode) {
          logger.info(`Generated chapter file: ${chaptersPath}`);
        }
      }
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
/**
 * Discover poster / backdrop / logo for a show, build their URLs + blurhash
 * refs, and flag any that are missing OR stale (older than `tmdb.config`).
 *
 * @param {Object} opts
 * @param {string} opts.showPath
 * @param {string} opts.showName - For structured logging only
 * @param {string} opts.encodedShowName
 * @param {string} opts.prefixPath
 * @param {string} opts.basePath
 * @param {Date|null} [opts.tmdbConfigLastModified=null] - mtime of the show's
 *   tmdb.config. An image with mtime < this counts as missing (the user has
 *   edited config since we last wrote the image). Pass null when the show
 *   has no tmdb.config.
 */
async function processShowAssets({
  showPath,
  showName,
  encodedShowName,
  prefixPath,
  basePath,
  fileSet = null,
  tmdbConfigLastModified = null,
}) {
  // Per-kind outputs. The frontend reads each from its dedicated DB column
  // (poster / posterBlurhash / logo / logoBlurhash / backdrop /
  // backdropBlurhash), so they must stay as discrete fields rather than
  // collapsing into a map.
  const outputs = {
    poster:   { url: '', blurhash: '' },
    backdrop: { url: '', blurhash: '' },
    logo:     { url: '', blurhash: '' },
  };

  // Per-kind resolveImage() results (file path + mtime + cache-bust hash). Fed
  // to the DB so *_file_path / *_hash come from the same stat that built the URL.
  const resolved = { poster: null, backdrop: null, logo: null };

  // Tracks whether any of poster / logo / backdrop are missing on disk.
  // Returned to the scanner as `missingImages` so it can apply a different
  // retry policy than the metadata-missing case (image downloads are
  // typically transient and should retry every scan tick).
  let missingImages = false;

  for (const [imageKey, convention] of iterateConventions('tv')) {
    const r = await resolveImage({ dirPath: showPath, fileSet, convention });
    if (!r) {
      missingImages = true;
      continue;
    }

    // Staleness: tmdb.config is newer than the image, meaning the user
    // edited config (or it was otherwise touched) since this image was
    // written. Treat as missing so the scanner gate triggers a refresh.
    // Mirrors the movie scanner's `checkTMDBImagesNeeded` behavior. Reuses
    // the resolver's single stat (`r.mtime`) — no extra syscall.
    if (tmdbConfigLastModified && tmdbConfigLastModified > r.mtime) {
      logger.info('scanner: tmdb.config newer than asset, marking missing', {
        'media.name': showName,
        'media.type': 'tv',
        'image.type': imageKey,
        'image.path': r.path,
      });
      missingImages = true;
      continue;
    }

    resolved[imageKey] = r;
    outputs[imageKey].url = `${prefixPath}/tv/${encodedShowName}/${r.fileName}?hash=${r.hash}`;
    // SVGs can't be encoded as raster blurhashes; everything else can.
    if (r.ext !== 'svg') {
      outputs[imageKey].blurhash = await getStoredBlurhash(r.path, basePath);
    }
  }

  return {
    poster:           outputs.poster.url,
    posterBlurhash:   outputs.poster.blurhash,
    logo:             outputs.logo.url,
    logoBlurhash:     outputs.logo.blurhash,
    backdrop:         outputs.backdrop.url,
    backdropBlurhash: outputs.backdrop.blurhash,
    missingImages,
    resolved,
  };
}

/**
 * Process show metadata
 * @param {string} showPath - Path to show directory
 * @param {string} encodedShowName - URL-encoded show name
 * @param {string} prefixPath - URL prefix path
 * @returns {Promise<Object>} Object containing metadata URL and content
 */
/**
 * Discover and load metadata.json for a show; flag it as missing if absent
 * OR stale (older than `tmdb.config`).
 *
 * @param {Object} opts
 * @param {string} opts.showPath
 * @param {string} opts.showName - For structured logging only
 * @param {string} opts.encodedShowName
 * @param {string} opts.prefixPath
 * @param {Date|null} [opts.tmdbConfigLastModified=null] - See processShowAssets.
 */
async function processShowMetadata({
  showPath,
  showName,
  encodedShowName,
  prefixPath,
  tmdbConfigLastModified = null,
}) {
  let metadataUrl = '';
  let metadata = '';
  // Returned to the scanner as `missingMetadata` so it can apply the 24h
  // cooldown to metadata-lookup failures while letting image failures
  // retry every tick.
  let missingMetadata = false;
  // True specifically when tmdb.config is newer than metadata.json (an id/config
  // edit), as opposed to a plain absent file. The scanner uses this to force a
  // full per-show refresh so seasons/episodes repull for the changed id — a
  // normal scan's existence/age gates would otherwise leave them on the old id.
  let staleByConfig = false;

  const metadataFilePath = join(showPath, 'metadata.json');
  const exists = await fileExists(metadataFilePath);

  if (!exists) {
    missingMetadata = true;
  } else if (tmdbConfigLastModified) {
    const mtime = await getLastModifiedTime(metadataFilePath);
    if (mtime && tmdbConfigLastModified > mtime) {
      logger.info('scanner: tmdb.config newer than metadata.json, marking missing', {
        'media.name': showName,
        'media.type': 'tv',
        'metadata.path': metadataFilePath,
      });
      missingMetadata = true;
      staleByConfig = true;
    }
  }

  // Read the existing metadata.json whenever the file is PRESENT — even when it's
  // flagged stale-by-config or the show is update-disabled. Only a genuinely
  // absent file leaves these empty. Otherwise the scanner persists a blank
  // metadata column (and a content-less show hash) for valid-but-frozen/stale
  // shows the generator won't (re)write — e.g. `update_metadata: false`.
  if (exists) {
    try {
      metadata = JSON.stringify(JSON.parse(await fs.readFile(metadataFilePath, 'utf8')));
      metadataUrl = `${prefixPath}/tv/${encodedShowName}/metadata.json`;
    } catch (err) {
      logger.warn('scanner: metadata.json present but unparseable, leaving metadata empty', {
        'media.name': showName,
        'media.type': 'tv',
        error: err.message,
      });
    }
  }

  return { metadataUrl, metadata, missingMetadata, staleByConfig };
}

/**
 * Process episode subtitles
 * @param {string} seasonPath - Path to season directory
 * @param {string} episode - Episode filename
 * @param {string} encodedShowName - URL-encoded show name
 * @param {string} encodedSeasonName - URL-encoded season name
 * @param {string} prefixPath - URL prefix path
 * @param {Object} langMap - Language code mapping
 * @param {string[]} seasonFiles - Pre-read directory listing for the season (avoids redundant readdir)
 * @returns {Promise<Object>} Subtitles object
 */
async function processEpisodeSubtitles(seasonPath, episode, encodedShowName, encodedSeasonName, prefixPath, langMap, seasonFiles) {
  const subtitles = {};
  const subtitleFiles = seasonFiles;
  
  for (const subtitleFile of subtitleFiles) {
    if (subtitleFile.startsWith(episode.replace('.mp4', '')) && subtitleFile.endsWith('.srt')) {
      const parsed = parseSubtitleFilename(subtitleFile, langMap);
      if (!parsed) continue;

      subtitles[parsed.subtitleKey] = {
        url: `${prefixPath}/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(subtitleFile)}`,
        srcLang: parsed.langCode,
        autoGenerated: parsed.isAutoGenerated,
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
 * @param {string[]} seasonFiles - Pre-read directory listing for the season
 * @returns {Promise<Object|null>} Episode data object or null if processing fails
 */
async function processEpisode(episode, seasonPath, showName, encodedShowName, encodedSeasonName, seasonNumber, prefixPath, basePath, langMap, seasonFiles) {
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
    const thumbnailImageHash = imageHashFromMtimeMs(thumbnailStats.mtimeMs);

    episodeData.thumbnail = `${prefixPath}/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(
      `${episodeNumber} - Thumbnail.jpg`
    )}?hash=${thumbnailImageHash}`;
    
    const blurhash = await getStoredBlurhash(thumbnailPath, basePath);
    if (blurhash) {
      episodeData.thumbnailBlurhash = blurhash;
    }
  }

  // Handle episode metadata. Append an mtime content-version token (same scheme
  // as the thumbnail above) so the URL changes when the episode metadata file
  // changes. This cache-busts the frontend's URL-keyed metadata fetch AND moves
  // the episode hash, which folds in episodeData.metadata (this URL string).
  const episodeMetadataPath = join(seasonPath, `${episodeNumber}_metadata.json`);
  if (await fileExists(episodeMetadataPath)) {
    const episodeMetadataStats = await fs.stat(episodeMetadataPath);
    const episodeMetadataHash = imageHashFromMtimeMs(episodeMetadataStats.mtimeMs);

    episodeData.metadata = `${prefixPath}/tv/${encodedShowName}/${encodedSeasonName}/${encodeURIComponent(
      `${episodeNumber}_metadata.json`
    )}?hash=${episodeMetadataHash}`;
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
    langMap,
    seasonFiles
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
    const seasonPosterImageHash = imageHashFromMtimeMs(seasonPosterStats.mtimeMs);

    seasonData.season_poster = `${prefixPath}/tv/${encodedShowName}/${encodedSeasonName}/season_poster.jpg?hash=${seasonPosterImageHash}`;
    
    const blurhash = await getStoredBlurhash(seasonPosterPath, basePath);
    if (blurhash) {
      seasonData.seasonPosterBlurhash = blurhash;
    }
  }

  // Process each episode (pass seasonFiles = episodes to avoid redundant readdir per episode)
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
      langMap,
      episodes
    );
    
    if (episodeResult) {
      seasonData.episodes[episodeResult.episodeKey] = episodeResult.episodeData;
      seasonData.lengths[episodeResult.episodeKey] = episodeResult.length;
      seasonData.dimensions[episodeResult.episodeKey] = episodeResult.dimensions;
    }
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

  // Lightweight hash lookup — avoids loading full show data with seasons/images
  const existingShowHashes = await getExistingTVShowHashes();
  const hashMap = new Map(existingShowHashes.map(s => [s.name, s.directory_hash]));
  const existingShowNames = new Set(existingShowHashes.map(s => s.name));

  // Bounded concurrency for season processing (moderate load — not unbounded)
  const seasonLimit = pLimit(3);

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

      // Detect whether the directory contents changed since last scan. This
      // was previously an unconditional `continue` that skipped EVERYTHING
      // when the hash matched — but that suppressed image-only retries when
      // the dir was unchanged. Now `dirHashChanged` is a gate signal (joined
      // with `missingImages` / `missingMetadata`), and the cheap fast-skip
      // moved to AFTER the gate is computed.
      const currentHash = await calculateDirectoryHash(showPath, TV_DIR_HASH_MAX_DEPTH);
      const storedHash = hashMap.get(showName);
      const dirHashChanged = !storedHash || storedHash !== currentHash;

      if (storedHash && dirHashChanged) {
        logger.info(`Directory hash changed for ${showName}, reprocessing.`);
      }

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

      // Show-level image discovery resolves against this in-memory listing (the
      // same readdir that drove `seasons`) — no extra syscall, and a single
      // shared snapshot so processShowAssets stops sweeping the directory itself.
      const showFileSet = new Set(allItems.map(item => item.name));

      // tmdb.config mtime drives the staleness check inside processShowAssets
      // / processShowMetadata. Compute it once per show; null when the file
      // doesn't exist (no overrides ever set), which makes the staleness
      // check a no-op for that show.
      const tmdbConfigPath = getTmdbConfigFilePath(showPath);
      const tmdbConfigLastModified = (await fileExists(tmdbConfigPath))
        ? await getLastModifiedTime(tmdbConfigPath)
        : null;

      // Process show assets (poster / logo / backdrop)
      const assetsResult = await processShowAssets({
        showPath,
        showName,
        encodedShowName,
        prefixPath,
        basePath,
        fileSet: showFileSet,
        tmdbConfigLastModified,
      });
      const missingImages = assetsResult.missingImages;

      // Process metadata. `let` because we adopt the post-generation result
      // below (the first read happens before the generator rewrites the file).
      let metadataResult = await processShowMetadata({
        showPath,
        showName,
        encodedShowName,
        prefixPath,
        tmdbConfigLastModified,
      });
      const missingMetadata = metadataResult.missingMetadata;

      // Compute the retry gate. The 24h cooldown (RETRY_INTERVAL_HOURS)
      // applies ONLY to the metadata-missing path — that represents a TMDB
      // *lookup* failure not worth fast-retrying. Image-download failures
      // bypass the cooldown because they're typically transient (image CDN
      // flake, network glitch). See
      // https://learn.microsoft.com/en-us/azure/architecture/best-practices/transient-faults
      const missingDataShow = missingDataMedia.find(media => media.name === showName);
      const metadataGateAllowsRetry =
        !missingDataShow ||
        ((now - new Date(missingDataShow.lastAttempt)) / (1000 * 60 * 60)) >= RETRY_INTERVAL_HOURS;

      let runDownloadTmdbImagesFlag =
        dirHashChanged ||
        missingImages ||
        (missingMetadata && metadataGateAllowsRetry);

      // Fast-skip: nothing changed on disk AND nothing's missing AND we
      // aren't due for a metadata-cooldown retry. Equivalent to the old
      // unconditional hash-skip, just applied AFTER the gate so the
      // image-only retry path isn't suppressed when the dir is unchanged.
      if (!runDownloadTmdbImagesFlag) {
        // Thin episodes on an otherwise-stable show still need re-checking — the
        // full-process path only runs the backfill when the show is reprocessed for
        // some other reason, which is exactly when it's least needed. Run it here
        // off the STORED seasons (no FS reprocess). The zero-I/O proxy keeps a
        // complete show to one read + an in-memory walk; the generator owns the
        // schema / air-date / cooldown decisions.
        let backfillWrote = 0;
        try {
          const tmdbId = metadataResult.metadata ? JSON.parse(metadataResult.metadata)?.id : null;
          if (tmdbId) {
            const dbShow = await getTVShowByName(showName);
            if (dbShow?.seasons) {
              // tmdb.config content isn't loaded on this branch (only its mtime,
              // above, for staleness) — load it here, scoped inside the tmdbId +
              // dbShow.seasons checks, so a fast-skipped show with no backfill
              // candidate never pays this extra read.
              const updateAllowed = isUpdateAllowed(await loadTmdbConfig(tmdbConfigPath));
              backfillWrote = (await backfillMissingEpisodes(showName, showPath, tmdbId, dbShow.seasons, new Date(), updateAllowed)) || 0;
            }
          }
        } catch (err) {
          logger.warn(`Episode backfill (fast-skip) failed for ${showName}: ${err.message}`);
        }

        if (!backfillWrote) {
          // Nothing rewritten → genuine fast-skip.
          if (isDebugMode) {
            logger.info(`No changes detected in ${showName}, skipping processing.`);
          }
          continue;
        }

        // The backfill rewrote >=1 episode file. Fall through to the normal
        // season-rebuild + saveTVShow + generateTVShowHashes below so the new
        // episode metadata + hash land THIS pass — the frontend then picks it up on
        // the next sync instead of waiting for a later scan to notice the changed
        // files via dirHashChanged. The TMDB image-download block is skipped (its
        // flag is still false); only the cheap rebuild + rehash runs. Fires only
        // when a fill-in actually landed (rare), so the extra work is bounded.
        logger.info(`scanner: backfill updated ${showName}, reprocessing inline to refresh hashes`, {
          'media.name': showName, 'media.type': 'tv', 'episodes.written': backfillWrote,
        });
      }

      // Download TMDB images if needed. The bypass log is emitted AFTER
      // the download attempt, conditional on actual work having happened
      // — items where TMDB has nothing to offer for the missing slot
      // become silent no-ops, which keeps the log channel clean for
      // genuine retry activity.
      if (runDownloadTmdbImagesFlag) {
        // Only persist a cooldown marker for the metadata-missing path.
        // Images-only retries don't flip this gate.
        if (missingMetadata) {
          await markMediaAsMissingData(showName);
        }
        // Pull the previously-managed file paths from the DB so the
        // reconcile step in MetadataGenerator can detect orphans (the path
        // we'd write now differs from the path we wrote last time). One
        // extra DB read per affected show — cheap, and only on gate trigger.
        // `getExistingTVShowHashes()` (used for the iteration) only carries
        // name+hash; we need the full row for the *FilePath columns.
        const existingShow = await getTVShowByName(showName);
        const previousPaths = existingShow ? {
          poster:   existingShow.posterFilePath || null,
          backdrop: existingShow.backdropFilePath || null,
          logo:     existingShow.logoFilePath || null,
        } : null;
        // A tmdb.config edit (id change) forces a full per-show refresh so the
        // generator bypasses the season-poster/thumbnail/episode-metadata
        // existence/age gates and repulls everything for the new id — a normal
        // scan only refreshes the show level. Self-limiting: after regeneration
        // metadata.json is newer than the config, so this won't re-fire.
        const downloadResult = await downloadTMDBImages({
          showName,
          previousPaths,
          fullScan: metadataResult.staleByConfig,
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
            'media.name': showName,
            'media.type': 'tv',
            imageSummary: summary
          });
        }

        // Retry fetching assets after download. Re-enumerate the show dir —
        // a re-pull may have written a new image (or changed its extension),
        // so the retry resolution must see the current contents. Pass the same
        // tmdbConfigLastModified — downloadMediaImages may have written fresh
        // images whose mtime is now newer than tmdb.config, but the threshold
        // itself hasn't moved.
        const retryItems = await fs.readdir(showPath, { withFileTypes: true });
        const retryFileSet = new Set(retryItems.map(item => item.name));
        const retryAssetsResult = await processShowAssets({
          showPath,
          showName,
          encodedShowName,
          prefixPath,
          basePath,
          fileSet: retryFileSet,
          tmdbConfigLastModified,
        });
        Object.assign(assetsResult, retryAssetsResult);

        // Conservative clear: only when BOTH metadata and images are now
        // present after the retry pass. Partial recovery leaves the marker
        // in place so the next tick can finish the job.
        const retryMetadataResult = await processShowMetadata({
          showPath,
          showName,
          encodedShowName,
          prefixPath,
          tmdbConfigLastModified,
        });
        if (!retryAssetsResult.missingImages && !retryMetadataResult.missingMetadata) {
          await clearMissingMediaData(showName);
        }

        // Adopt the post-generation metadata. The initial processShowMetadata
        // ran BEFORE the generator (re)wrote metadata.json — when tmdb.config
        // was newer it returned empty `metadata`. Persisting that empty value
        // would leave tv_shows.metadata blank, defeating the content-folded
        // show hash (it couldn't see the metadata change). retryMetadataResult
        // reflects the freshly-written file.
        metadataResult = retryMetadataResult;
      }

      // Process seasons with bounded concurrency
      const seasonsObj = {};
      await Promise.all(
        seasons.map(season => seasonLimit(async () => {
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
        }))
      );

      // Sort seasons
      const sortedSeasons = Object.fromEntries(
        Object.entries(seasonsObj).sort((a, b) => {
          const seasonA = a[0].match(/\d+/)?.[0].padStart(3, '0') || '000';
          const seasonB = b[0].match(/\d+/)?.[0].padStart(3, '0') || '000';
          return seasonA.localeCompare(seasonB);
        })
      );

      // File paths + cache-bust hashes come from the SAME resolve that built the
      // show-asset URLs (processShowAssets → resolveImage: one set lookup + one
      // stat per kind). URL filename, *_file_path, and *_hash cannot diverge.
      const posterFilePath = assetsResult.resolved.poster?.path ?? null;
      const logoFilePath = assetsResult.resolved.logo?.path ?? null;
      const backdropFilePath = assetsResult.resolved.backdrop?.path ?? null;
      const imageHashes = imageHashesFromResolved(assetsResult.resolved);

      // Calculate final directory hash after all processing (files may have been created).
      // Use the same depth as the initial check so the stored hash compares
      // apples-to-apples on the next scan.
      const finalHash = await calculateDirectoryHash(showPath, TV_DIR_HASH_MAX_DEPTH);

      // Load tmdb.config for manual focal override; auto-detect from backdrop.
      // tmdbConfigPath was already computed earlier for the staleness check
      // (top of the per-show iteration) — reuse it.
      const tmdbConfig = await loadTmdbConfig(tmdbConfigPath);
      const manualFocal = tmdbConfig.backdrop_focal ?? null;
      const backdropFocalSuggested = backdropFilePath ? await detectBackdropFocal(backdropFilePath) : null;

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
        basePath,
        finalHash,
        manualFocal,
        backdropFocalSuggested,
        imageHashes
      );

      // Immediately regenerate the metadata hash using the fresh data just saved.
      // The scheduled hash job filters by episode mtime and would miss changes where
      // only tmdb.config or images changed, so we generate here to avoid the gap.
      if (storedHash) {
        const freshShow = await getTVShowByName(showName);
        if (freshShow) {
          await generateTVShowHashes(db, freshShow);
        }
      }

      // Air-date-aware backfill of thin episode metadata. Runs AFTER finalHash
      // is stored, so any rewrite is picked up by the next scan's dirHashChanged
      // path (seasons JSON rebuilt → fresh URL token → episode hash moves → resync).
      try {
        const tmdbId = metadataResult.metadata ? JSON.parse(metadataResult.metadata)?.id : null;
        if (tmdbId) {
          // tmdbConfig is already loaded above (line 779, for backdrop_focal) —
          // reuse it, zero new I/O. Same update_metadata gate the generator
          // itself enforces in generateForShow.
          const updateAllowed = isUpdateAllowed(tmdbConfig);
          await backfillMissingEpisodes(showName, showPath, tmdbId, sortedSeasons, new Date(), updateAllowed);
        }
      } catch (err) {
        logger.warn(`Episode metadata backfill skipped for ${showName}: ${err.message}`);
      }
    }

    // Remove TV shows from the database that no longer exist in the file system
    for (const showName of existingShowNames) {
      await removeTVShow(showName);
    }
  } catch (error) {
    logger.error('Error during database update: ' + error);
  }
}

// ── Air-date-aware episode-metadata backfill ──────────────────────────────────
// An additive trigger (the age-based EPISODE_METADATA_REFRESH_DAYS refresh is
// untouched) that re-pulls thin per-episode metadata once it's likely available
// upstream. The scanner does only cheap, schema-free work here — a zero-I/O proxy
// to spot candidates and cooldown-table bookkeeping. ALL metadata-content /
// TMDB-schema / air-date decisions live in MetadataGenerator.refreshMissingEpisodes
// (scanner I/O contract). See plans/AIR_DATE_AWARE_EPISODE_BACKFILL.md.
//
// Respects the same update_metadata freeze as the rest of the pipeline (see
// isUpdateAllowed in generateForShow/generateForMovie): both call sites below
// pass it in, so a show frozen via tmdb.config gets zero backfill activity.

/**
 * End-of-scan hook: hand present-but-thin episodes to the generator for an
 * air-date-aware re-pull, then persist the per-episode cooldown from what it did.
 *
 * Performance: a fully-complete show does only an in-memory walk and returns
 * before any DB/FS work — the pre-filter `ep.metadata && !ep.thumbnail` lets
 * complete episodes (which have a downloaded thumbnail) fall through with zero
 * I/O. Scope: pure missing-file episodes (no per-episode JSON) are left to the
 * existing `dirHashChanged` generator path; this targets "file present but TMDB
 * was thin at fetch time".
 *
 * @param {string} showName
 * @param {string} showPath - absolute path to the show directory
 * @param {number} tmdbId
 * @param {Object} seasons  - the built sortedSeasons (seasonName -> seasonData)
 * @param {Date}   now
 * @param {boolean} [updateAllowed=false] - `isUpdateAllowed(tmdbConfig)` for this
 *   show, computed by the caller (which already owns tmdb.config I/O). Mirrors the
 *   gate MetadataGenerator.generateForShow/generateForMovie enforce for the rest of
 *   the TMDB pipeline — an operator-frozen show (`update_metadata:false`, e.g.
 *   after a bad auto-match) must not have episodes silently re-pulled via this
 *   side channel. Defaults to `false` (fail closed): a future call site that
 *   forgets to pass it gets no backfill rather than reproducing this bug.
 */
async function backfillMissingEpisodes(showName, showPath, tmdbId, seasons, now, updateAllowed = false) {
  if (!tmdbId || !updateAllowed) return 0;

  // 1. Zero-I/O pre-filter from presence flags already on episodeData.
  const candidates = [];
  for (const [seasonName, seasonData] of Object.entries(seasons || {})) {
    const seasonNumberMatch = seasonName.match(/\d+/);
    if (!seasonNumberMatch) continue; // non-numeric folder (e.g. "Specials") — skip
    const seasonNumber = parseInt(seasonNumberMatch[0], 10);
    const seasonPath = join(showPath, seasonName);
    for (const ep of Object.values(seasonData.episodes || {})) {
      if (ep.episodeNumber == null) continue;
      // Complete-looking (has file + thumbnail) or no file at all → skip, no I/O.
      if (!ep.metadata || ep.thumbnail) continue;
      candidates.push({ seasonNumber, episodeNumber: ep.episodeNumber, seasonPath });
    }
  }
  if (candidates.length === 0) return 0; // healthy show: nothing beyond the in-memory walk

  // 2. Annotate each candidate with its cooldown state (DB), then hand off — the
  //    generator owns the sparse check, air_date read, due-gate, and fetch.
  const rows = await getEpisodeRetryRows(showName);
  const lastAttemptOf = new Map(rows.map((r) => [`${r.seasonNumber}|${r.episodeNumber}`, r.lastAttempt]));
  for (const c of candidates) {
    c.lastAttempt = lastAttemptOf.get(`${c.seasonNumber}|${c.episodeNumber}`) ?? null;
  }

  const outcomes = await refreshMissingEpisodes(tmdbId, candidates, { now, showName });

  // 3. Persist the cooldown purely from the generator's outcomes (no schema here).
  //    A fresh WRITE (or an already-complete file) resolves the episode → clear any
  //    cooldown row so it doesn't linger forever. Only a fetch that came back still
  //    thin (or errored) stamps the cooldown to back off for EPISODE_MISSING_RETRY_DAYS.
  let written = 0, retried = 0;
  for (const o of outcomes) {
    if (o.written || o.resolved) {
      await clearEpisodeRetry(showName, o.seasonNumber, o.episodeNumber);
      if (o.written) written++;
    } else if (o.attempted) {
      await recordEpisodeAttempt(showName, o.seasonNumber, o.episodeNumber, o.airDate);
      retried++;
    }
  }
  if (written || retried) {
    logger.info('scanner: episode metadata backfill pass', {
      'media.name': showName, 'media.type': 'tv', written, retried,
    });
  }

  // Count of episodes (re)written this pass. The fast-skip caller uses this to
  // decide whether to reprocess the show inline (rebuild seasons + rehash) so a
  // fill-in reaches the frontend in one scan instead of two.
  return written;
}
