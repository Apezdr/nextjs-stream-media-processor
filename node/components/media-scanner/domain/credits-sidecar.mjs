// components/media-scanner/domain/credits-sidecar.mjs
//
// The credits sidecar: a title's credits and licenses, in a file of its own
// beside its metadata. The contract is owned by the frontend (the frontend's
// CREDITS_SIDECAR.md, repo root); this module is the processor's part of it,
// and the only code here that touches the file.
//
//   movie    movies/<folder>/credits.json
//   show     tv/<folder>/credits.json
//   episode  tv/<folder>/<season folder>/<NN>_credits.json, where <NN> is the
//            episode number exactly as its <NN>_metadata.json is named
//
// The scanner never parses the file. It looks for the name in the folder
// listing it already has, checks the size, reads the bytes and hashes them;
// the frontend fetches, validates and stores it. Nothing here knows the
// schema, and no other file is hashed for it.
//
// What a title publishes as `credits`:
//
//   { url: '<path>?hash=<h>', hash: '<h>' }  read; h = SHA-256 hex of the bytes
//   { absent: true }                         the listing has no such file
//   { error: 'unreadable' | 'not-a-file' | 'too-large' | 'empty' }
//                                            listed, but its stat or read
//                                            failed; not a regular file (a
//                                            directory, a socket); over 256 KiB;
//                                            or 0 bytes
//
// An error is not an absence (AGENTS.md, "Failed ≠ absent"). A title whose
// stored value is `unreadable` is read again on the next scan though its
// folder did not change (creditsNeedsReread): the fix for it (a permission
// change, a share that mounts again) moves no size or mtime, so the directory
// hash cannot see it. `not-a-file`, `too-large` and `empty` are pinned to the
// file system and fixed by replacing or editing the file, which moves the
// directory hash, so they wait for that.

import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { createCategoryLogger } from '../../../lib/logger.mjs';

const logger = createCategoryLogger('credits-sidecar');

/** The largest credits file read: 256 KiB, the same on the frontend. */
export const CREDITS_SIDECAR_MAX_BYTES = 262144;

/** A movie's or show's credits file, in the title folder. */
export const CREDITS_FILE_NAME = 'credits.json';

/**
 * An episode's credits file, in its season folder.
 *
 * @param {string} episodeNumber - The episode number as the episode's
 *   `<NN>_metadata.json` is named (processEpisode's `episodeNumber`)
 * @returns {string}
 */
export function episodeCreditsFileName(episodeNumber) {
  return `${episodeNumber}_credits.json`;
}

function listingHas(listing, fileName) {
  if (listing instanceof Set) return listing.has(fileName);
  return Array.isArray(listing) && listing.includes(fileName);
}

/**
 * Up to `CREDITS_SIDECAR_MAX_BYTES + 1` bytes of an open file: one byte past
 * the cap is enough to tell a file that grew past it after the size check.
 */
