import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { createCategoryLogger } from './logger.mjs';
import {
  loadTmdbConfig,
  updateTmdbConfigWithId,
  isUpdateAllowed,
  applyMetadataOverrides,
  getMetadataOverrides
} from '../utils/tmdbConfig.mjs';
import {
  readMetadataFile,
  writeMetadataFile,
  shouldRefreshMetadata,
  getDirectories,
  getMetadataFilePath,
  getTmdbConfigFilePath,
  getEpisodeMetadataPath,
  pathExists,
  getFileAgeDays
} from '../utils/fileUtils.mjs';
import { getLastModifiedTime } from '../utils/utils.mjs';
import {
  downloadMediaImages,
  downloadSeasonPoster,
  downloadEpisodeThumbnail
} from '../utils/imageDownloader.mjs';
import {
  fetchComprehensiveMediaDetails,
  getEpisodeDetails,
  makeTmdbRequest,
  TmdbNoMatchError
} from '../utils/tmdb.mjs';
import {
  iterateConventions,
  expectedImagePathFromUrl,
  resolveEffectiveImageUrl,
} from '../components/media-scanner/domain/image-conventions.mjs';

const logger = createCategoryLogger('metadata-generator');
const episode_metadata_refresh_days = parseInt(process.env.EPISODE_METADATA_REFRESH_DAYS) || 4;

// Air-date-aware episode-metadata backfill cadence — the additive "thin episode"
// trigger, distinct from the age-based refresh above. A thin episode is re-checked
// against TMDB at most once per RETRY_DAYS, and only while within WINDOW_DAYS of its
// air date; after that the age-based refresh owns it. The scanner identifies
// candidates cheaply (presence flags) and persists the cooldown, but ALL schema +
// file-content + air-date decisions live here. See plans/AIR_DATE_AWARE_EPISODE_BACKFILL.md.
const EPISODE_MISSING_RETRY_DAYS = parseInt(process.env.EPISODE_MISSING_RETRY_DAYS) || 3;
// 90-day give-up window: TMDB sometimes corrects/fills an episode (title, overview,
// still) well after broadcast, so the reach extends past the typical few weeks.
const EPISODE_MISSING_WINDOW_DAYS = parseInt(process.env.EPISODE_MISSING_WINDOW_DAYS) || 90;

/** Thin when name, overview, or still_path is absent (locked definition). */
function isEpisodeMetadataSparse(data) {
  return !data || !data.name || !data.overview || !data.still_path;
}

/**
 * Should we (re)attempt a TMDB pull for this episode now?
 *  - air_date must be known (TBA episodes wait — no benefit polling blind)
 *  - within the give-up window (after which the age-based refresh owns it)
 *  - past the per-episode cooldown
 */
function isEpisodeBackfillDue({ airDate, lastAttempt, now }) {
  if (!airDate) return false;
  const air = new Date(airDate);
  if (isNaN(air.getTime())) return false;
  const daysBetween = (a, b) => (a - b) / 86400000;
  if (now < air) return false;
  if (daysBetween(now, air) > EPISODE_MISSING_WINDOW_DAYS) return false;
  if (lastAttempt && daysBetween(now, new Date(lastAttempt)) < EPISODE_MISSING_RETRY_DAYS) return false;
  return true;
}

/**
 * Generator-result reason strings for the frozen (`update_metadata: false`)
 * outcomes. These are the generator's return contract with the scanners: the
 * scanners' post-attempt cooldown bookkeeping branches on them via
 * `isFrozenReason()` below, so they must only ever change in lockstep with it.
 */
export const REASON_UPDATES_DISABLED = 'updates-disabled';
export const REASON_UPDATES_DISABLED_OVERRIDES_APPLIED = 'updates-disabled-overrides-applied';

/**
 * Did this generator result mean "the title is frozen" (paused by the
 * operator) rather than "the attempt failed"? Single source of truth for the
 * scanners — do not string-compare the reason values elsewhere.
 *
 * @param {string|null|undefined} reason - `result.reason` from
 *   `generateForShow()` / `generateForMovie()`
 * @returns {boolean}
 */
export function isFrozenReason(reason) {
  return reason === REASON_UPDATES_DISABLED ||
         reason === REASON_UPDATES_DISABLED_OVERRIDES_APPLIED;
}

/**
 * Past the give-up window (air_date known and more than
 * EPISODE_MISSING_WINDOW_DAYS ago)? Once true it stays true — the backfill
 * will never fire again for this episode (the age-based refresh owns it), so
 * the scanner should prune its cooldown row rather than orphan it.
 */
function isEpisodeBackfillExpired({ airDate, now }) {
  if (!airDate) return false;
  const air = new Date(airDate);
  if (isNaN(air.getTime())) return false;
  return (now - air) / 86400000 > EPISODE_MISSING_WINDOW_DAYS;
}

/**
 * Reconcile mode for `_reconcileImageOwnership`.
 *
 *  - `off`      — disable reconcile entirely. The scanner-driven `pathExists`
 *                 short-circuit in `downloadMediaImages` remains, so stale
 *                 images won't refresh.
 *  - `dry-run`  — log every "would delete" decision but do NOT touch the
 *                 filesystem. Used as the first-deploy default so an operator
 *                 can audit the SigNoz logs before flipping to `enforce`.
 *  - `enforce`  — actually `fs.unlink` the orphan / stale files before the
 *                 downloader runs. The real fix for the stale-image bug.
 *
 * Defaults to `dry-run`. Override via the `SCANNER_RECONCILE_MODE` env var.
 * Unknown values fall back to `dry-run`.
 */
const RECONCILE_MODE = (() => {
  const raw = (process.env.SCANNER_RECONCILE_MODE ?? 'dry-run').toLowerCase();
  return ['off', 'dry-run', 'enforce'].includes(raw) ? raw : 'dry-run';
})();

