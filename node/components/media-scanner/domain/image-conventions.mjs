/**
 * Image conventions shared by both scanners and the downloader.
 *
 * The system tracks three image kinds (poster, backdrop, logo) per media
 * directory. Each kind has:
 *   - a `prefix` — the filename stem on disk (e.g. "poster" or "show_poster")
 *   - `extensions` — accepted extensions in priority order; the first
 *     matching file wins when multiple files exist on disk
 *
 * This module is the single source of truth for filename conventions. It
 * replaces three previously-divergent hardcoded lists:
 *   - `movie-scanner.mjs` `checkTMDBImagesNeeded` (was fixed: backdrop.jpg /
 *     poster.jpg / movie_logo.png with logo.png alt)
 *   - `tv-scanner.mjs` `processShowAssets` (svg|jpg|png|gif logo,
 *     jpg|png|gif backdrop)
 *   - `imageDownloader.mjs` `downloadMediaImages` (prefix only — URL
 *     derives the extension)
 *
 * Movies and TV are now symmetric: same extension lists, same priority
 * order. The only difference is the prefix (e.g. `logo` vs `show_logo`).
 *
 * NOTE: the legacy `movie_logo` prefix from the pre-Node migration era is
 * intentionally NOT supported here. Operators should rename any remaining
 * `movie_logo.<ext>` files to `logo.<ext>` (or just let the scanner detect
 * them as missing and re-download from TMDB).
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { extractFileExtension } from '../../../utils/fileUtils.mjs';

// Direct read of the convention table. Currently used internally by the
// helpers below; will also be consumed by `MetadataGenerator._reconcileImageOwnership`
// (a future PR) when walking all image kinds for orphan + stale-refresh
// detection.
export const IMAGE_CONVENTIONS = {
  movie: {
    poster:   { prefix: 'poster',   extensions: ['jpg', 'png', 'gif'] },
    backdrop: { prefix: 'backdrop', extensions: ['jpg', 'png', 'gif'] },
    logo:     { prefix: 'logo',     extensions: ['svg', 'jpg', 'png', 'gif'] },
  },
  tv: {
    poster:   { prefix: 'show_poster',   extensions: ['jpg', 'png', 'gif'] },
    backdrop: { prefix: 'show_backdrop', extensions: ['jpg', 'png', 'gif'] },
    logo:     { prefix: 'show_logo',     extensions: ['svg', 'jpg', 'png', 'gif'] },
  },
};

/**
 * Get the convention for a specific media type + image kind.
 *
 * @param {'movie'|'tv'} mediaType
 * @param {'poster'|'backdrop'|'logo'} imageKey
 * @returns {{prefix: string, extensions: string[]}}
 */
export function getConvention(mediaType, imageKey) {
  const byType = IMAGE_CONVENTIONS[mediaType];
  if (!byType) throw new Error(`Unknown media type: ${mediaType}`);
  const conv = byType[imageKey];
  if (!conv) throw new Error(`Unknown image kind ${imageKey} for media type ${mediaType}`);
  return conv;
}

/**
 * Convenience: iterate over each image-kind convention for a media type.
 * Use in scanners that want to walk all three (poster/backdrop/logo)
 * uniformly.
 *
 * @param {'movie'|'tv'} mediaType
 * @yields {[string, {prefix: string, extensions: string[]}]}
 */
export function* iterateConventions(mediaType) {
  for (const imageKey of ['poster', 'backdrop', 'logo']) {
    yield [imageKey, getConvention(mediaType, imageKey)];
  }
}

/**
 * Find an existing image file in a directory matching the convention.
 * Returns the first match in extension-priority order.
 *
 * @param {string} dirPath
 * @param {{prefix: string, extensions: string[]}} convention
 * @returns {Promise<{path: string, fileName: string, ext: string}|null>}
 */
export async function findExistingImage(dirPath, convention) {
  const { prefix, extensions } = convention;
  for (const ext of extensions) {
    const fileName = `${prefix}.${ext}`;
    const filePath = path.join(dirPath, fileName);
    try {
      await fs.access(filePath);
      return { path: filePath, fileName, ext };
    } catch {
      // not found — continue
    }
  }
  return null;
}

/**
 * Set-based variant for callers that have already enumerated the directory
 * (e.g. via `fs.readdir`). Cheaper than repeated `fs.access`.
 *
 * @param {Set<string>} fileSet
 * @param {{prefix: string, extensions: string[]}} convention
 * @returns {{fileName: string, ext: string}|null}
 */
export function findExistingImageInSet(fileSet, convention) {
  const { prefix, extensions } = convention;
  for (const ext of extensions) {
    const fileName = `${prefix}.${ext}`;
    if (fileSet.has(fileName)) {
      return { fileName, ext };
    }
  }
  return null;
}