async function readCapped(handle) {
  const buffer = Buffer.allocUnsafe(CREDITS_SIDECAR_MAX_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

function failed(reason, libraryRelativePath, detail = null) {
  logger.warn(`credits sidecar ${libraryRelativePath}: ${reason}`, {
    'credits.path': libraryRelativePath,
    'credits.error': reason,
    ...(detail ? { error: detail } : {}),
  });
  return { error: reason };
}

/**
 * The `credits` value a title publishes for one sidecar file.
 *
 * Absence is read off the folder listing the scanner already holds; nothing is
 * stat'ed for it. A listed name is stat'ed first, so a directory, socket or
 * FIFO is `not-a-file` without being opened (opening a FIFO would wait for a
 * writer). A regular file is opened, size-checked, read (never more than one
 * byte past the cap) and hashed. The bytes are not parsed. A stat or read that
 * fails (EACCES, EIO, gone since the listing) is `unreadable`.
 *
 * @param {Object} opts
 * @param {Set<string>|string[]} opts.listing - The folder's readdir names
 * @param {string} opts.dir - The folder's absolute path
 * @param {string} opts.fileName - CREDITS_FILE_NAME or episodeCreditsFileName()
 * @param {string} opts.url - The file's URL, without the `?hash=` token
 * @param {string} opts.libraryRelativePath - e.g. `movies/<folder>/credits.json`;
 *   named in the warn logged for an error
 * @returns {Promise<{url: string, hash: string}|{absent: true}|{error: 'unreadable'|'not-a-file'|'too-large'|'empty'}>}
 */
export async function locateCreditsSidecar({ listing, dir, fileName, url, libraryRelativePath }) {
  if (!listingHas(listing, fileName)) return { absent: true };

  const path = join(dir, fileName);
  const errorCode = (err) => err?.code ?? err?.message ?? String(err);

  let stats;
  try {
    stats = await fs.stat(path);
  } catch (err) {
    // Listed but not stat-able (permissions, a transient mount fault, gone
    // since the listing). Not an absence: the stored `unreadable` brings the
    // title back next scan.
    return failed('unreadable', libraryRelativePath, errorCode(err));
  }
  if (!stats.isFile()) return failed('not-a-file', libraryRelativePath);
  if (stats.size > CREDITS_SIDECAR_MAX_BYTES) return failed('too-large', libraryRelativePath);
  if (stats.size === 0) return failed('empty', libraryRelativePath);

  let handle;
  try {
    handle = await fs.open(path, 'r');
    // Again on what was opened: the name may point elsewhere since the stat.
    if (!(await handle.stat()).isFile()) return failed('not-a-file', libraryRelativePath);

    const bytes = await readCapped(handle);
    if (bytes.length > CREDITS_SIDECAR_MAX_BYTES) return failed('too-large', libraryRelativePath);
    if (bytes.length === 0) return failed('empty', libraryRelativePath);

    const hash = createHash('sha256').update(bytes).digest('hex');
    return { url: `${url}?hash=${hash}`, hash };
  } catch (err) {
    if (err?.code === 'EISDIR') return failed('not-a-file', libraryRelativePath);
    return failed('unreadable', libraryRelativePath, errorCode(err));
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The library root's credits sidecar: `<library root>/credits.json`, for the
 * shared assets outside any title folder (the poster collage at the file
 * server root). Its asset paths are relative to the root. Both manifests
 * publish the value as `library.credits` (lib/libraryCredits.mjs).
 *
 * The root is listed here, since no scan holds a listing of it. A listing that
 * fails is `unreadable`, never an absence. So is one that lists neither
 * `movies` nor `tv`: an unmounted share leaves an empty mount point behind,
 * and the frontend deletes the library credits it stored on `absent`.
 *
 * @param {Object} opts
 * @param {string} opts.root - The library root (BASE_PATH: holds movies/ and tv/)
 * @param {string} opts.prefixPath - The file server URL prefix of that root
 * @returns {Promise<{url: string, hash: string}|{absent: true}|{error: 'unreadable'|'not-a-file'|'too-large'|'empty'}>}
 */
export async function locateLibraryCreditsSidecar({ root, prefixPath }) {
  let listing;
  try {
    listing = await fs.readdir(root);
  } catch (err) {
    return failed('unreadable', CREDITS_FILE_NAME, `library root not listed: ${err?.code ?? err?.message ?? String(err)}`);
  }
  if (!listing.includes('movies') && !listing.includes('tv')) {
    return failed('unreadable', CREDITS_FILE_NAME, 'library root lists neither movies nor tv (not mounted?)');
  }
  return locateCreditsSidecar({
    listing,
    dir: root,
    fileName: CREDITS_FILE_NAME,
    url: `${prefixPath}/${encodeURIComponent(CREDITS_FILE_NAME)}`,
    libraryRelativePath: CREDITS_FILE_NAME,
  });
}

/**
 * Whether a stored credits value has to be read again on the next scan though
 * the title's directory did not change: it is `{ error: 'unreadable' }`.
 *
 * Only that error: a permission fix (chmod) moves the file's ctime, not its
 * mtime or size, so the directory hash cannot see it. `not-a-file`,
 * `too-large` and `empty` are fixed by replacing or editing the file, which
 * moves the directory hash and brings the title back by itself; reading them
 * again every scan would only repeat the title's whole reprocess. Takes the value as stored (the movies/tv_shows
 * column's JSON text) or already parsed (an episode's value inside the seasons
 * blob). A missing value (a row written before credits existed) is not an
 * error; the payload version bump brings those rows back once.
 *
 * @param {string|Object|null|undefined} stored
 * @returns {boolean}
 */
export function creditsNeedsReread(stored) {
  let value = stored;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return value !== null && typeof value === 'object' && value.error === 'unreadable';
}

/**
 * Whether a show's credits, or any of its episodes', has to be read again
 * (creditsNeedsReread: it is `unreadable`): the tv_shows.credits_retry flag,
 * written on every save so the scanner's name-and-hash read can see it
 * without loading the seasons blob.
 *
 * @param {Object|null} showCredits - The show-level value
 * @param {Object} seasons - The seasons blob as saved
 * @returns {boolean}
 */
export function showCreditsNeedReread(showCredits, seasons) {
  if (creditsNeedsReread(showCredits)) return true;
  for (const season of Object.values(seasons ?? {})) {
    for (const episode of Object.values(season?.episodes ?? {})) {
      if (creditsNeedsReread(episode?.credits)) return true;
    }
  }
  return false;
}
