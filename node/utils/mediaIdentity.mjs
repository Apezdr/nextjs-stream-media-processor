// utils/mediaIdentity.mjs
//
// Stable identity for a piece of content — the key watch history joins on.
//
// The design has exactly two constraints, and they rule out everything else:
//
//   1. It must survive a database refresh. An infra event must never orphan a
//      user's progress, so SQLite cannot be the source of truth.
//   2. It must not depend on a service the operator may not have configured.
//      tmdb.config is optional, so TMDB cannot be the anchor.
//
// What is left is the media volume itself — the only store whose loss is
// unrecoverable anyway, and the one this repo already uses for per-title state
// (.info, tmdb.config, metadata.json).
//
// So the id is DERIVED from the library-relative folder path, then PERSISTED to
// a sidecar beside the media. Derivation makes it self-healing: delete the
// sidecar and it comes back identical. Persistence makes it rename-proof: the
// sidecar moves with the folder, so a rename does not repoint identity the way
// pure path-derivation would.
//
//   | Change                                   | Survives |
//   |------------------------------------------|----------|
//   | Remux .mkv -> .mp4, re-encode in place   | yes — identity is folder-level
//   | Add / remove a container                 | yes
//   | Episode file rename                      | yes — episode id is showId + s##e##
//   | DB drop / rebuild / refresh              | yes — sidecars are read back
//   | Folder rename                            | yes — the sidecar travels with it
//   | Sidecar deleted, folder unchanged        | yes — re-derives identically
//   | Sidecar deleted AND folder renamed       | NO  — the one accepted gap
//   | TMDB re-points, or was never configured  | yes — no TMDB dependency
//
// The folder is the unit of content, so a Theatrical cut and a Director's cut
// in separate folders correctly keep separate resume positions.
//
// The same sidecar is also the durable answer to "when did this enter the
// library": `firstSeen` for the folder, plus an `episodes` map (s##e## ->
// timestamp) for a show, because episodes have no sidecar of their own. Both are
// published as mediaIdentity.firstSeen and both follow the primarySource rule —
// SEEDED ONCE, NEVER RECOMPUTED. That is the entire point: a file's mtime moves
// on a quality upgrade and is preserved-old on many downloads, so it cannot rank
// "recently added". A date pinned at first sight, and immune to everything that
// later happens to the file, can.
//
//   | Change                                   | firstSeen |
//   |------------------------------------------|-----------|
//   | File replaced / upgraded / re-encoded    | unchanged
//   | Episode file renamed                     | unchanged — keyed by coordinate
//   | New episode added to an existing show    | new key dated now; siblings and show unchanged
//   | Episode deleted, later restored          | unchanged — keys are never removed
//   | Sidecar deleted                          | restored from the SQLite-cached date (firstSeenHint)
//   | Sidecar unwritable / unreadable          | published as null, never a per-pass "now"

import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { createCategoryLogger } from '../lib/logger.mjs';

const logger = createCategoryLogger('media-identity');

export const IDENTITY_SIDECAR = '.mediaid.json';
export const IDENTITY_SIDECAR_VERSION = 1;
export const IDENTITY_PREFIX = 'mid:';

/**
 * Derive the id for a library-relative path.
 *
 * Separators are normalised to '/' so a Windows scanner and a Linux scanner
 * derive the SAME id for the same title — this repo runs on both, and an id
 * that differed by platform would fork watch history on a host migration.
 *
 * @param {string} libraryRelativePath - e.g. 'movies/Dune (2021)' or 'tv/Breaking Bad'
 * @returns {string} 'mid:' + 16 hex chars
 */
export function deriveMediaId(libraryRelativePath) {
  const normalized = String(libraryRelativePath).replace(/\\/g, '/').replace(/\/+$/, '');
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `${IDENTITY_PREFIX}${digest.slice(0, 16)}`;
}

/**
 * Episode id: the show's id plus the season/episode coordinate.
 *
 * Deliberately NOT derived from the episode's filename — filenames change on
 * remux and re-release, and an episode's identity should not.
 *
 * @param {string} showId - The show folder's media id
 * @param {string|number} season
 * @param {string|number} episode
 * @returns {string} e.g. 'mid:3e88b1049fc7a2d1:s01e03'
 */
export function episodeMediaId(showId, season, episode) {
  const ss = String(parseInt(season, 10)).padStart(2, '0');
  const ee = String(parseInt(episode, 10)).padStart(2, '0');
  return `${showId}:s${ss}e${ee}`;
}

