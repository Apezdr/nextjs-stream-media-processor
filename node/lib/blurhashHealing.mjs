// lib/blurhashHealing.mjs
//
// Writes the `.blurhash` sidecar of every published image that has none. Run
// once per process, after the startup scan (app.mjs).
//
// WHY. The scanners write a missing sidecar while they build an image's URL
// (getStoredBlurhash), and the directory hash they store afterwards includes
// what they wrote. A generation that fails there (and failed at download time
// too) leaves the image without a sidecar in a folder whose hash no longer
// moves, so no later scan retries it. The startup blurhash sweep removed in P2
// was what retried it; this pass keeps that, without the blurhash_hashes table.
// A sidecar written here moves the folder's directory hash, so the next scan
// reprocesses the folder and publishes the blurhash URL.
//
// The images are the ones the rows publish: each movie's and show's poster,
// backdrop and logo (their stored file paths, or their URLs for a row written
// before the paths were stored), each season poster and each episode thumbnail
// (their URLs). SVGs have no blurhash. Images are handled one at a time, so a
// missing sidecar costs one decode through the blurhash worker pool and a
// present one a single stat.

import { extname, join } from 'path';
import { fileExists, getStoredBlurhash } from '../utils/utils.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The file a published media URL points at, or null when it is not one of
 * ours: `<prefixPath>/movies/...` or `<prefixPath>/tv/...`, percent-encoded,
 * with an optional `?hash=` token.
 *
 * @param {string} url
 * @param {{basePath: string, prefixPath?: string}} options
 * @returns {string|null}
 */
export function fileForPublishedUrl(url, { basePath, prefixPath = '' }) {
  if (typeof url !== 'string' || url === '') return null;
  let path = url.split(/[?#]/, 1)[0];
  if (prefixPath) {
    if (!path.startsWith(prefixPath)) return null;
    path = path.slice(prefixPath.length);
  }
  if (!path.startsWith('/')) return null;
  let segments;
  try {
    segments = path.slice(1).split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments[0] !== 'movies' && segments[0] !== 'tv') return null;
  if (segments.length < 3 || segments.some((s) => s === '' || s === '.' || s === '..' || /[\\/]/.test(s))) {
    return null;
  }
  return join(basePath, ...segments);
}

/**
 * Every image file the rows publish, each once, in row order.
 *
 * @param {{movies?: Array<Object>, shows?: Array<Object>, basePath: string, prefixPath?: string}} params
 *   Rows as getMovies() and getTVShows() return them.
 * @returns {string[]}
 */
export function publishedImagePaths({ movies = [], shows = [], basePath, prefixPath = '' }) {
  const paths = new Set();
  const add = (filePath, url) => {
    const path = filePath || fileForPublishedUrl(url, { basePath, prefixPath });
    if (path) paths.add(path);
  };
  for (const movie of movies) {
    add(movie.posterFilePath, movie.urls?.poster);
    add(movie.backdropFilePath, movie.urls?.backdrop);
    add(movie.logoFilePath, movie.urls?.logo);
  }
  for (const show of shows) {
    add(show.posterFilePath, show.poster);
    add(show.backdropFilePath, show.backdrop);
    add(show.logoFilePath, show.logo);
    if (!isPlainObject(show.seasons)) continue;
    for (const season of Object.values(show.seasons)) {
      if (!isPlainObject(season)) continue;
      add(null, season.season_poster);
      if (!isPlainObject(season.episodes)) continue;
      for (const episode of Object.values(season.episodes)) {
        if (isPlainObject(episode)) add(null, episode.thumbnail);
      }
    }
  }
  return [...paths];
}

/**
 * Write the sidecar of each published image that exists, is not an SVG and
 * has none. Never throws for one image: a generation that fails or throws is
 * counted and the pass goes on.
 *
 * @param {Object} params
 * @param {Array<Object>} [params.movies] - getMovies() rows
 * @param {Array<Object>} [params.shows] - getTVShows() rows
 * @param {string} params.basePath
 * @param {string} [params.prefixPath]
 * @param {(path: string) => Promise<boolean>} [params.exists] - fileExists
 * @param {(imagePath: string, basePath: string) => Promise<string|null>} [params.generate]
 *   getStoredBlurhash: writes the sidecar, returns its URL, or null on failure
 * @returns {Promise<{checked: number, generated: number, failed: number}>}
 *   `checked` counts the non-SVG images examined (the sidecar stat);
 *   `generated` the sidecars written; `failed` the generations that did not
 *   write one. An image whose file is gone is left to the next scan.
 */
export async function healMissingBlurhashSidecars({
  movies = [],
  shows = [],
  basePath,
  prefixPath = '',
  exists = fileExists,
  generate = getStoredBlurhash,
}) {
  const summary = { checked: 0, generated: 0, failed: 0 };
  for (const imagePath of publishedImagePaths({ movies, shows, basePath, prefixPath })) {
    if (extname(imagePath).toLowerCase() === '.svg') continue;
    summary.checked++;
    if (await exists(`${imagePath}.blurhash`)) continue;
    if (!(await exists(imagePath))) continue;
    let url = null;
    try {
      url = await generate(imagePath, basePath);
    } catch {
      url = null;
    }
    if (url) summary.generated++;
    else summary.failed++;
  }
  return summary;
}