/**
 * Single source of truth for the image cache-bust formula.
 *
 * The token is derived from the file's mtime (floored to whole ms), NOT its
 * contents — a `touch` invalidates it, which is acceptable here since mtime
 * changes track real image rewrites. Every place that bakes a `?hash=` token
 * (show/movie poster/backdrop/logo, season posters, episode thumbnails, episode
 * metadata) and the `*_hash` DB columns all flow through this one function, so a
 * given file always hashes to the same value everywhere.
 *
 * @param {number} mtimeMs - File mtime in milliseconds (e.g. `stats.mtimeMs`)
 * @returns {string} 10-char hex token
 */
export function imageHashFromMtimeMs(mtimeMs) {
  return createHash('md5').update(String(Math.floor(mtimeMs))).digest('hex').substring(0, 10);
}

/**
 * Resolve one image kind to everything the scanner + DB need, from a SINGLE
 * directory lookup and a SINGLE stat. The returned object is the sole authority
 * for the file's name, path, mtime, and cache-bust hash — so the served URL
 * filename, the `*_file_path` column, and the `*_hash` column are computed from
 * the same source and cannot drift apart (the failure that froze a movie logo
 * on a stale hash when the URL and file_path were resolved by separate scans).
 *
 * Discovery is in-memory when `fileSet` is supplied (preferred — zero syscalls);
 * otherwise it falls back to a live `fs.access` sweep. Either way exactly one
 * `fs.stat` runs. A missing file (no match) or a stat race returns `null`, so
 * name/path/hash go null together (consistent) rather than partially.
 *
 * @param {Object} opts
 * @param {string} opts.dirPath - Directory containing the image
 * @param {Set<string>} [opts.fileSet=null] - Pre-enumerated directory listing
 * @param {{prefix: string, extensions: string[]}} opts.convention
 * @returns {Promise<{path: string, fileName: string, ext: string, mtime: Date, mtimeMs: number, hash: string}|null>}
 */
export async function resolveImage({ dirPath, fileSet = null, convention }) {
  const found = fileSet
    ? findExistingImageInSet(fileSet, convention)
    : await findExistingImage(dirPath, convention);
  if (!found) return null;

  const filePath = found.path ?? path.join(dirPath, found.fileName);
  try {
    const stats = await fs.stat(filePath);
    const mtimeMs = Math.floor(stats.mtimeMs);
    return {
      path: filePath,
      fileName: found.fileName,
      ext: found.ext,
      mtime: stats.mtime,
      mtimeMs,
      hash: imageHashFromMtimeMs(mtimeMs),
    };
  } catch {
    return null;
  }
}

/**
 * Project a `{poster, backdrop, logo}` map of `resolveImage()` results down to
 * the `{hash, mtime}` pairs the DB write layer stores. An absent kind (null
 * resolution) maps to null so the row's `*_hash` / `*_mtime` columns clear.
 * Shared by both scanners so the projection lives in exactly one place.
 *
 * @param {{poster: ?Object, backdrop: ?Object, logo: ?Object}} resolved
 * @returns {{poster: ?{hash: string, mtime: number}, backdrop: ?{hash: string, mtime: number}, logo: ?{hash: string, mtime: number}}}
 */
export function imageHashesFromResolved(resolved) {
  const pick = (r) => (r ? { hash: r.hash, mtime: r.mtimeMs } : null);
  return {
    poster: pick(resolved.poster),
    backdrop: pick(resolved.backdrop),
    logo: pick(resolved.logo),
  };
}

/**
 * Compute the filename the system would write right now for a given image,
 * given the current effective URL. The downloader derives the extension
 * from the URL path; this centralizes that derivation so the reconcile
 * step (in MetadataGenerator) can predict the exact destination path.
 *
 * NOTE: this export is currently unused — staged for the reconcile step
 * in a future PR. Kept here so the prefix→filename derivation lives in one
 * place when that work lands.
 *
 * @param {string} dirPath
 * @param {string} prefix - The convention's prefix
 * @param {string} url - The effective URL (override or TMDB metadata)
 * @param {string} [fallbackExt='jpg'] - Used when the URL yields no extension
 * @returns {string} Full destination path
 */
export function expectedImagePathFromUrl(dirPath, prefix, url, fallbackExt = 'jpg') {
  let ext = extractFileExtension(url);
  if (!ext) ext = `.${fallbackExt}`;
  if (!ext.startsWith('.')) ext = `.${ext}`;
  return path.join(dirPath, `${prefix}${ext}`);
}