/**
 * Recover the on-disk basename from a published media URL.
 *
 * Used to seed primarySource from a row's already-stored URL, so a title keeps
 * publishing the same file it published before this ran. Round-trips exactly:
 * the URLs are built with encodeURIComponent over the basename, so decoding the
 * last path segment returns the original name.
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function filenameFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const withoutQuery = url.split('?')[0];
  const segment = withoutQuery.split('/').pop();
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isValidSidecar(data) {
  return (
    data &&
    typeof data === 'object' &&
    data.v === IDENTITY_SIDECAR_VERSION &&
    typeof data.id === 'string' &&
    data.id.startsWith(IDENTITY_PREFIX)
  );
}

/**
 * Read the identity sidecar from a media folder.
 *
 * @param {string} dir - Absolute path to the movie or show folder
 * @returns {Promise<{data: object|null, unreadable: boolean}>}
 *   `unreadable` distinguishes "no sidecar yet" (normal, we write one) from
 *   "a sidecar exists but we cannot trust it" (we must NOT overwrite it).
 */
export async function readIdentitySidecar(dir) {
  const path = join(dir, IDENTITY_SIDECAR);
  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { data: null, unreadable: false };
    logger.warn(`identity sidecar unreadable at ${path}: ${err.code || err.message}`);
    return { data: null, unreadable: true };
  }

  try {
    const data = JSON.parse(raw);
    if (!isValidSidecar(data)) {
      logger.warn(
        `identity sidecar unreadable at ${path}: unexpected shape or version (v=${data?.v})`
      );
      return { data: null, unreadable: true };
    }
    return { data, unreadable: false };
  } catch (err) {
    logger.warn(`identity sidecar unreadable at ${path}: ${err.message}`);
    return { data: null, unreadable: true };
  }
}

/**
 * Write the identity sidecar. Best-effort by design.
 *
 * A read-only or failing media volume must not fail a scan — the derived id is
 * still correct for an unrenamed folder, so we log and carry on rather than
 * making identity depend on write access.
 *
 * @returns {Promise<boolean>} whether the write landed
 */
async function writeIdentitySidecar(dir, data) {
  const path = join(dir, IDENTITY_SIDECAR);
  try {
    await fs.writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    logger.warn(`identity sidecar write failed at ${path}: ${err.code || err.message}`);
    return false;
  }
}

/**
 * Resolve the identity of a media folder, establishing it if absent.
 *
 * @param {Object} params
 * @param {string} params.dir                   - Absolute folder path
 * @param {string} params.libraryRelativePath   - e.g. 'movies/Dune (2021)'
 * @param {string|null} [params.primarySourceHint]
 *        Filename to record as the primary source when establishing identity.
 *        Seeded from the row's ALREADY-STORED url so existing titles keep
 *        publishing the same URL — see the note below.
 * @param {string|null} [params.firstSeenHint]
 *        A previously published first-seen timestamp (the SQLite cache of this
 *        sidecar). Used ONLY when a sidecar has to be established or is missing
 *        its firstSeen, so a deleted sidecar self-heals to the date consumers
 *        already hold instead of re-dating the title to "now".
 * @param {string} [params.now] - ISO timestamp (injectable for tests)
 * @returns {Promise<{id: string, firstSeen: string, durableFirstSeen: string|null,
 *                    primarySource: string|null, episodes: Object<string,string>,
 *                    origin: 'sidecar'|'established'|'derived-unwritable'}>}
 *   `durableFirstSeen` is the first-seen timestamp ONLY when it is known to be
 *   on disk. It is what gets PUBLISHED: the value is folded into the metadata
 *   hash, so a per-pass `now` from a folder whose sidecar cannot be written
 *   would move that hash on every rebuild. Stable null beats a flapping date.
 *   `episodes` is the per-episode first-seen map (see episodeSeenKey).
 */
