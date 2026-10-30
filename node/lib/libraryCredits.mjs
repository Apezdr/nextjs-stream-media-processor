// lib/libraryCredits.mjs
//
// The library root's credits sidecar, as the manifests publish it.
//
// `<library root>/credits.json` credits the shared assets that sit outside any
// title folder (the poster collage at the file server root). The scan tick
// locates it (components/media-scanner/domain/library-credits.mjs) and stores
// the value in library_state; both GET /media/movies/manifest and
// GET /media/tv/manifest carry it as a top-level
//
//   "library": { "credits": <the same four-state value a title publishes> }
//
// read from that row when a cache body is built, never from the disk. With no
// row (no scan tick has run on this database yet) there is no `library` key,
// which is also what a processor without this change sends: unknown. The
// GET /media/<kind> bodies and the entries lines do not carry it.
//
// The value is in the manifest bytes, so its ETag moves when the value does.
// A manifest is built once per cache body, so each cache folds the library
// state's generation into its data generation (mediaDataGeneration): a scan
// tick that changed the value drops the bodies at its clear point, one that
// did not drops nothing.

import { getLibraryState, getLibraryStateGeneration, getMediaTableGeneration } from '../sqliteDatabase.mjs';

/** The library_state key of the root credits sidecar value. */
export const LIBRARY_CREDITS_KEY = 'credits';

/**
 * The manifests' `library` object: `{ credits }`, or null when no value is
 * stored. A read that fails is null too (unknown, never an absence), and is
 * logged; the body build goes on without it.
 *
 * @param {Object} [options]
 * @param {Object} [options.logger]
 * @returns {Promise<{credits: Object}|null>}
 */
export async function readManifestLibrary({ logger = null } = {}) {
  try {
    const credits = await getLibraryState(LIBRARY_CREDITS_KEY);
    return credits == null ? null : { credits };
  } catch (error) {
    logger?.warn?.(`library credits not read for the manifest: ${error?.message ?? error}`);
    return null;
  }
}

/**
 * A cache's data generation: its table's write count plus the library state's.
 * Both only ever count up, so the sum moves whenever either does.
 *
 * @param {'movies'|'tv_shows'} table
 * @returns {() => number}
 */
export function mediaDataGeneration(table) {
  return () => getMediaTableGeneration(table) + getLibraryStateGeneration();
}
