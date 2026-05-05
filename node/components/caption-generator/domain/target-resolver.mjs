import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * Resolve the source .mp4 and the target .auto.srt path for a generation request.
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
  const mp4File = files.find(f => f.endsWith('.mp4'));
  if (!mp4File) {
    throw new Error(`Movie file not found in ${movieDir}`);
  }

  const baseFilename = mp4File.replace(/\.mp4$/, '');
  const srtFilename = `${baseFilename}.${langCode}.auto.srt`;

  return {
    videoPath: join(movieDir, mp4File),
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
  const seasonName = `Season ${season}`;
  const seasonDir = join(basePath, 'tv', decodedTitle, seasonName);

  const files = await fs.readdir(seasonDir);

  const paddedSeason = String(season).padStart(2, '0');
  const paddedEpisode = String(episode).padStart(2, '0');
  const episodePattern = new RegExp(`S${paddedSeason}E${paddedEpisode}`, 'i');

  const episodeFile = files.find(f => f.endsWith('.mp4') && episodePattern.test(f));
  if (!episodeFile) {
    throw new Error(`Episode file matching S${paddedSeason}E${paddedEpisode} not found in ${seasonDir}`);
  }

  const baseFilename = episodeFile.replace(/\.mp4$/, '');
  const srtFilename = `${baseFilename}.${langCode}.auto.srt`;

  return {
    videoPath: join(seasonDir, episodeFile),
    srtPath: join(seasonDir, srtFilename),
    srtPublicUrl: `${publicPrefix}/tv/${encodeURIComponent(decodedTitle)}/${encodeURIComponent(seasonName)}/${encodeURIComponent(srtFilename)}`,
    baseFilename,
    srtFilename
  };
}