export async function resolveMediaIdentity({
  dir,
  libraryRelativePath,
  primarySourceHint = null,
  firstSeenHint = null,
  now = new Date().toISOString(),
}) {
  const derivedId = deriveMediaId(libraryRelativePath);
  const { data, unreadable } = await readIdentitySidecar(dir);
  const seededFirstSeen = isIsoTimestamp(firstSeenHint) ? firstSeenHint : now;

  if (data) {
    // Honour the stored id. This is what makes a rename survivable, and it is
    // why the id is NEVER recomputed once written.
    //
    // primarySource is only filled in when it is missing — the plan's rule is
    // "seeded once, never recomputed". Rewriting it whenever the priority order
    // would pick differently is exactly how a title's published URL, and with
    // it the legacy watch-history key, would drift. firstSeen follows the same
    // rule: backfilled once when absent, never moved afterwards.
    const needsPrimarySource = !data.primarySource && primarySourceHint;
    const needsFirstSeen = !isIsoTimestamp(data.firstSeen);

    if (needsPrimarySource || needsFirstSeen) {
      const updated = {
        ...data,
        ...(needsPrimarySource ? { primarySource: primarySourceHint } : {}),
        ...(needsFirstSeen ? { firstSeen: seededFirstSeen } : {}),
      };
      const wrote = await writeIdentitySidecar(dir, updated);
      return {
        id: updated.id,
        firstSeen: updated.firstSeen,
        durableFirstSeen: needsFirstSeen && !wrote ? null : updated.firstSeen,
        primarySource: updated.primarySource ?? null,
        episodes: episodeSeenMapOf(updated),
        origin: 'sidecar',
      };
    }

    return {
      id: data.id,
      firstSeen: data.firstSeen,
      durableFirstSeen: data.firstSeen,
      primarySource: data.primarySource ?? null,
      episodes: episodeSeenMapOf(data),
      origin: 'sidecar',
    };
  }

  // A sidecar that exists but cannot be trusted is NOT overwritten — the file
  // may be recoverable, and clobbering it would destroy the only durable copy
  // of an id that watch history depends on. Derive for this pass instead.
  if (unreadable) {
    return {
      id: derivedId,
      firstSeen: now,
      durableFirstSeen: null,
      primarySource: primarySourceHint,
      episodes: {},
      origin: 'derived-unwritable',
    };
  }

  const fresh = {
    v: IDENTITY_SIDECAR_VERSION,
    id: derivedId,
    derivedFrom: String(libraryRelativePath).replace(/\\/g, '/'),
    primarySource: primarySourceHint,
    firstSeen: seededFirstSeen,
    previousIds: [],
  };

  const wrote = await writeIdentitySidecar(dir, fresh);
  if (wrote) {
    logger.info(`identity established for ${fresh.derivedFrom}: ${derivedId}`);
  }

  return {
    id: derivedId,
    firstSeen: seededFirstSeen,
    durableFirstSeen: wrote ? seededFirstSeen : null,
    primarySource: primarySourceHint,
    episodes: {},
    origin: wrote ? 'established' : 'derived-unwritable',
  };
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function episodeSeenMapOf(data) {
  const map = data?.episodes;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  return Object.fromEntries(Object.entries(map).filter(([, v]) => isIsoTimestamp(v)));
}

/**
 * Key of one episode inside a show sidecar's `episodes` first-seen map.
 *
 * The same coordinate the episode id uses, so the map and the id can never
 * disagree about which episode they describe.
 *
 * @returns {string} e.g. 's01e03'
 */
export function episodeSeenKey(season, episode) {
  const ss = String(parseInt(season, 10)).padStart(2, '0');
  const ee = String(parseInt(episode, 10)).padStart(2, '0');
  return `s${ss}e${ee}`;
}

/**
 * Persist newly observed episodes into a show sidecar's first-seen map.
 *
 * Episodes have no sidecar of their own, so "when did this episode enter the
 * library" lives beside the show's identity. Same discipline as primarySource:
 * SEEDED ONCE, NEVER RECOMPUTED — an existing key is never overwritten, and a
 * key is never removed (a deleted-then-restored episode keeps its date).
 *
 * @param {Object} params
 * @param {string} params.dir - Absolute show folder path
 * @param {Object<string,string>} params.added - key (episodeSeenKey) -> ISO timestamp
 * @returns {Promise<boolean>} whether every added key is now on disk
 */
export async function recordEpisodesFirstSeen({ dir, added }) {
  const entries = Object.entries(added || {}).filter(([, v]) => isIsoTimestamp(v));
  if (entries.length === 0) return true;

  const { data } = await readIdentitySidecar(dir);
  // No trustworthy sidecar to extend (unreadable, or the establish write
  // failed). The caller must then publish null rather than an undurable date.
  if (!data) return false;

  const existing = episodeSeenMapOf(data);
  const merged = { ...existing };
  for (const [key, value] of entries) {
    if (!merged[key]) merged[key] = value;
  }
  if (Object.keys(merged).length === Object.keys(existing).length) return true;

  // Sorted so the file is diff-stable regardless of scan concurrency order.
  const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
  return writeIdentitySidecar(dir, { ...data, episodes: sorted });
}

/**
 * Re-point a folder's identity to a freshly derived id.
 *
 * Used when a folder is found carrying an id another folder already owns — the
 * usual cause is a copied folder bringing a cloned sidecar with it. The
 * displaced id is recorded in previousIds so the change is auditable and the
 * frontend can re-join history if it needs to.
 *
 * @returns {Promise<string>} the new id
 */
export async function repointMediaIdentity({ dir, libraryRelativePath, now = new Date().toISOString() }) {
  const { data } = await readIdentitySidecar(dir);
  const newId = deriveMediaId(libraryRelativePath);

  const previousIds = Array.isArray(data?.previousIds) ? [...data.previousIds] : [];
  if (data?.id && data.id !== newId && !previousIds.includes(data.id)) {
    previousIds.push(data.id);
  }

  await writeIdentitySidecar(dir, {
    v: IDENTITY_SIDECAR_VERSION,
    id: newId,
    derivedFrom: String(libraryRelativePath).replace(/\\/g, '/'),
    primarySource: data?.primarySource ?? null,
    firstSeen: data?.firstSeen ?? now,
    previousIds,
    // A repoint changes WHICH id the folder answers to, not when its episodes
    // entered the library — dropping the map here would re-date every episode.
    ...(Object.keys(episodeSeenMapOf(data)).length > 0 ? { episodes: episodeSeenMapOf(data) } : {}),
  });

  return newId;
}
