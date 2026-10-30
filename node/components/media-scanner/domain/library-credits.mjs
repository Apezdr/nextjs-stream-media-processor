// components/media-scanner/domain/library-credits.mjs
//
// The scan tick's step for the library root's credits sidecar
// (`<library root>/credits.json`; lib/libraryCredits.mjs says how the
// manifests publish it). Apart from every title: the scan tick calls it once,
// before the movie and TV scans, so it runs whatever they do.

import { createCategoryLogger } from '../../../lib/logger.mjs';
import { locateLibraryCreditsSidecar } from './credits-sidecar.mjs';
import { saveLibraryCredits } from '../data-access/scanner-repository.mjs';

const logger = createCategoryLogger('credits-sidecar');

/**
 * Locate the library root's credits sidecar and store its value. Recomputed on
 * every call (one listing of the root, at most one small read), so it needs no
 * retry flag. Never throws: a store that fails is logged and keeps the value
 * stored before, which the manifests go on publishing.
 *
 * @param {Object} opts
 * @param {string} opts.root - The library root (BASE_PATH)
 * @param {string} opts.prefixPath - Its file server URL prefix (PREFIX_PATH)
 * @returns {Promise<{value: Object, changed: boolean}>}
 */
export async function scanLibraryCredits({ root, prefixPath }) {
  const value = await locateLibraryCreditsSidecar({ root, prefixPath });
  try {
    const changed = await saveLibraryCredits(value);
    if (changed) logger.info(`library credits sidecar now ${JSON.stringify(value)}`);
    return { value, changed };
  } catch (error) {
    logger.error(`library credits sidecar not stored: ${error?.message ?? error}`);
    return { value, changed: false };
  }
}