/**
 * Reduce results from the image downloader into a counts-by-outcome summary
 * so callers can log "downloaded N, cache-hit M, failed K" succinctly.
 *
 * Accepts mixed shapes from different layers of the downloader:
 *  - An object whose values are `{ outcome: 'downloaded'|... }` (top-level
 *    `imageResults` returned by downloadMediaImages).
 *  - An array of `{ outcome }` objects.
 *  - An array of bare outcome strings (season-poster / episode-thumbnail
 *    roll-ups pass strings directly, not wrapper objects).
 */
function summarizeImageResults(...sources) {
  const summary = {};
  const bump = (outcome) => {
    if (!outcome) return;
    summary[outcome] = (summary[outcome] || 0) + 1;
  };
  const pick = (item) => (typeof item === 'string' ? item : item?.outcome);
  for (const source of sources) {
    if (!source) continue;
    if (Array.isArray(source)) {
      for (const item of source) bump(pick(item));
    } else if (typeof source === 'object') {
      for (const item of Object.values(source)) bump(pick(item));
    }
  }
  return summary;
}

/**
 * MetadataGenerator - Main orchestrator for generating metadata files
 * Follows Node.js best practices with explicit initialization and business logic separation
 */
export class MetadataGenerator {
  constructor(config) {
    this.config = config;
    this.transactionId = randomUUID();
    this.logger = createCategoryLogger('metadata-generator');
    
    // Debug: one instance is created per scanner-triggered invocation, so at
    // info this line is pure per-invocation noise.
    this.logger.debug('MetadataGenerator initialized', {
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
   * Honor the `RECONCILE_MODE` env when deleting a system-owned image file.
   * `off` is a no-op; `dry-run` logs and skips the unlink; `enforce` performs
   * the unlink. Also removes the sibling `<path>.blurhash` file on enforce so
   * a re-download regenerates it cleanly.
   *
   * ENOENT is swallowed silently (idempotent — re-running the orphan branch
   * after a previous successful delete is harmless).
   *
   * @private
   */
  async _safeUnlinkOwned(filePath, reason, logFields = {}) {
    if (RECONCILE_MODE === 'off') return;

    const baseFields = {
      'reconcile.reason': reason,
      'reconcile.mode': RECONCILE_MODE,
      'reconcile.path': filePath,
      ...logFields,
    };

    if (RECONCILE_MODE === 'dry-run') {
      this.logger.info(`reconcile: would delete (${reason}, dry-run)`, baseFields);
      return;
    }

    // enforce
    try {
      await fs.unlink(filePath);
      this.logger.info(`reconcile: deleted (${reason})`, baseFields);
      // Best-effort cleanup of the sidecar blurhash file. Silent on ENOENT
      // (usually there isn't one); warn on anything else (EPERM / EBUSY /
      // EACCES) so an orphaned blurhash doesn't sit silently next to the
      // newly-downloaded image.
      const sidecar = `${filePath}.blurhash`;
      try {
        await fs.unlink(sidecar);
      } catch (sidecarError) {
        if (sidecarError.code !== 'ENOENT') {
          this.logger.warn(
            `reconcile: sidecar blurhash unlink failed for ${sidecar}: ${sidecarError.message}`,
            baseFields
          );
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn(`reconcile: unlink failed for ${filePath}: ${error.message}`, baseFields);
      }
    }
  }

  /**
   * Unconditionally delete a managed image file (and its `.blurhash` sidecar)
   * as part of a forceRefresh repull. Unlike `_safeUnlinkOwned`, this is NOT
   * gated by `SCANNER_RECONCILE_MODE` — a forceRefresh is explicit operator
   * intent (a tmdb.config id change or `/rescan/tmdb`), so a stale image the
   * new entity no longer provides must be cleared regardless of the cautious
   * reconcile default (dry-run). ENOENT-safe / idempotent.
   * @private
   */
  async _forceWipeImage(filePath, logFields = {}) {
    for (const target of [filePath, `${filePath}.blurhash`]) {
      try {
        await fs.unlink(target);
        if (target === filePath) {
          this.logger.info('forceRefresh: wiped managed image for clean repull', {
            'image.path': filePath,
            ...logFields,
          });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.logger.warn(`forceRefresh: unlink failed for ${target}: ${error.message}`, logFields);
        }
      }
    }
  }

  /**
   * On a forceRefresh, wipe the show/movie-level managed images (poster,
   * backdrop, logo — every accepted extension) so the subsequent download
   * re-creates ONLY the slots the new entity actually has. Slots the new
   * entity lacks are left absent rather than serving the previous id's art.
   * Custom art set via `override_<key>` survives: it lives in enhancedMetadata
   * and is re-fetched after the wipe.
   * @private
   */
  async _wipeManagedImagesForForceRefresh(mediaDir, mediaType, mediaName, transactionId) {
    for (const [imageKey, convention] of iterateConventions(mediaType)) {
      for (const ext of convention.extensions) {
        await this._forceWipeImage(path.join(mediaDir, `${convention.prefix}.${ext}`), {
          'media.name': mediaName,
          'media.type': mediaType,
          'image.type': imageKey,
          transactionId,
        });
      }
    }
  }

  /**
   * Reconcile on-disk image ownership against the current effective URL
   * before `downloadMediaImages` runs. Implements the dual-trigger model
   * the user signed off on: orphan cleanup when the previous DB-tracked
   * file path differs from what we'd write now, plus stale refresh when
   * the current target exists but was written before the most recent
   * `tmdb.config` edit.
   *
   * Files whose name+ext don't match the current expected target are NOT
   * touched — they're either user-placed manual files or leftovers from a
   * previous URL that the user can clean up manually. ("Manual files
   * preserved forever" rule.)
   *
   * Closes the bug where the scanner correctly flags images as stale but
   * `downloadMediaImages` skips the re-fetch because `pathExists(destPath)`
   * returns true. Reconcile deletes the file first so the downloader has
   * to re-fetch.
   *
   * @private
   * @param {Object} opts
   * @param {string} opts.mediaName
   * @param {string} opts.mediaDir          - Directory the images live in
   * @param {'movie'|'tv'} opts.mediaType
   * @param {Object} opts.tmdbConfig
   * @param {Object} opts.enhancedMetadata  - metadata.json with overrides applied
   * @param {Object|null} opts.previousPaths - { poster, backdrop, logo } from DB (null on first scan)
   * @param {Date|null} opts.tmdbConfigLastModified
   * @param {string} opts.transactionId
   */
  async _reconcileImageOwnership({
    mediaName,
    mediaDir,
    mediaType,
    tmdbConfig,
    enhancedMetadata,
    previousPaths,
    tmdbConfigLastModified,
    transactionId,
  }) {
    for (const [imageKey, convention] of iterateConventions(mediaType)) {
      // Effective URL via the shared resolver (I-5): override wins, then the
      // (override-merged) TMDB metadata value; bare TMDB paths get the CDN
      // base, full URLs pass through (I-7a). Same function the downloader
      // uses, so the predicted destination below matches what it writes.
      const effectiveUrl = resolveEffectiveImageUrl({ tmdbConfig, metadata: enhancedMetadata, imageKey });

      const previousPath = previousPaths?.[imageKey] || null;

      if (!effectiveUrl) {
        // TMDB dropped this asset AND no override exists. Sysadmin rule:
        // keep what was previously approved (manual files preserved
        // forever). Log it for visibility.
        if (previousPath) {
          this.logger.info(`reconcile: asset URL no longer present, preserving previous file`, {
            'media.name': mediaName,
            'media.type': mediaType,
            'image.type': imageKey,
            'reconcile.previous_path': previousPath,
            transactionId,
          });
        }
        continue;
      }

      const expectedPath = expectedImagePathFromUrl(mediaDir, convention.prefix, effectiveUrl);

      // 1) Orphan cleanup: previously-managed file is at a path we wouldn't
      //    produce now (e.g. override URL extension changed). Delete it.
      //    The downloader will then write the new expected_path.
      if (previousPath && previousPath !== expectedPath) {
        await this._safeUnlinkOwned(previousPath, 'orphan', {
          'media.name': mediaName,
          'media.type': mediaType,
          'image.type': imageKey,
          'reconcile.expected_path': expectedPath,
          transactionId,
        });
      }

      // 2) Stale refresh: the EXISTING DB-tracked file (which happens to
      //    match what we'd write now) was last written BEFORE the most
      //    recent tmdb.config edit. Delete it; the downloader will fetch a
      //    fresh copy with the same name.
      //
      //    Strict ownership check (`previousPath === expectedPath`) — without
      //    it, a user manually placing a file at the canonical name (e.g.
      //    `poster.jpg`) would have their file deleted on the next tmdb.config
      //    edit even though we never wrote it. With it, we only touch files
      //    we tracked in the DB ourselves. First-scan items (no DB row)
      //    naturally fall through this branch.
      if (
        previousPath &&
        previousPath === expectedPath &&
        tmdbConfigLastModified &&
        await pathExists(expectedPath)
      ) {
        const fileMtime = await getLastModifiedTime(expectedPath);
        if (fileMtime && tmdbConfigLastModified > fileMtime) {
          await this._safeUnlinkOwned(expectedPath, 'stale', {
            'media.name': mediaName,
            'media.type': mediaType,
            'image.type': imageKey,
            'reconcile.config_mtime': tmdbConfigLastModified.toISOString(),
            'reconcile.file_mtime': fileMtime.toISOString(),
            transactionId,
          });
        }
      }
    }
  }

  /**
   * Re-check on-disk image presence when metadata.json is already fresh.
   *
   * Loads the existing metadata.json and applies tmdb.config overrides, then
   * runs `downloadMediaImages` which internally short-circuits on
   * `pathExists(destPath)` — so any image already on disk is left alone and
   * only the missing ones are fetched.
   *
   * Closes a regression in the Python→Node migration where a failed
   * top-level image download wouldn't be retried until the metadata.json's
   * 24h refresh window expired, because both metadata and image downloads
   * were gated behind the same `shouldRefreshMetadata` check.
   *
   * @returns {Promise<Object|null>} Image results map, or null if metadata.json
   *   couldn't be loaded (in which case the caller falls through to the
   *   regular refresh path or skips).
   */
  async _downloadImagesIfMissing({
    mediaName,
    mediaDir,
    mediaType,
    tmdbConfig,
    transactionId,
    previousPaths = null,
  }) {
    try {
      const metadataPath = getMetadataFilePath(mediaDir);
      const existingMetadata = await readMetadataFile(metadataPath);
      if (!existingMetadata) {
        // shouldRefreshMetadata said the metadata was fresh, but the file is
        // gone — race condition. Skip silently; the next scan tick will hit
        // the refresh path because shouldRefreshMetadata will then return true.
        return null;
      }

      const enhancedMetadata = applyMetadataOverrides(existingMetadata, tmdbConfig);

      // Reconcile FIRST: delete orphans (URL filename changed) and stale
      // files (config edited since file was written) so the downloader
      // re-fetches them instead of hitting its `pathExists` short-circuit.
      // Cheap when nothing needs reconciling.
      const tmdbConfigPath = getTmdbConfigFilePath(mediaDir);
      const tmdbConfigLastModified = (await pathExists(tmdbConfigPath))
        ? await getLastModifiedTime(tmdbConfigPath)
        : null;
      await this._reconcileImageOwnership({
        mediaName,
        mediaDir,
        mediaType,
        tmdbConfig,
        enhancedMetadata,
        previousPaths,
        tmdbConfigLastModified,
        transactionId,
      });

      return await downloadMediaImages(
        enhancedMetadata,
        mediaDir,
        tmdbConfig,
        mediaType,
        {
          // forceDownload:false is critical — downloadMediaImages already
          // skips images that exist on disk, so this becomes a cheap "fill
          // in only what's missing" operation. The reconcile step above is
          // what actually deletes stale files so the downloader CAN refresh.
          forceDownload: false,
          generateBlurhash: this.config.generateBlurhash,
          mediaName,
        }
      );
    } catch (error) {
      this.logger.warn(`Image-only refresh skipped for ${mediaName}: ${error.message}`, {
        transactionId,
        'media.name': mediaName,
        'media.type': mediaType,
      });
      return null;
    }
  }

  /**
   * When `update_metadata` is disabled, TMDB fetches/writes are frozen — but an
   * operator's explicit `tmdb.config.metadata` overrides are still honored:
   * setting them is the operator's own instruction, not the TMDB-sourced churn
   * the freeze is meant to stop. Merges the overrides onto whatever
   * metadata.json already has (or `{}` if none exists yet — e.g. a title with
   * no real TMDB match at all) and writes back ONLY if that actually changes
   * something, so repeated scan ticks stay idempotent. Never touches images,
   * seasons, or TMDB — a pure local read/merge/write.
   * @private
   * @param {string} metadataPath
   * @param {Object} tmdbConfig
   * @returns {Promise<{applied: boolean}>} `applied: true` iff a write happened.
   */
  async _applyOverridesWhileFrozen(metadataPath, tmdbConfig) {
    const overrides = getMetadataOverrides(tmdbConfig);
    if (!overrides) return { applied: false };

    const existing = (await readMetadataFile(metadataPath)) || {};
    const merged = applyMetadataOverrides(existing, tmdbConfig);
    if (JSON.stringify(merged) === JSON.stringify(existing)) return { applied: false };

    await writeMetadataFile(metadataPath, merged);
    return { applied: true };
  }

  /**
   * Generate metadata for a TV show
   * Matches Python script's process_show functionality
   * @param {string} showName - Name of the TV show directory
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generation results
   */
  async generateForShow(showName, options = {}) {
    const { previousPaths = null } = options;
    const transactionId = randomUUID();
    // Debug: the invocation may turn out to be a frozen no-op; real work is
    // announced by the info-level completion log below.
    this.logger.debug('Starting show metadata generation', {
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
        const { applied } = await this._applyOverridesWhileFrozen(metadataPath, tmdbConfig);
        if (applied) {
          this.logger.info(`Applied manual metadata overrides while updates disabled: ${showName}`, { transactionId });
          return { success: true, updated: true, reason: REASON_UPDATES_DISABLED_OVERRIDES_APPLIED };
        }
        // Debug: frozen skips must stay quiet on per-tick paths.
        this.logger.debug(`Metadata updates disabled for show: ${showName}`, { transactionId });
        return { success: true, updated: false, reason: REASON_UPDATES_DISABLED };
      }

      // Get TMDB data (either fetch fresh or use existing ID for seasons/episodes)
      let tmdbData;
      let imageResults = null;
      // G-5: raw pre-override TMDB payload, serialized opaquely for the
      // scanner to persist into tv_shows.pristine_metadata. Set on ANY branch
      // that performed a genuine TMDB fetch this invocation — the refresh
      // branch below AND the "fresh but no tmdb_id" corner fetch further down
      // (a full fetch too, even though its payload isn't the basis of
      // metadata.json this pass). Never re-synthesized from metadata.json,
      // never on frozen/no-op paths that fetched nothing. Trust/merge
      // semantics are Branch 2; this is population plumbing only.
      let pristineMetadata = null;

      if (needsShowRefresh || this.config.forceRefresh) {
        // Fetch fresh TMDB data for show metadata.
        // Embedded-response blurhash stays off for scanner fetches (B-1):
        // nothing consumes it — the sidecar .blurhash files written by
        // downloadMediaImages (still governed by config.generateBlurhash) are
        // the consumed pipeline. `false` also keeps these fetches on the
        // plain TMDB cache key.
        if (tmdbConfig.tmdb_id) {
          // Use existing TMDB ID
          tmdbData = await fetchComprehensiveMediaDetails(showName, 'tv', tmdbConfig.tmdb_id, false);
        } else {
          // Search for TMDB ID
          tmdbData = await fetchComprehensiveMediaDetails(showName, 'tv', null, false);

          // Update config with found TMDB ID
          if (tmdbData.id) {
            await updateTmdbConfigWithId(configPath, tmdbData.id, showName);
          }
        }

        // Capture the pristine payload BEFORE overrides are applied.
        // (applyMetadataOverrides is non-mutating, but serializing here makes
        // the pre-override capture point explicit and tamper-proof.)
        pristineMetadata = JSON.stringify(tmdbData);

        // Apply any metadata overrides from config
        const enhancedMetadata = applyMetadataOverrides(tmdbData, tmdbConfig);

        // Reconcile BEFORE downloading. Catches the case where the freshly
        // fetched metadata changed the effective URL for an image (e.g.
        // TMDB itself updated a poster_path) so the previously-managed file
        // is now stale by-URL even though tmdb.config hasn't been touched.
        const tmdbConfigLastModified = (await pathExists(configPath))
          ? await getLastModifiedTime(configPath)
          : null;
        await this._reconcileImageOwnership({
          mediaName: showName,
          mediaDir: showDir,
          mediaType: 'tv',
          tmdbConfig,
          enhancedMetadata,
          previousPaths,
          tmdbConfigLastModified,
          transactionId,
        });

        // forceRefresh (e.g. a tmdb.config id change) → wipe the show-level
        // images first so the download re-creates only what the new entity has.
        // Slots it lacks won't keep the previous id's art. (The reconcile above
        // is dry-run by default, so it can't be relied on to clear them.)
        if (this.config.forceRefresh) {
          await this._wipeManagedImagesForForceRefresh(showDir, 'tv', showName, transactionId);
        }

        // Download images
        imageResults = await downloadMediaImages(
          enhancedMetadata,
          showDir,
          tmdbConfig,
          'tv',
          {
            forceDownload: this.config.forceRefresh,
            generateBlurhash: this.config.generateBlurhash,
            mediaName: showName
          }
        );

        // Write metadata file
        await writeMetadataFile(metadataPath, enhancedMetadata);
      } else {
        // Show metadata is up-to-date, but we still need TMDB ID for seasons/episodes
        if (tmdbConfig.tmdb_id) {
          tmdbData = { id: tmdbConfig.tmdb_id };
        } else {
          // G-3: metadata.json is FRESH on this branch — it was written by a
          // previous full generation, so the id inside it is the trusted one.
          // Read that first; the unvalidated name search below (first result
          // wins, no disambiguation) is the last resort only when the file
          // carries no usable id. Without this, the up-to-date branch could
          // pin a wrong auto-match id purely to feed season processing — an
          // id the pristine-base trust rule ("trust the base iff an id is
          // set") would then wrongly believe.
          let existingId = null;
          try {
            const existing = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
            if (Number.isInteger(existing?.id) && existing.id > 0) {
              existingId = existing.id;
            }
          } catch {
            // absent or unparseable (e.g. an override-only file recreated
            // while frozen) — fall through to the search
          }

          if (existingId) {
            tmdbData = { id: existingId };
            // Persist through the add-only ratchet so the next pass takes the
            // cheap tmdbConfig.tmdb_id branch without re-reading the file.
            await updateTmdbConfigWithId(configPath, existingId, showName);
            this.logger.info(`Show metadata up-to-date; adopted TMDB ID ${existingId} from metadata.json for ${showName}`);
          } else {
            // Need to get TMDB ID to process seasons
            this.logger.info(`Show metadata up-to-date but need TMDB ID for ${showName}, fetching...`);
            tmdbData = await fetchComprehensiveMediaDetails(showName, 'tv', null, false); // Don't generate blurhash for this lookup
            if (tmdbData.id) {
              await updateTmdbConfigWithId(configPath, tmdbData.id, showName);
            }

            // This corner path is a genuine full TMDB fetch too, so capture the
            // pristine payload (G-5) — the capture rule keys on "a fetch
            // happened this invocation", not on whether the payload is written
            // to metadata.json. One-shot in practice: the id written above
            // makes the cheap `{ id }` branch take over on the next pass.
            pristineMetadata = JSON.stringify(tmdbData);
          }
        }

        // Even though show metadata is fresh, top-level images (show_poster,
        // show_backdrop, show_logo) may be missing on disk from a previous
        // failed download. Fill in just the missing ones from the existing
        // metadata.json — no fresh TMDB metadata call required. The helper
        // runs reconcile internally so stale-by-tmdb.config files get
        // deleted before the downloader's pathExists short-circuit.
        imageResults = await this._downloadImagesIfMissing({
          mediaName: showName,
          mediaDir: showDir,
          mediaType: 'tv',
          tmdbConfig,
          transactionId,
          previousPaths,
        });
      }

      // Always process seasons and episodes (even if show metadata is up-to-date)
      const seasonResults = await this.processShowSeasons(showDir, tmdbData.id, transactionId, showName);

      // Roll up image outcomes across show-level images, every season poster,
      // and every episode thumbnail so the operator can see at a glance how
      // much of the work was a fresh download vs. a disk cache hit.
      const seasonOutcomes = seasonResults.map(s => s.posterOutcome).filter(Boolean);
      const episodeOutcomes = seasonResults.flatMap(s => (s.episodes || []).map(e => e.thumbnailOutcome).filter(Boolean));
      const imageSummary = summarizeImageResults(imageResults || {}, seasonOutcomes, episodeOutcomes);

      this.logger.info(`Completed show metadata generation: ${showName}`, {
        transactionId,
        'media.name': showName,
        'media.type': 'tv',
        seasonsProcessed: seasonResults.length,
        imageSummary
      });

      return {
        success: true,
        updated: needsShowRefresh, // Only mark as updated if show metadata was actually refreshed
        tmdbId: tmdbData.id,
        imageResults: imageResults || {},
        seasonResults,
        imageSummary,
        // Non-null ONLY when the genuine-fetch branch ran this invocation
        // (G-5). The scanner persists it opaquely; null means "no fresh
        // payload — preserve whatever is stored".
        pristineMetadata,
        transactionId
      };

    } catch (error) {
      this.logger.error(`Failed to generate metadata for show: ${showName}`, {
        transactionId,
        error: error.message
      });
      // Classify the failure for the return contract: a typed no-match is a
      // confirmed "TMDB has no such title"; everything else on the fetch path
      // (network, HTTP, rate-limit) is transient. Both currently receive the
      // same scanner-side 24h cooldown — the split exists so logs/consumers
      // can tell the cases apart and so pacing can diverge later without
      // another contract change.
      return {
        success: false,
        error: error.message,
        reason: error instanceof TmdbNoMatchError ? 'no-match' : 'transient-error',
        transactionId
      };
    }
  }

  /**
   * Generate metadata for a movie
   * @param {string} movieName - Name of the movie directory
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generation results
   */
  async generateForMovie(movieName, options = {}) {
    const { previousPaths = null } = options;
    const transactionId = randomUUID();
    // Debug: the invocation may turn out to be a frozen no-op; real work is
    // announced by the info-level completion log below.
    this.logger.debug('Starting movie metadata generation', {
      movieName,
      transactionId,
      forceRefresh: this.config.forceRefresh
    });

    try {
      const movieDir = path.join(this.config.basePath, 'movies', movieName);
      const metadataPath = getMetadataFilePath(movieDir);
      const configPath = getTmdbConfigFilePath(movieDir);

      // Load TMDB configuration first so the freshness branch can also
      // honor isUpdateAllowed and pass the config to the image-only refresh.
      const tmdbConfig = await loadTmdbConfig(configPath);

      // Check if updates are allowed
      if (!isUpdateAllowed(tmdbConfig)) {
        const { applied } = await this._applyOverridesWhileFrozen(metadataPath, tmdbConfig);
        if (applied) {
          this.logger.info(`Applied manual metadata overrides while updates disabled: ${movieName}`, { transactionId });
          return { success: true, updated: true, reason: REASON_UPDATES_DISABLED_OVERRIDES_APPLIED };
        }
        // Debug: frozen skips must stay quiet on per-tick paths.
        this.logger.debug(`Metadata updates disabled for movie: ${movieName}`, { transactionId });
        return { success: true, updated: false, reason: REASON_UPDATES_DISABLED };
      }

      // Check if refresh is needed (unless forcing). When metadata is fresh
      // we DON'T short-circuit anymore — we still attempt to fill in any
      // top-level image (poster/backdrop/logo) that's missing on disk from
      // a previous failed download. downloadMediaImages already no-ops for
      // images that exist, so this is a cheap probe. The helper runs
      // reconcile internally for stale + orphan cleanup.
      if (!this.config.forceRefresh) {
        const needsRefresh = await shouldRefreshMetadata(metadataPath, configPath);
        if (!needsRefresh) {
          this.logger.info(`Movie metadata is up to date: ${movieName}`, { transactionId });
          const imageResults = await this._downloadImagesIfMissing({
            mediaName: movieName,
            mediaDir: movieDir,
            mediaType: 'movie',
            tmdbConfig,
            transactionId,
            previousPaths,
          });
          const imageSummary = summarizeImageResults(imageResults || {});
          return {
            success: true,
            updated: false,
            reason: 'up-to-date',
            imageResults: imageResults || {},
            imageSummary,
            transactionId,
          };
        }
      }

      // Fetch TMDB data. Embedded-response blurhash stays off for scanner
      // fetches (B-1) — see the matching note in generateForShow.
      let tmdbData;
      if (tmdbConfig.tmdb_id) {
        // Use existing TMDB ID
        tmdbData = await fetchComprehensiveMediaDetails(movieName, 'movie', tmdbConfig.tmdb_id, false);
      } else {
        // Search for TMDB ID
        tmdbData = await fetchComprehensiveMediaDetails(movieName, 'movie', null, false);

        // Update config with found TMDB ID
        if (tmdbData.id) {
          await updateTmdbConfigWithId(configPath, tmdbData.id, movieName);
        }
      }

      // G-5: capture the raw pre-override TMDB payload for the scanner to
      // persist into movies.pristine_metadata. This point is reachable ONLY
      // after a genuine fetch (the frozen and up-to-date paths returned
      // earlier), so the success return below always carries it. Serialized
      // before overrides are applied (applyMetadataOverrides is non-mutating,
      // but this makes the pre-override capture explicit). Trust/merge
      // semantics are Branch 2; this is population plumbing only.
      const pristineMetadata = JSON.stringify(tmdbData);

      // Apply any metadata overrides from config
      const enhancedMetadata = applyMetadataOverrides(tmdbData, tmdbConfig);

      // Reconcile BEFORE downloading on the fresh-fetch path too. Mirrors
      // the show flow; catches URL-change orphans plus stale-by-tmdb.config
      // files so the downloader actually re-fetches them.
      const tmdbConfigLastModified = (await pathExists(configPath))
        ? await getLastModifiedTime(configPath)
        : null;
      await this._reconcileImageOwnership({
        mediaName: movieName,
        mediaDir: movieDir,
        mediaType: 'movie',
        tmdbConfig,
        enhancedMetadata,
        previousPaths,
        tmdbConfigLastModified,
        transactionId,
      });

      // forceRefresh (e.g. a tmdb.config id change) → wipe the movie images
      // first so the download re-creates only what the new entity has; slots it
      // lacks won't keep the previous id's art.
      if (this.config.forceRefresh) {
        await this._wipeManagedImagesForForceRefresh(movieDir, 'movie', movieName, transactionId);
      }

      // Download images
      const imageResults = await downloadMediaImages(
        enhancedMetadata,
        movieDir,
        tmdbConfig,
        'movie',
        {
          forceDownload: this.config.forceRefresh,
          generateBlurhash: this.config.generateBlurhash,
          mediaName: movieName
        }
      );

      // Write metadata file
      await writeMetadataFile(metadataPath, enhancedMetadata);

      const imageSummary = summarizeImageResults(imageResults);

      this.logger.info(`Completed movie metadata generation: ${movieName}`, {
        transactionId,
        'media.name': movieName,
        'media.type': 'movie',
        tmdbId: enhancedMetadata.id,
        imageSummary
      });

      return {
        success: true,
        updated: true,
        tmdbId: enhancedMetadata.id,
        imageResults,
        imageSummary,
        // Raw pre-override TMDB payload from THIS invocation's genuine fetch
        // (G-5). Absent/null on the frozen and up-to-date returns above.
        pristineMetadata,
        transactionId
      };

    } catch (error) {
      this.logger.error(`Failed to generate metadata for movie: ${movieName}`, {
        transactionId,
        error: error.message
      });
      // Same classification as generateForShow: typed no-match vs transient
      // (identical scanner pacing today; see the comment there).
      return {
        success: false,
        error: error.message,
        reason: error instanceof TmdbNoMatchError ? 'no-match' : 'transient-error',
        transactionId
      };
    }
  }

  /**
   * Process seasons and episodes for a TV show
   * @param {string} showDir - Show directory path
   * @param {number} tmdbId - TMDB show ID
   * @param {string} transactionId - Transaction ID for logging
   * @returns {Promise<Array>} Season processing results
   */
  async processShowSeasons(showDir, tmdbId, transactionId, showName) {
    try {
      const directories = await getDirectories(showDir);
      const seasonDirs = directories.filter(dir => dir.startsWith('Season '));

      this.logger.info(`Found ${seasonDirs.length} seasons for processing`, { transactionId, 'media.name': showName });

      const seasonResults = [];

      // Process seasons sequentially to avoid overwhelming TMDB API
      for (const seasonDir of seasonDirs) {
        try {
          const seasonNumber = parseInt(seasonDir.replace('Season ', ''));
          if (isNaN(seasonNumber)) continue;

          const seasonPath = path.join(showDir, seasonDir);
          const result = await this.processSeason(seasonPath, tmdbId, seasonNumber, transactionId, showName);
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
  async processSeason(seasonPath, tmdbId, seasonNumber, transactionId, showName) {
    try {
      this.logger.debug(`Processing Season ${seasonNumber}`, { transactionId, 'media.name': showName });

      // Get season details from TMDB
      const seasonData = await this.getSeasonDetails(tmdbId, seasonNumber);

      // forceRefresh → drop any existing season poster first, so a new entity
      // that lacks one doesn't keep the previous id's poster.
      if (this.config.forceRefresh) {
        await this._forceWipeImage(path.join(seasonPath, 'season_poster.jpg'), {
          'media.name': showName,
          'media.type': 'tv',
          'image.type': 'season-poster',
          season: seasonNumber,
          transactionId,
        });
      }

      // Download season poster if available
      let posterResult = null;
      if (seasonData?.poster_path) {
        const posterUrl = `https://image.tmdb.org/t/p/original${seasonData.poster_path}`;
        posterResult = await downloadSeasonPoster(posterUrl, seasonPath, {
          forceDownload: this.config.forceRefresh,
          generateBlurhash: this.config.generateBlurhash,
          mediaName: showName,
          mediaType: 'tv'
        });
      }

      // Process episodes
      const episodeResults = await this.processSeasonEpisodes(seasonPath, tmdbId, seasonNumber, seasonData, transactionId, showName);

      return {
        success: true,
        episodesProcessed: episodeResults.length,
        posterDownloaded: posterResult?.success || false,
        posterOutcome: posterResult?.outcome,
        episodes: episodeResults
      };

    } catch (error) {
      this.logger.error(`Failed to process season ${seasonNumber}`, {
        transactionId,
        'media.name': showName,
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
  async processSeasonEpisodes(seasonPath, tmdbId, seasonNumber, seasonData, transactionId, showName) {
    try {
      const episodeResults = [];

      // Get episodes from season data or scan directory
      const episodes = seasonData?.episodes || [];

      // Process each episode
      for (const episode of episodes.slice(0, 50)) { // Limit to prevent excessive API calls
        try {
          const episodeNumber = episode.episode_number;
          const result = await this.processEpisode(seasonPath, tmdbId, seasonNumber, episodeNumber, episode, transactionId, showName);
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
  async processEpisode(seasonPath, tmdbId, seasonNumber, episodeNumber, episodeData, transactionId, showName) {
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

      // Get detailed episode data. A forceRefresh (tmdb.config edit / rescan)
      // bypasses the TMDB response cache so the rewrite reflects TMDB's current
      // state, not the 60-day-cached version.
      const detailedEpisodeData = await getEpisodeDetails(tmdbId, seasonNumber, episodeNumber, { forceRefresh: this.config.forceRefresh });

      // Write episode metadata
      await writeMetadataFile(episodeMetadataPath, detailedEpisodeData);

      // forceRefresh → drop any existing thumbnail first, so a new entity that
      // lacks a still doesn't keep the previous id's thumbnail.
      if (this.config.forceRefresh) {
        await this._forceWipeImage(
          path.join(seasonPath, `${episodeNumber.toString().padStart(2, '0')} - Thumbnail.jpg`),
          {
            'media.name': showName,
            'media.type': 'tv',
            'image.type': 'episode-thumbnail',
            season: seasonNumber,
            episode: episodeNumber,
            transactionId,
          }
        );
      }

      // Download episode thumbnail if available
      let thumbnailResult = null;
      if (detailedEpisodeData?.still_path) {
        const thumbnailUrl = `https://image.tmdb.org/t/p/original${detailedEpisodeData.still_path}`;
        thumbnailResult = await downloadEpisodeThumbnail(thumbnailUrl, seasonPath, episodeNumber, {
          forceDownload: this.config.forceRefresh,
          generateBlurhash: this.config.generateBlurhash,
          mediaName: showName,
          mediaType: 'tv'
        });
      }

      return {
        success: true,
        updated: true,
        thumbnailDownloaded: thumbnailResult?.success || false,
        thumbnailOutcome: thumbnailResult?.outcome
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

  /**
   * Public dispatch for image/metadata downloads. Replaces the role the
   * Python `download_tmdb_images.py` script used to play: given an optional
   * specific show or movie (or neither, for a full library refresh), run the
   * matching metadata + image flow through Node.
   *
   * @param {Object} options
   * @param {string|null} [options.showName]      - TV show directory name, mutually exclusive with movieName
   * @param {string|null} [options.movieName]     - Movie directory name, mutually exclusive with showName
   * @param {Object|null} [options.previousPaths] - { poster, backdrop, logo } pulled from the
   *   scanner's existing DB row. Used by the reconcile step to detect orphans
   *   (the previously-managed file path differs from what the current URL
   *   would produce). Null on full-library calls — the per-directory loop in
   *   `processDirectory` doesn't currently have row-level context. Reconcile
   *   safely no-ops for null previousPaths.
   * @returns {Promise<Object>} Result mirroring `generateForShow`/`generateForMovie`/`processDirectory`
   */
  async generateImages({ showName = null, movieName = null, previousPaths = null } = {}) {
    if (showName) {
      return await this.generateForShow(showName, { previousPaths });
    }
    if (movieName) {
      return await this.generateForMovie(movieName, { previousPaths });
    }

    // Full library refresh: TV first, then movies. previousPaths doesn't apply
    // at this level — processDirectory iterates each item without row context.
    const tvResult = await this.processDirectory('tv');
    const movieResult = await this.processDirectory('movies');
    return {
      success: tvResult.success !== false && movieResult.success !== false,
      tv: tvResult,
      movies: movieResult
    };
  }
}

/**
 * Air-date-aware episode-metadata backfill. The TV scanner cheaply identifies
 * candidate episodes (present-but-thin, via episodeData presence flags — no file
 * reads, no schema) and hands them here with their cooldown `lastAttempt`. This
 * function owns ALL the schema + file-content decisions the scanner must not make:
 * it reads each existing per-episode file, judges sparseness, reads `air_date`,
 * applies the due-gate, and fetches + writes only when due. It writes only on a
 * non-sparse TMDB response — no mtime bump (and thus no false hash move) on a
 * still-thin one. Standalone (no MetadataGenerator instance / no image reconcile);
 * does NOT touch full-show generation or the age-based refresh.
 * See plans/AIR_DATE_AWARE_EPISODE_BACKFILL.md.
 *
 * @param {number} tmdbId - TMDB show id
 * @param {Array<{seasonNumber:number, episodeNumber:number, seasonPath:string, lastAttempt?:string|null}>} candidates
 * @param {Object} [opts]
 * @param {Date} [opts.now=new Date()] - evaluation time for the due-gate
 * @param {boolean} [opts.generateBlurhash=true] - blurhash for any newly-downloaded thumbnail
 * @param {string} [opts.showName] - thumbnail bookkeeping / logging
 * @returns {Promise<Array<{seasonNumber:number, episodeNumber:number, attempted:boolean, written:boolean, resolved:boolean, expired:boolean, airDate:string|null}>>}
 *   `resolved` = the on-disk file is no longer thin (scanner should clear its cooldown row);
 *   `attempted` = a TMDB fetch ran (scanner should stamp the cooldown);
 *   `expired` = past the give-up window, backfill will never retry (scanner should prune the cooldown row).
 */
export async function refreshMissingEpisodes(tmdbId, candidates, opts = {}) {
  const { now = new Date(), generateBlurhash = true, showName = null } = opts;
  const results = [];

  for (const { seasonNumber, episodeNumber, seasonPath, lastAttempt = null } of candidates) {
    const base = { seasonNumber, episodeNumber, attempted: false, written: false, resolved: false, expired: false, airDate: null };
    try {
      // Confirm the file is actually thin (the scanner's proxy is a zero-I/O
      // approximation). A non-sparse file means it resolved already (e.g. the
      // age-based refresh filled it) → tell the scanner to drop the cooldown row.
      const existing = await readMetadataFile(getEpisodeMetadataPath(seasonPath, episodeNumber));
      if (!isEpisodeMetadataSparse(existing)) {
        results.push({ ...base, resolved: true });
        continue;
      }

      // Past the give-up window → the due-gate below would say "not due"
      // forever; surface that terminally so the scanner can prune the row.
      const airDate = existing?.air_date || null;
      if (isEpisodeBackfillExpired({ airDate, now })) {
        results.push({ ...base, expired: true, airDate });
        continue;
      }

      // air_date drives the gate; TBA / cooled-down / future air → not yet.
      if (!isEpisodeBackfillDue({ airDate, lastAttempt, now })) {
        results.push({ ...base, airDate });
        continue;
      }

      // Due → fetch. forceRefresh bypasses the TMDB response cache — without it
      // the backfill re-reads the same cached (sparse) response that produced the
      // thin file, never seeing TMDB's fill-in. Write only on a non-sparse result.
      const detailed = await getEpisodeDetails(tmdbId, seasonNumber, episodeNumber, { forceRefresh: true });
      const fetchedAirDate = detailed?.air_date || airDate;
      if (isEpisodeMetadataSparse(detailed)) {
        results.push({ ...base, attempted: true, airDate: fetchedAirDate });
        continue;
      }

      await writeMetadataFile(getEpisodeMetadataPath(seasonPath, episodeNumber), detailed);
      await downloadEpisodeThumbnail(`https://image.tmdb.org/t/p/original${detailed.still_path}`, seasonPath, episodeNumber, {
        forceDownload: false,
        generateBlurhash,
        mediaName: showName,
        mediaType: 'tv',
      });

      logger.info('Backfilled thin episode metadata', {
        'media.name': showName, 'media.type': 'tv', season: seasonNumber, episode: episodeNumber,
      });
      results.push({ ...base, attempted: true, written: true, airDate: fetchedAirDate });
    } catch (error) {
      logger.warn(`refreshMissingEpisodes failed for S${seasonNumber}E${episodeNumber} of "${showName}": ${error.message}`);
      // Treat as attempted so the cooldown advances and we don't hammer a failing fetch.
      results.push({ ...base, attempted: true });
    }
  }

  return results;
}
