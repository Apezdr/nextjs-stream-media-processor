// utils/mediaResolution.mjs
//
// The single place that answers "which file on disk is this movie / episode?"
// and "which key in a stored show blob is this episode?".
//
// Before this module those two questions were answered by nine separate
// implementations (findMp4File, getEpisodeFilename, getEpisodeKey, two inline
// matchers inside videoHandler.mjs, inline readdir filters in app.mjs and both
// scanners, and sprite-route's own pair). Every one of them hardcoded `.mp4`,
// which is why a .mkv or .mov title was invisible to the backend. They also
// disagreed with each other: two supported legacy "01 - Name" episode keys and
// two silently did not, and five joined `Season ${n}` literally, which misses a
// folder named "Season 01" or "Season 2 - Pilot Arc".
//
// Container support lives in VIDEO_EXTENSIONS (utils.mjs). Season folders are
// matched numerically via findSeasonFolder. Nothing here knows or cares which
// container a title happens to use.

import { promises as fs } from 'fs';
import { join, extname } from 'path';
import { createCategoryLogger } from '../lib/logger.mjs';
import {
  VIDEO_EXTENSIONS,
  findVideoFile,
  stripVideoExtension,
  findSeasonFolder,
  safeJoin,
} from './utils.mjs';

const logger = createCategoryLogger('media-resolution');

// Tdarr writes in-progress transcodes alongside the real file. They are valid
// containers, so an extension filter alone would happily return one.
const TDARR_CACHE_MARKER = '-TdarrCacheFile-';

/**
 * A resolved video file.
 * @typedef {Object} VideoRef
 * @property {string} dir       - Absolute directory holding the file
 * @property {string} filename  - Basename, with extension
 * @property {string} path      - Absolute path to the file
 * @property {string} container - Extension without the dot, lowercased ('mkv')
 */

function toVideoRef(dir, filename) {
  return {
    dir,
    filename,
    path: join(dir, filename),
    container: extname(filename).toLowerCase().replace(/^\./, ''),
  };
}

/**
 * Is this directory entry a video file we can serve?
 * @param {string} filename
 * @returns {boolean}
 */
export function isVideoFile(filename) {
  return (
    !filename.includes(TDARR_CACHE_MARKER) &&
    VIDEO_EXTENSIONS.includes(extname(filename).toLowerCase())
  );
}

/**
 * List the video files in a directory, in a deterministic order: by
 * VIDEO_EXTENSIONS priority first (so .mp4 precedes .mkv), then by name.
 *
 * The ordering is load-bearing, not cosmetic — callers use position 0 as "the"
 * video file, and anything readdir-order-dependent would flap between scans on
 * some filesystems.
 *
 * @param {string} dir - Absolute directory path
 * @returns {Promise<string[]>} Basenames, ordered; empty if the dir is unreadable
 */
export async function listVideoFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    logger.debug(`listVideoFiles: cannot read ${dir}: ${err.code || err.message}`);
    return [];
  }

  return entries
    .filter(isVideoFile)
    .sort((a, b) => {
      const rank =
        VIDEO_EXTENSIONS.indexOf(extname(a).toLowerCase()) -
        VIDEO_EXTENSIONS.indexOf(extname(b).toLowerCase());
      return rank !== 0 ? rank : a.localeCompare(b);
    });
}

/**
 * RegExp matching an episode's FILENAME for a given season/episode.
 *
 * Covers the two shapes that appear on disk: the standard "S01E03" token and
 * the alternate "03 - Episode Name" leading-number form. Inputs may be padded
 * or not ("1", "01") — both are normalised through parseInt first.
 *
 * @param {string|number} season
 * @param {string|number} episode
 * @returns {RegExp}
 */
export function episodeFilePattern(season, episode) {
  const ss = String(parseInt(season, 10)).padStart(2, '0');
  const ee = String(parseInt(episode, 10)).padStart(2, '0');
  return new RegExp(`(S${ss}E${ee})|(^${ee}\\s*-)`, 'i');
}

/**
 * Canonical episode key for a season/episode pair: "S01E03".
 *
 * @param {string|number} season
 * @param {string|number} episode
 * @returns {string}
 */
export function episodeKeyFor(season, episode) {
  const ss = String(parseInt(season, 10)).padStart(2, '0');
  const ee = String(parseInt(episode, 10)).padStart(2, '0');
  return `S${ss}E${ee}`;
}

/**
 * Does a stored episode KEY refer to this season/episode?
 *
 * This is the union of the four matchers it replaces. Two of them (in
 * videoHandler.mjs) omitted the legacy branch and threw "Episode not found" for
 * shows that getEpisodeFilename could resolve — the union is deliberate, and
 * makes the clip and full-video paths agree for the first time.
 *
 * @param {string} key - A key from showData.seasons[...].episodes
 * @param {string|number} season
 * @param {string|number} episode
 * @returns {boolean}
 */
export function matchesEpisodeKey(key, season, episode) {
  const seasonInt = parseInt(season, 10);
  const episodeInt = parseInt(episode, 10);
  if (!Number.isFinite(seasonInt) || !Number.isFinite(episodeInt)) return false;

  const ss = String(seasonInt).padStart(2, '0');
  const ee = String(episodeInt).padStart(2, '0');

  // Standard "S01E03"
  const standard = key.match(/S(\d{2})E(\d{2})/i);
  if (standard) {
    return standard[1] === ss && standard[2] === ee;
  }

  // Alternate "03 - Episode Name"
  const alternate = key.match(/^(\d{2})\s*-/);
  if (alternate) {
    return alternate[1] === ee;
  }

  // Legacy loose forms, preserved from getEpisodeFilename/getEpisodeKey
  return key.includes(' - ') && (key.startsWith(ee) || key.includes(` ${ee} - `));
}

