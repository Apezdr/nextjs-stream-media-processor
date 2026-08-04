import { promises as fs } from 'fs';
import { join } from 'path';
import { findVideoFile, stripVideoExtension, findSeasonFolder } from '../../../utils/utils.mjs';

/**
 * Resolve the source video file and the target .auto.srt path for a generation request.
 *
 * @param {Object} req
 * @param {string} req.basePath          - Media root (BASE_PATH)
 * @param {string} [req.publicPrefix]    - URL prefix for public/static-served paths (PREFIX_PATH)
 * @param {string} req.mediaType         - "movie" | "tv"
 * @param {string} req.mediaTitle        - Folder name under movies/ or tv/
 * @param {string} req.langCode          - ISO 639-1 code (e.g. "en")
 * @param {string} [req.season]          - tv only: season number (string)
 * @param {string} [req.episode]         - tv only: episode number (string)
 * @returns {Promise<{ videoPath, srtPath, srtPublicUrl, baseFilename, srtFilename }>}
 */
export async function resolveTarget(req) {
  if (req.mediaType === 'movie') {
    return resolveMovie(req);
  }
  if (req.mediaType === 'tv') {
    return resolveTvEpisode(req);
  }
  throw new Error(`Unsupported mediaType: ${req.mediaType}`);
}

async function resolveMovie({ basePath, publicPrefix = '', mediaTitle, langCode }) {
  const decodedTitle = decodeURIComponent(mediaTitle);
  const movieDir = join(basePath, 'movies', decodedTitle);

  const files = await fs.readdir(movieDir);
  const videoFile = findVideoFile(files);
  if (!videoFile) {
    throw new Error(`Movie file not found in ${movieDir}`);
  }

  const baseFilename = stripVideoExtension(videoFile);
  const srtFilename = `${baseFilename}.${langCode}.auto.srt`;

  return {
    videoPath: join(movieDir, videoFile),
    srtPath: join(movieDir, srtFilename),
    srtPublicUrl: `${publicPrefix}/movies/${encodeURIComponent(decodedTitle)}/${encodeURIComponent(srtFilename)}`,
    baseFilename,
    srtFilename
  };
}

async function resolveTvEpisode({ basePath, publicPrefix = '', mediaTitle, langCode, season, episode }) {
  if (!season || !episode) {
    throw new Error('season and episode are required for mediaType=tv');
  }

  const decodedTitle = decodeURIComponent(mediaTitle);
  const showDir = join(basePath, 'tv', decodedTitle);

  // Find the season folder by numeric match against `\d+` rather than
  // assuming a specific zero-padding convention. Folders can legitimately
  // be "Season 1", "Season 01", "Season 1 - Pilots", etc. — match by integer
  // value of the first digit run, the same way the scanner does.
  const seasonInt = parseInt(season, 10);
  if (!Number.isFinite(seasonInt)) {
    throw new Error(`Invalid season "${season}" — must be numeric`);
  }
  let seasonFolders;
  try {
    seasonFolders = await fs.readdir(showDir);
  } catch (err) {
    throw new Error(`Show folder not found: ${showDir} (${err.code})`);
  }
  const seasonName = findSeasonFolder(seasonFolders, season);
  if (!seasonName) {
    throw new Error(`Season ${seasonInt} not found in ${showDir}`);
  }
  const seasonDir = join(showDir, seasonName);

  const files = await fs.readdir(seasonDir);

  const paddedSeason = String(seasonInt).padStart(2, '0');
  const paddedEpisode = String(episode).padStart(2, '0');
  const episodePattern = new RegExp(`S${paddedSeason}E${paddedEpisode}`, 'i');

  const episodeFile = findVideoFile(files, { pattern: episodePattern });
  if (!episodeFile) {
    throw new Error(`Episode file matching S${paddedSeason}E${paddedEpisode} not found in ${seasonDir}`);
  }

  const baseFilename = stripVideoExtension(episodeFile);
  const srtFilename = `${baseFilename}.${langCode}.auto.srt`;

  return {
    videoPath: join(seasonDir, episodeFile),
    srtPath: join(seasonDir, srtFilename),
    srtPublicUrl: `${publicPrefix}/tv/${encodeURIComponent(decodedTitle)}/${encodeURIComponent(seasonName)}/${encodeURIComponent(srtFilename)}`,
    baseFilename,
    srtFilename
  };
}
