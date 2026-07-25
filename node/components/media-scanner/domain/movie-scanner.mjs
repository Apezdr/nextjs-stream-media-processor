import { promises as fs } from 'fs';
import { join, dirname, extname } from 'path';
import pLimit from 'p-limit';
import { createCategoryLogger } from '../../../lib/logger.mjs';
import {
  calculateDirectoryHash,
  fileExists,
  getLastModifiedTime,
  getStoredBlurhash,
  stripVideoExtension,
  VIDEO_EXTENSIONS,
  HASH_EXCLUDED_FILES
} from '../../../utils/utils.mjs';
import { isVideoFile } from '../../../utils/mediaResolution.mjs';
import { buildVideoSources, publishableSources } from './video-sources.mjs';
import { generateChapters } from '../../../chapter-generator.mjs';
import { chapterInfo } from '../../../ffmpeg/ffprobe.mjs';
import { parseSubtitleFilename } from './subtitle-filename.mjs';
import {
  resolveMediaIdentity,
  repointMediaIdentity,
  filenameFromUrl,
} from '../../../utils/mediaIdentity.mjs';
import { currentPayloadSignature } from '../../../lib/payloadVersion.mjs';
import {
  getExistingMovies,
  getMissingMediaData,
  recordMediaIdentity,
  saveMovie,
  removeMovie,
  markMediaAsMissingData,
  clearMissingMediaData,
  getDatabaseInstance,
  RETRY_INTERVAL_HOURS
} from '../data-access/scanner-repository.mjs';
import { generateMovieHashes, deleteHashesForMedia } from '../../../sqlite/metadataHashes.mjs';
import { getMovieByName } from '../../../sqliteDatabase.mjs';
import { loadTmdbConfig, isUpdateAllowed, hasMetadataOverrideKey } from '../../../utils/tmdbConfig.mjs';
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
 * Parse the stored `urls` column, which may be a JSON string or already an
 * object depending on which reader produced the row.
 */
function parseStoredUrls(urls) {
  if (!urls) return null;
  if (typeof urls !== 'string') return urls;
  try {
    return JSON.parse(urls);
  } catch {
    return null;
  }
}

/**
 * Helper function to generate chapter files if they don't exist.
 * Writes the generated VTT content to disk, mirroring the working TV helper
 * in tv-scanner.mjs (C-1 — this was historically a silent no-op: it passed
 * the quietMode boolean into generateChapters' chapterData parameter, which
 * short-circuited the probe and discarded the returned VTT string). Movies
 * without chapter atoms (chapterInfo → null) write nothing; the lazy
 * /chapters/movie/:movieName route remains the on-demand fallback.
 *
 * Ordering constraint (hard): scanMovies must call this (via processChapters)
 * BEFORE computing final_hash — calculateDirectoryHash recurses into
 * chapters/, so the stored hash must already include the new VTT or every
 * pregeneration would re-trigger dirHashChanged on the following tick.
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
 * Check if a movie needs info file regeneration
 * @param {Array<string>} files - List of files in directory
 * @param {string} dirPath - Directory path
 * @param {string} dirName - Directory name
 * @param {number} currentVersion - Current info file version
 * @returns {Promise<boolean>} True if regeneration is needed
 */