/**
 * Find a season inside a stored show blob, matching numerically rather than by
 * a literal `Season ${n}` key — the blob is keyed by real folder names, which
 * include "Season 01" and "Season 2 - Pilot Arc".
 *
 * @param {Object} showData - Row from getTVShowByName
 * @param {string|number} season
 * @returns {{ seasonName: string, season: Object }|null}
 */
export function findSeasonEntry(showData, season) {
  if (!showData?.seasons) return null;
  const seasonName = findSeasonFolder(Object.keys(showData.seasons), season);
  if (!seasonName) return null;
  return { seasonName, season: showData.seasons[seasonName] };
}

/**
 * Find an episode inside a stored show blob.
 *
 * @param {Object} showData
 * @param {string|number} season
 * @param {string|number} episode
 * @returns {{ seasonName: string, episodeKey: string, episode: Object }|null}
 */
export function findEpisodeEntry(showData, season, episode) {
  const seasonEntry = findSeasonEntry(showData, season);
  if (!seasonEntry?.season?.episodes) return null;

  const episodeKey = Object.keys(seasonEntry.season.episodes).find((key) =>
    matchesEpisodeKey(key, season, episode)
  );
  if (!episodeKey) return null;

  return {
    seasonName: seasonEntry.seasonName,
    episodeKey,
    episode: seasonEntry.season.episodes[episodeKey],
  };
}

/**
 * Pick a video file from a candidate list, honouring a caller's preferred
 * filename through three tiers:
 *
 *   1. exact filename match;
 *   2. stem match across containers — the stored filename says "Show.S01E03.mp4"
 *      but Tdarr remuxed it to .mkv, which used to 404 (findMp4File's any-mp4
 *      fallback masked it for movies and nothing masked it for TV);
 *   3. VIDEO_EXTENSIONS priority order, optionally constrained by a pattern.
 *
 * @param {string[]} files
 * @param {Object} [options]
 * @param {string|null} [options.preferFilename]
 * @param {RegExp|null} [options.pattern]
 * @returns {string|null}
 */
function pickVideoFile(files, { preferFilename = null, pattern = null } = {}) {
  if (preferFilename) {
    const exact = files.find((f) => f === preferFilename);
    if (exact) return exact;

    const wantedStem = stripVideoExtension(preferFilename).toLowerCase();
    const byStem = files.find(
      (f) => stripVideoExtension(f).toLowerCase() === wantedStem
    );
    if (byStem) {
      logger.info(
        `Resolved "${preferFilename}" to "${byStem}" by stem — the stored filename's container is stale`
      );
      return byStem;
    }
  }

  return findVideoFile(files, { pattern });
}

/**
 * Resolve a movie's video file.
 *
 * @param {Object} params
 * @param {string} params.basePath              - Media root (BASE_PATH)
 * @param {string} params.movieName             - Movie directory name (untrusted)
 * @param {string|null} [params.preferFilename] - Stored filename to prefer
 * @returns {Promise<VideoRef|null>}
 * @throws {PathTraversalError} if movieName escapes the movies directory
 */
export async function resolveMovieVideo({ basePath, movieName, preferFilename = null }) {
  const dir = safeJoin(join(basePath, 'movies'), movieName);
  const files = await listVideoFiles(dir);
  if (files.length === 0) return null;

  const filename = pickVideoFile(files, { preferFilename });
  return filename ? toVideoRef(dir, filename) : null;
}

/**
 * Resolve a show's season directory, matching the folder numerically.
 *
 * @param {Object} params
 * @param {string} params.basePath
 * @param {string} params.showName            - Untrusted
 * @param {string|number} params.season
 * @returns {Promise<{ dir: string, seasonFolder: string }|null>}
 * @throws {PathTraversalError} if showName escapes the tv directory
 */
export async function resolveSeasonDir({ basePath, showName, season }) {
  const showDir = safeJoin(join(basePath, 'tv'), showName);

  let entries;
  try {
    entries = await fs.readdir(showDir, { withFileTypes: true });
  } catch (err) {
    logger.debug(`resolveSeasonDir: cannot read ${showDir}: ${err.code || err.message}`);
    return null;
  }

  // Directories only — findSeasonFolder matches on the first digit run, which a
  // stray file like "Season 1 notes.txt" would otherwise satisfy.
  const seasonFolder = findSeasonFolder(
    entries.filter((e) => e.isDirectory()).map((e) => e.name),
    season
  );
  if (!seasonFolder) return null;

  // seasonFolder came from readdir, so it cannot introduce traversal.
  return { dir: join(showDir, seasonFolder), seasonFolder };
}

/**
 * Resolve an episode's video file.
 *
 * @param {Object} params
 * @param {string} params.basePath
 * @param {string} params.showName              - Untrusted
 * @param {string|number} params.season
 * @param {string|number} params.episode
 * @param {string|null} [params.preferFilename] - Stored filename to prefer
 * @returns {Promise<VideoRef|null>}
 * @throws {PathTraversalError} if showName escapes the tv directory
 */
export async function resolveEpisodeVideo({
  basePath,
  showName,
  season,
  episode,
  preferFilename = null,
}) {
  const seasonDir = await resolveSeasonDir({ basePath, showName, season });
  if (!seasonDir) return null;

  const files = await listVideoFiles(seasonDir.dir);
  if (files.length === 0) return null;

  const filename = pickVideoFile(files, {
    preferFilename,
    pattern: episodeFilePattern(season, episode),
  });
  return filename ? toVideoRef(seasonDir.dir, filename) : null;
}
