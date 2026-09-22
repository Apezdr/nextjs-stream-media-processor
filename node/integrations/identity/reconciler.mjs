/**
 * Apply an identity index to the library: for every claimed folder that exists
 * on disk, offer the claim to that folder's tmdb.config through the precedence
 * rule (`pinTmdbIdentity`). Everything the rule decides is tallied into a
 * report; nothing here interprets tmdb.config itself (§4.6).
 *
 * How a repair reaches the frontend without touching the scanner: a `write`
 * moves tmdb.config's mtime past metadata.json's, which the scanner already
 * reads as an operator edit → force-refresh repull with the new id → new
 * hashes → frontend resync. A `stamp` preserves the mtime, so provenance
 * bookkeeping never triggers that.
 *
 * The reconciler never deletes anything and never blocks a scan: any failure
 * is recorded per folder and the loop continues.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import pLimit from 'p-limit';
import { pinTmdbIdentity, getTmdbConfigFilePath } from '../../utils/tmdbConfig.mjs';
import { LIBRARY_ROOTS, MEDIA_TYPES, splitLibraryRelativePath } from './provider.mjs';

const DEFAULT_LIST_CAP = 200;
const DEFAULT_CONCURRENCY = 8;

/**
 * Top-level folders under a library root. Missing root → empty set.
 * @param {string} basePath
 * @param {'movie'|'tv'} mediaType
 * @returns {Promise<Set<string>>}
 */
export async function listLibraryFolders(basePath, mediaType) {
  const dir = path.join(basePath, LIBRARY_ROOTS[mediaType]);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    return new Set();
  }
}

/**
 * Every library root at once.
 * @param {string} basePath
 * @returns {Promise<Object<string, Set<string>>>} keyed by media type
 */
export async function listAllLibraryFolders(basePath) {
  const out = {};
  for (const mediaType of MEDIA_TYPES) {
    out[mediaType] = await listLibraryFolders(basePath, mediaType);
  }
  return out;
}

/**
 * Stable hash of the library's folder names, the on-disk half of the change
 * detector (the provider half is `fingerprintClaims` in index-builder.mjs).
 * @param {Object<string, Set<string>>} foldersByType
 * @returns {string}
 */
export function fingerprintFolders(foldersByType) {
  const lines = [];
  for (const mediaType of MEDIA_TYPES) {
    for (const folder of foldersByType[mediaType] ?? []) lines.push(`${mediaType}\t${folder}`);
  }
  return createHash('sha1').update(lines.sort().join('\n')).digest('hex');
}

/**
 * A provider-only row: the claim's provider-side facts, forwarded unchanged
 * so the admin page can say why a title is expected but absent (queued,
 * not released, not monitored, drift).
 */
function providerOnlyRow(claim) {
  return {
    libraryRelativePath: claim.libraryRelativePath,
    tmdbId: claim.tmdbId,
    source: claim.source,
    hasFile: claim.hasFile,
    providerPath: claim.providerPath,
    released: claim.released ?? null,
    arrStatus: claim.arrStatus ?? null,
    monitored: claim.monitored ?? null,
  };
}

function capped(list, cap) {
  return { items: list.slice(0, cap), total: list.length, truncated: Math.max(0, list.length - cap) };
}

/**
 * Offer one claim to its folder. Used per-folder by the tick reconcile and
 * directly by the webhook path.
 *
 * @param {import('./provider.mjs').IdentityClaim} claim
 * @param {Object} options
 * @param {string} options.basePath
 * @param {'manual'|'auto'} [options.unsourcedPinTreatment]
 * @param {Set<string>|null} [options.foldersOnDisk] pre-listed folders; listed on demand when null
 * @param {Function} [options.pin] injectable pinTmdbIdentity
 * @returns {Promise<{libraryRelativePath: string, outcome: 'write'|'stamp'|'keep'|'conflict'|'missing-folder'|'nested-path'|'error', decision?: Object, error?: string}>}
 */
export async function reconcileClaim(claim, { basePath, unsourcedPinTreatment, foldersOnDisk = null, pin = pinTmdbIdentity }) {
  const split = splitLibraryRelativePath(claim.libraryRelativePath);
  if (!split) {
    return { libraryRelativePath: claim.libraryRelativePath, outcome: 'error', error: 'not a library-relative path' };
  }
  if (split.folder.includes('/')) {
    // The scanners only see one level under each root; a deeper mapping can
    // never match a scanned folder, so say so rather than creating one.
    return { libraryRelativePath: claim.libraryRelativePath, outcome: 'nested-path' };
  }
  const folders = foldersOnDisk ?? (await listLibraryFolders(basePath, split.mediaType));
  if (!folders.has(split.folder)) {
    return { libraryRelativePath: claim.libraryRelativePath, outcome: 'missing-folder' };
  }
  const mediaDir = path.join(basePath, LIBRARY_ROOTS[split.mediaType], split.folder);
  try {
    const { decision } = await pin(
      getTmdbConfigFilePath(mediaDir),
      { tmdbId: claim.tmdbId, source: claim.source },
      { mediaName: split.folder, unsourcedPinTreatment }
    );
    return { libraryRelativePath: claim.libraryRelativePath, outcome: decision.action, decision };
  } catch (error) {
    return { libraryRelativePath: claim.libraryRelativePath, outcome: 'error', error: error.message };
  }
}