async function needsInfoRegeneration(files, dirPath, dirName, currentVersion) {
  // Safe to cover every container now, and ONLY now: this decides whether to
  // reprocess a movie, while processVideoFiles is what actually calls getInfo.
  // Widening this while that stayed .mp4-only would mean an .mkv with a missing
  // or stale sidecar returns true here, the movie is reprocessed, the .mkv is
  // skipped, the sidecar is still stale — and the folder reprocesses on every
  // scan tick forever. The two must move together, and in this commit they do.
  const videoFiles = files.filter(isVideoFile);

  for (const videoFile of videoFiles) {
    const filePath = join(dirPath, dirName, videoFile);
    const infoFile = `${filePath}.info`;

    if (await fileExists(infoFile)) {
      try {
        const fileInfo = await fs.readFile(infoFile, 'utf-8');
        const info = JSON.parse(fileInfo);

        if (!info.version || info.version < currentVersion) {
          logger.info(`Info file for ${videoFile} has outdated version (${info.version}), regeneration needed`);
          return true;
        }
      } catch (error) {
        logger.warn(`Error reading info file for ${videoFile}, regeneration needed: ${error}`);
        return true;
      }
    } else {
      logger.info(`Info file for ${videoFile} doesn't exist, regeneration needed`);
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
 * Process every video file in a movie folder and build its published URLs.
 *
 * Was .mp4-only, and the loop overwrote `urls.mp4` on each iteration, so a
 * multi-mp4 folder silently published the LAST file by readdir order and every
 * non-mp4 container was invisible. Now every supported container becomes a
 * source, and exactly one of them — the identity's pinned primary — publishes
 * as `urls.mp4`.
 *
 * `urls.mp4` keeps its legacy name for an mkv title. It is a LOCATOR, never a
 * container claim; see docs/jit-transcoder.md.
 *
 * @param {Array<string>} videoFiles - Ordered video basenames (listVideoFiles)
 * @param {string} dirPath - Movies root
 * @param {string} dirName - Movie directory name
 * @param {string} prefixPath - URL prefix path
 * @param {string|null} primaryFilename - Identity's pinned primary source
 * @returns {Promise<Object>}
 */
async function processVideoFiles(videoFiles, dirPath, dirName, prefixPath, primaryFilename = null) {
  const encodedDirName = encodeURIComponent(dirName);
  const dir = join(dirPath, dirName);

  const { sources, primary, fileLengths, fileDimensions } = await buildVideoSources({
    videoFiles,
    dir,
    urlFor: (filename) =>
      `${prefixPath}/movies/${encodedDirName}/${encodeURIComponent(filename)}`,
    primaryFilename,
    libraryRelativeDir: `movies/${dirName}`,
  });

  const urls = {};
  if (primary) {
    urls.mp4 = primary.url;
    // Written for EVERY container, not just mp4. getMoviesModifiedSince keys
    // the incremental hash sweep off this field, so an mkv-only movie without
    // it would be permanently invisible to that sweep — silently, with no error.
    if (primary.mediaLastModified) urls.mediaLastModified = primary.mediaLastModified;
    urls.sources = publishableSources(sources);
    // Emitted beside urls.mp4, per the frozen frontend contract. They describe
    // the PRIMARY source, which is exactly what urls.mp4 points at, so the two
    // can never disagree. Episodes carry the same pair flat beside videoURL —
    // each follows its own container's existing convention.
    urls.jitEligible = primary.jitEligible;
    if (primary.jitUrl) urls.jitUrl = primary.jitUrl;
  }

  const primaryInfo = primary?._info ?? null;

  return {
    fileLengths,
    fileDimensions,
    urls,
    // Title-level flag and URL describe the PRIMARY source, which is what
    // urls.mp4 points at — so the two always agree.
    jitEligible: primary?.jitEligible ?? false,
    jitUrl: primary?.jitUrl ?? null,
    // Row-level fields describe the PRIMARY source, matching what urls.mp4
    // points at. Per-source equivalents live in urls.sources[].
    hdrInfo: primaryInfo?.hdr,
    mediaQuality: primaryInfo?.mediaQuality,
    additionalMetadata: primaryInfo?.additionalMetadata,
    _id: primaryInfo?.uuid,
    primaryFilename: primary?.filename ?? null,
  };
}

/**
 * Process chapters for a movie.
 *
 * Was three separate .mp4 assumptions in four lines: it found the file by
 * suffix, stripped '.mp4' with a SUBSTRING replace (which would corrupt
 * "My.mp4.Movie.mkv"), then re-appended '.mp4' to rebuild the path. Now it
 * takes the already-resolved primary source's basename.
 *
 * @param {string} dirPath - Movies root
 * @param {string} dirName - Movie directory name
 * @param {string|null} primaryFilename - Primary source basename, with extension
 * @param {string} prefixPath - URL prefix path
 * @returns {Promise<string|null>} Chapters URL or null
 */
async function processChapters(dirPath, dirName, primaryFilename, prefixPath) {
  const encodedDirName = encodeURIComponent(dirName);
  if (!primaryFilename) return null;

  const baseFilename = stripVideoExtension(primaryFilename);
  const mediaPath = join(dirPath, dirName, primaryFilename);
  if (!(await fileExists(mediaPath))) return null;

  const chaptersPath = join(dirPath, dirName, 'chapters', `${dirName}_chapters.vtt`);
  const chaptersPath2 = join(dirPath, dirName, 'chapters', `${baseFilename}_chapters.vtt`);

  await generateChapterFileIfNotExists(chaptersPath, mediaPath, true);

  if (!await fileExists(chaptersPath)) {
    await generateChapterFileIfNotExists(chaptersPath2, mediaPath, true);
  }

  if (await fileExists(chaptersPath)) {
    return `${prefixPath}/movies/${encodedDirName}/chapters/${encodeURIComponent(`${dirName}_chapters.vtt`)}`;
  } else if (await fileExists(chaptersPath2)) {
    return `${prefixPath}/movies/${encodedDirName}/chapters/${encodeURIComponent(`${baseFilename}_chapters.vtt`)}`;
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

  // Bounded concurrency for movie processing (mirrors the season limiter in
  // tv-scanner.mjs). Each iteration can invoke ffprobe + mediainfo through
  // getInfo(); unbounded, a full-library pass spawns one subprocess pair per
  // movie simultaneously, which matters whenever a version/payload bump forces
  // every title to reprocess in a single tick.
  const movieLimit = pLimit(3);

  await Promise.all(
    dirs.map((dir, index) => movieLimit(async () => {
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
      // F-1 one-shot fingerprint backfill: a row written before the
      // movies.metadata column existed has metadata = NULL, and the
      // unchanged-directory early return below would otherwise keep it
      // content-blind until its directory happens to change. Skip the early
      // return ONCE for such rows (only when a metadata.json actually exists
      // to fingerprint — otherwise the column legitimately stays NULL and
      // this must not reprocess the movie every pass). Converges after one
      // pass: saveMovie's escape hatch persists the fingerprint, so
      // existingMovie.metadata is non-NULL on the next tick.
      let needMetadataBackfill = false;
      // A payload-shape change (new field, or the JIT toggle flipping) alters
      // nothing on disk, so directory_hash cannot see it and this early return
      // would skip the movie forever. Converges in exactly one pass: the upsert
      // stores the new signature, so the next tick compares equal.
      const payloadSignature = currentPayloadSignature();
      const needPayloadRefresh =
        existingMovie && existingMovie.payload_signature !== payloadSignature;
      if (!dirHashChanged && existingMovie) {
        needInfoRegeneration = await needsInfoRegeneration(files, dirPath, dirName, currentVersion);
        needMetadataBackfill =
          existingMovie.metadata == null && files.includes('metadata.json');

        if (!needInfoRegeneration && !needMetadataBackfill && !needPayloadRefresh) {
          if (isDebugMode) {
            logger.info(`No changes detected in ${dirName}, skipping processing.`);
          }
          return;
        } else if (needPayloadRefresh) {
          logger.info(
            `media pivot: reprocessing ${dirName} for payload signature ` +
            `${existingMovie.payload_signature ?? 'none'} -> ${payloadSignature}`
          );
        } else if (needInfoRegeneration) {
          logger.info(`Processing ${dirName} to update info files`);
        } else {
          logger.info(`Processing ${dirName} to backfill its metadata fingerprint (F-1, one-shot)`);
        }
      }

      logger.info(`Directory Hash invalidated for, ${dirName}`);

      const fileSet = new Set(files);
      // Video files, ordered by container priority then name. This is the
      // upstream gate: fixing the emitters without fixing this changes nothing,
      // because a non-mp4 never reached them.
      const videoFiles = files
        .filter(isVideoFile)
        .sort((a, b) => {
          const rank =
            VIDEO_EXTENSIONS.indexOf(extname(a).toLowerCase()) -
            VIDEO_EXTENSIONS.indexOf(extname(b).toLowerCase());
          return rank !== 0 ? rank : a.localeCompare(b);
        });

      const fileNames = files.filter(file =>
        // The identity sidecar is our own bookkeeping, not library content. It
        // matches the .json arm below, so without this it would be published in
        // file_names and folded into the movie hash.
        !HASH_EXCLUDED_FILES.has(file) && (
        isVideoFile(file) ||
        file.endsWith('.srt') ||
        file.endsWith('.json') ||
        file.endsWith('.info') ||
        file.endsWith('.nfo') ||
        file.endsWith('.jpg') ||
        file.endsWith('.png'))
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
      // Presence-based opt-in (G-2): a present `metadata` key — even `{}` —
      // means "override-managed"; only an absent key closes the frozen
      // branch of the metadata gate below.
      const hasOverrides = hasMetadataOverrideKey(tmdbConfig);
      let _id = tmdbConfig.tmdb_id ? `tmdb_${tmdbConfig.tmdb_id}` : null;
      const manualFocal = tmdbConfig.backdrop_focal ?? null;

      // Classify which TMDB-derived files (if any) are missing/stale.
      const { missingMetadata, missingImages, staleByConfig } = await checkTMDBImagesNeeded(
        fileSet,
        dirPath,
        dirName,
        tmdbConfigLastModified
      );

      // Identity is resolved BEFORE the sources are built, because its pinned
      // primarySource decides which of them publishes as urls.mp4.
      //
      // primarySource is seeded from the row's ALREADY-STORED url and never
      // recomputed: the old processVideoFiles picked the LAST .mp4 in a
      // multi-mp4 folder (its loop overwrote), while priority-order selection
      // picks the FIRST. Recomputing would silently repoint those titles'
      // published URL — and the frontend still derives watch-history identity
      // from that URL until its cutover lands.
      const storedUrls = parseStoredUrls(existingMovie?.urls);
      const libraryRelativePath = `movies/${dirName}`;
      const identity = await resolveMediaIdentity({
        dir: fullDirPath,
        libraryRelativePath,
        primarySourceHint: filenameFromUrl(storedUrls?.mp4),
      });
      let mediaId = identity.id;

      const claim = await recordMediaIdentity(db, {
        mediaId,
        mediaType: 'movie',
        mediaName: dirName,
      });
      if (claim.conflict) {
        // Another folder already owns this id — almost always a copied folder
        // that brought a cloned sidecar. Re-derive from THIS folder's path,
        // which is unique by construction, and record the displaced id in
        // previousIds so the change stays auditable.
        mediaId = await repointMediaIdentity({ dir: fullDirPath, libraryRelativePath });
        await recordMediaIdentity(db, { mediaId, mediaType: 'movie', mediaName: dirName });
        logger.warn(`identity repointed for ${libraryRelativePath}: ${identity.id} -> ${mediaId}`);
      }

      // Process video files — every supported container becomes a source, and
      // the identity's pinned primary is the one that publishes as urls.mp4.
      const videoData = await processVideoFiles(
        videoFiles,
        dirPath,
        dirName,
        prefixPath,
        identity.primarySource
      );
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

      // Raw pre-override TMDB payload (G-5), carried opaquely from the
      // generator's result to saveMovie. Stays null when no download ran or
      // when the generator performed no genuine fetch (frozen / up-to-date /
      // error) — the upsert then preserves the previously stored value.
      let pristineMetadata = null;

      // Per-kind image source-URL provenance updates (I-3), carried opaquely
      // from the generator's result to saveMovie. Null (whole object or per
      // kind) means "no new information" — the upsert COALESCE-preserves the
      // stored value per column.
      let sourceUrls = null;

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
        // Stored download provenance for the reconcile step's
        // stale-by-source-url check (I-3). NULL per kind = "unknown"
        // (pre-I-3 row) — the generator skips the comparison and adopts.
        const previousSourceUrls = existingMovie ? {
          poster:   existingMovie.poster_source_url || null,
          backdrop: existingMovie.backdrop_source_url || null,
          logo:     existingMovie.logo_source_url || null,
        } : null;
        // A tmdb.config edit (id change) forces a forceRefresh repull so the
        // generator wipes the previous id's images first, then re-downloads —
        // otherwise the downloader's existence check would leave the old id's
        // art on disk. Symmetric with the TV path's `fullScan: metadataResult.staleByConfig`.
        const downloadResult = await downloadTMDBImages({
          movieName: dirName,
          previousPaths,
          previousSourceUrls,
          fullScan: staleByConfig,
        });

        // Opaque pass-through (§4.1): the scanner never parses this payload —
        // schema awareness stays in MetadataGenerator. Non-null only when the
        // generator's genuine-fetch branch ran this invocation.
        pristineMetadata = downloadResult?.pristineMetadata ?? null;

        // Opaque pass-through too (I-3): per-kind download provenance the
        // generator decided this invocation. The scanner never inspects the
        // URLs.
        sourceUrls = downloadResult?.sourceUrls ?? null;

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
      const chaptersUrl = await processChapters(dirPath, dirName, videoData.primaryFilename, prefixPath);
      if (chaptersUrl) {
        urls.chapters = chaptersUrl;
      }

      // Calculate final hash
      const final_hash = await calculateDirectoryHash(fullDirPath);

      // Metadata content fingerprint (F-1). THE CANONICAL SERIALIZATION LIVES
      // HERE: compact `JSON.stringify(JSON.parse(file))`, mirroring how
      // tv-scanner.mjs (processShowMetadata) serializes tv_shows.metadata.
      // Runs on EVERY pass that reaches saveMovie — not just dirHashChanged —
      // so movies.metadata always reflects the current on-disk metadata.json
      // (read AFTER the download block, which may have rewritten the file).
      //
      // Oscillation constraint (hard): this exact string is persisted into
      // movies.metadata, and BOTH movie-hash writers consume that column
      // verbatim — the inline rehash below via getMovieByName() and the
      // scheduled updateAllMovieHashes() sweep via getMovies(). Byte-identical
      // input for the same on-disk state, so the two writers cannot flip the
      // stored hash back and forth.
      //
      // Fallback chain: serialized JSON > serialized {mtime,size} marker >
      // null. The marker keeps the hash advancing if the file exists but
      // can't be parsed (rare, but better than the hash silently freezing).
      // The parse is canonicalization only — the scanner stays TMDB-schema-
      // blind (§4.1) and never reads fields out of it.
      const movieMetadataPath = join(dirPath, dirName, 'metadata.json');
      let metadataFingerprint = null;
      try {
        metadataFingerprint = JSON.stringify(JSON.parse(await fs.readFile(movieMetadataPath, 'utf8')));
      } catch (readErr) {
        try {
          const st = await fs.stat(movieMetadataPath);
          metadataFingerprint = JSON.stringify({ _stat: { mtimeMs: st.mtimeMs, size: st.size } });
        } catch {
          // file doesn't exist at all — leave as null
        }
      }

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
        imageHashes,
        metadataFingerprint,
        pristineMetadata,
        sourceUrls,
        mediaId
      );

      // Immediately regenerate the metadata hash using the fresh data just saved.
      // The scheduled hash job filters by mp4 mtime and would miss changes where
      // only tmdb.config or images changed, so we generate here to avoid the gap.
      //
      // Mirrors the TV scanner: save first, then re-read the row through the
      // SAME read-side accessor family the scheduled sweep uses (getMovieByName
      // here, getMovies in updateAllMovieHashes — identical row decoration) and
      // hash THAT. Hashing the DB view instead of the scanner's in-memory
      // objects guarantees both writers fold byte-identical input — including
      // the movies.metadata fingerprint persisted just above — for the same
      // on-disk state, so the stored hash can't oscillate between them.
      //
      // Expected one-time effect: a title whose stored hash was last written
      // by the previously content-blind sweep (which hashed
      // `metadata: undefined`) gets a corrected content-aware hash on its
      // first pass through either writer, and the frontend re-syncs it once.
      // That is the F-1 bug being fixed, not a regression.
      //
      // Every pass that reaches this point either inserted or rewrote the row
      // (the early return above filters out everything else), so ALWAYS
      // refresh the stored hash — including a brand-new movie's FIRST hash
      // (F-2, shipped in Branch 4): the old gate skipped fresh INSERTs, so a
      // new title was invisible to the bulk sync endpoint until the sweep's
      // 16-minute mtime window or a per-title GET happened to catch it.
      const freshMovie = await getMovieByName(dirName);
      if (freshMovie) {
        await generateMovieHashes(db, freshMovie);
      }
    }))
  );

  // Remove movies from the database that no longer exist in the file system.
  // Cascade (R-4 + F-3, Branch 5): clear the cooldown row and the stored
  // metadata hash too — a same-named movie re-added later must start clean,
  // not inherit its predecessor's retry timestamp or serve its frozen hash.
  for (const movieName of existingMovieNames) {
    await removeMovie(movieName);
    await clearMissingMediaData(movieName);
    await deleteHashesForMedia(db, 'movies', movieName);
  }
}