/**
 * Reconcile the whole library against an index.
 *
 * @param {Object} options
 * @param {import('./index-builder.mjs').IdentityIndex} options.index
 * @param {string} options.basePath
 * @param {'manual'|'auto'} [options.unsourcedPinTreatment]
 * @param {Object} [options.logger]
 * @param {Function} [options.pin] injectable pinTmdbIdentity
 * @param {Function} [options.listFolders] injectable listLibraryFolders
 * @param {number} [options.concurrency]
 * @param {number} [options.listCap] max entries kept per report list
 * @param {string} [options.reason] why this reconcile ran (for the report)
 * @returns {Promise<Object>} the reconcile report
 */
export async function reconcileIdentities({
  index,
  basePath,
  unsourcedPinTreatment,
  logger = null,
  pin = pinTmdbIdentity,
  listFolders = listLibraryFolders,
  concurrency = DEFAULT_CONCURRENCY,
  listCap = DEFAULT_LIST_CAP,
  reason = 'scan-tick',
}) {
  const started = Date.now();
  const limit = pLimit(concurrency);

  const totals = { claimed: 0, write: 0, stamp: 0, keep: 0, conflict: 0, providerOnly: 0, unmanaged: 0, nested: 0, errors: 0 };
  const written = [];
  const conflicts = [];
  const providerOnly = [];
  const unmanaged = [];
  const errors = [];
  const perType = {};

  for (const mediaType of MEDIA_TYPES) {
    const foldersOnDisk = await listFolders(basePath, mediaType);
    const claims = index.claimsFor(mediaType);
    const claimedFolders = new Set();
    // A type with no successful provider this tick is unknown, not unmanaged:
    // listing every one of its folders as unmanaged would be a lie born of an
    // outage. Older/foreign indexes without coveredTypes count as covered.
    const covered = index.coveredTypes ? index.coveredTypes.has(mediaType) : true;
    perType[mediaType] = { onDisk: foldersOnDisk.size, claimed: claims.length, covered };

    await Promise.all(
      claims.map((claim) => limit(async () => {
        totals.claimed++;
        const result = await reconcileClaim(claim, { basePath, unsourcedPinTreatment, foldersOnDisk, pin });
        const split = splitLibraryRelativePath(claim.libraryRelativePath);
        switch (result.outcome) {
          case 'write':
            totals.write++;
            claimedFolders.add(split.folder);
            written.push({
              libraryRelativePath: claim.libraryRelativePath,
              tmdbId: result.decision.tmdbId,
              source: result.decision.source,
              replacedId: result.decision.storedId ?? null,
              replacedSource: result.decision.storedSource ?? null,
            });
            break;
          case 'stamp':
            totals.stamp++;
            claimedFolders.add(split.folder);
            break;
          case 'keep':
            totals.keep++;
            claimedFolders.add(split.folder);
            break;
          case 'conflict':
            totals.conflict++;
            claimedFolders.add(split.folder);
            conflicts.push({
              libraryRelativePath: claim.libraryRelativePath,
              storedId: result.decision.storedId,
              storedSource: result.decision.storedSource,
              providerId: result.decision.tmdbId,
              source: result.decision.source,
              title: claim.title,
              year: claim.year,
            });
            break;
          case 'missing-folder':
            totals.providerOnly++;
            providerOnly.push(providerOnlyRow(claim));
            break;
          case 'nested-path':
            totals.nested++;
            providerOnly.push({ ...providerOnlyRow(claim), nested: true });
            break;
          default:
            totals.errors++;
            errors.push({ libraryRelativePath: claim.libraryRelativePath, error: result.error });
        }
      }))
    );

    for (const folder of foldersOnDisk) {
      if (covered && !claimedFolders.has(folder) && !index.has(`${LIBRARY_ROOTS[mediaType]}/${folder}`)) {
        totals.unmanaged++;
        unmanaged.push(`${LIBRARY_ROOTS[mediaType]}/${folder}`);
      }
    }
  }

  const report = {
    at: new Date(started).toISOString(),
    reason,
    durationMs: Date.now() - started,
    unsourcedPinTreatment,
    index: index.summary(),
    perType,
    totals,
    written: capped(written, listCap),
    conflicts: capped(conflicts, listCap),
    providerOnly: capped(providerOnly, listCap),
    unmanaged: capped(unmanaged.sort(), listCap),
    providerConflicts: capped(index.providerConflicts, listCap),
    errors: capped(errors, listCap),
  };

  if (logger) {
    logger.info('identity reconcile: done', {
      'identity.reason': reason,
      'identity.duration_ms': report.durationMs,
      'identity.claimed': totals.claimed,
      'identity.written': totals.write,
      'identity.stamped': totals.stamp,
      'identity.kept': totals.keep,
      'identity.conflicts': totals.conflict,
      'identity.provider_only': totals.providerOnly,
      'identity.unmanaged': totals.unmanaged,
      'identity.errors': totals.errors,
    });
    for (const entry of written) {
      logger.info(
        `identity reconcile: ${entry.replacedId ? 'replaced' : 'pinned'} ${entry.libraryRelativePath} → ${entry.tmdbId} (${entry.source})` +
        (entry.replacedId ? ` (was ${entry.replacedId}, ${entry.replacedSource})` : '')
      );
    }
    for (const entry of conflicts.slice(0, listCap)) {
      logger.warn(
        `identity reconcile: CONFLICT ${entry.libraryRelativePath}: manual pin ${entry.storedId} vs ${entry.source} ${entry.providerId}` +
        (entry.title ? ` ("${entry.title}"${entry.year ? ` ${entry.year}` : ''})` : '')
      );
    }
  }

  return report;
}
