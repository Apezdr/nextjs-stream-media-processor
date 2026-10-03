// components/media-scanner/domain/video-sources.mjs
//
// Turns the video files in a media folder into the `sources[]` array that the
// payload publishes: one self-describing entry per file, so a consumer can pick
// between a 4K HDR remux and a 1080p mp4 without reverse-engineering capability
// from a file extension.
//
// Before this, a title had exactly one video and it had to be an .mp4; every
// other container was discarded at the discovery filter, which is why an
// .mkv-only title reached the database as an empty, video-less row.
//
// ORDERING IS A HARD CONTRACT, not a presentation detail. `movies.urls` is
// folded wholesale into the movie hash (see sqlite/metadataHashes.mjs), so a
// readdir-order-dependent array would make that hash flap between scans on some
// filesystems and force a permanent resync loop. The order here comes from
// listVideoFiles, which sorts by VIDEO_EXTENSIONS priority then by name.

import { promises as fs } from 'fs';
import { join, extname } from 'path';
import { createCategoryLogger } from '../../../lib/logger.mjs';
import { getInfo } from '../../../infoManager.mjs';
import { isJitEligibilityEnabled } from '../../../lib/payloadVersion.mjs';
import { jitPathKey, jitMasterUrl, isJitUrlConfigured } from '../../../utils/jitUrl.mjs';
import { evaluateJitEligibility, isJitAddressableContainer } from './jit-eligibility.mjs';
import { compareSourceQuality } from '../../../utils/sourceQuality.mjs';

const logger = createCategoryLogger('video-sources');

/**
 * Distinct, sorted, strict language codes across a file's audio tracks.
 *
 * Reads `languageTag`, never `language`: the latter falls back to the stream
 * title, so it holds things like "Director Commentary" and counting distinct
 * values would report almost every multi-track file as multi-language. See
 * infoManager.mjs.
 *
 * @param {object|undefined} additionalMetadata
 * @returns {string[]}
 */
export function audioLanguagesOf(additionalMetadata) {
  const tracks = additionalMetadata?.audio;
  if (!Array.isArray(tracks)) return [];
  return [...new Set(tracks.map(t => t?.languageTag).filter(Boolean))].sort();
}

/**
 * Build the `sources[]` array for one media folder.
 *
 * @param {Object} params
 * @param {string[]} params.videoFiles  - Basenames, ALREADY ordered (listVideoFiles)
 * @param {string} params.dir           - Absolute directory holding them
 * @param {(filename: string) => string} params.urlFor - Builds the published URL
 * @param {string|null} [params.primaryFilename]
 *        The identity sidecar's pinned primary. Honoured when present in the
 *        folder and no managed file is; see pickPrimarySource.
 * @param {Set<string>|null} [params.managedFilenames]
 *        Basenames the library manager (Radarr/Sonarr) tracks for this title.
 *        null when there is no manager or it could not answer.
 * @param {string|null} [params.libraryRelativeDir]
 *        Directory path relative to BASE_PATH, e.g. 'movies/Dune (2021)'. Used
 *        to build the transcoder's path key. Omit to skip JIT emission.
 * @returns {Promise<{
 *   sources: Array<object>,
 *   primary: object|null,
 *   primaryReason: 'only'|'managed'|'pinned'|'quality'|null,
 *   fileLengths: Record<string, number>,
 *   fileDimensions: Record<string, string>
 * }>}
 */
export async function buildVideoSources({
  videoFiles,
  dir,
  urlFor,
  primaryFilename = null,
  managedFilenames = null,
  libraryRelativeDir = null,
}) {
  const sources = [];
  const fileLengths = {};
  const fileDimensions = {};

  // Read the toggles ONCE per folder, not per file: a scan must not straddle a
  // config change and emit a half-flipped payload.
  const hostEnabled = isJitEligibilityEnabled();
  const urlConfigured = isJitUrlConfigured();

  for (const filename of videoFiles) {
    const filePath = join(dir, filename);

    let info = null;
    try {
      info = await getInfo(filePath);
    } catch (error) {
      // A source we cannot probe is still a real, servable file — publish it
      // with null facts rather than dropping it from the payload entirely.
      logger.error(`Failed to retrieve info for ${filePath}: ${error}`);
    }

    let stat = null;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      logger.error(`Failed to stat ${filePath}: ${error}`);
    }

    const meta = info?.additionalMetadata;
    const video = Array.isArray(meta?.video) ? meta.video[0] : null;

    if (info?.length != null) fileLengths[filename] = parseInt(info.length, 10);
    if (info?.dimensions) fileDimensions[filename] = info.dimensions;

    const container = extname(filename).toLowerCase().replace(/^\./, '');
    const formatName = meta?.format?.formatName ?? null;
    const audioLanguages = audioLanguagesOf(meta);

    // audioLanguages is published below but deliberately NOT passed: since the
    // transcoder gained audio groups, the language count is no longer a policy
    // input. See jit-eligibility.mjs.
    const verdict = evaluateJitEligibility({
      container,
      formatName,
      videoCodec: video?.codec ?? null,
      hostEnabled,
    });

    // ADDRESSABILITY, not eligibility. The URL is emitted for every file the
    // transcoder can technically serve — even one the predicate does not
    // RECOMMEND. A multi-audio file keeps `jitEligible: false` and still gets a
    // URL, because the frontend's per-title "Always JIT" override is an admin
    // saying "I accept losing the second language" and it cannot conjure a
    // manifest URL the payload declined to carry. Nothing downstream may derive
    // one of these from the other; see docs/jit-url-addressability.md.
    //
    // hostEnabled still gates everything (rollback stays "flip the env var,
    // run one scan"), and urlConfigured is separate reach: a host can be
    // enabled without a public transcoder URL.
    const relPath = libraryRelativeDir ? `${libraryRelativeDir}/${filename}` : null;
    const emitJit = hostEnabled && urlConfigured && relPath && isJitAddressableContainer(container);

    sources.push({
      url: urlFor(filename),
      filename,
      container,
      formatName,
      size: stat ? stat.size : null,
      length: info?.length != null ? parseInt(info.length, 10) : null,
      dimensions: info?.dimensions || null,
      videoCodec: video?.codec ?? null,
      pixFmt: video?.pix_fmt ?? null,
      fieldOrder: video?.field_order ?? null,
      hdr: info?.hdr ?? null,
      audioTrackCount: Array.isArray(meta?.audio) ? meta.audio.length : 0,
      audioLanguages,
      // Stable-null discipline: a source whose stat failed contributes null,
      // never a fresh timestamp. A `new Date()` fallback here would move the
      // movie hash on every single regeneration.
      mediaLastModified: stat ? stat.mtime.toISOString() : null,
      uuid: info?.uuid ?? null,
      isPrimary: false,
      // RECOMMENDATION: routing this file through JIT costs the viewer nothing.
      // Not "servable" — jitUrl answers that, and the two legitimately disagree.
      jitEligible: verdict.eligible,
      // Why a source is NOT recommended, so this is diagnosable from the payload
      // instead of requiring a log dive. Null when it is. Doubles as the "what
      // you'd lose" label for the frontend's override UI.
      jitReason: verdict.eligible ? null : verdict.reason,
      jitKey: emitJit ? jitPathKey(relPath) : null,
      jitUrl: emitJit ? jitMasterUrl(relPath) : null,
      // Carried out of band for the scanner's own row fields; not published.
      _info: info,
    });
  }

  if (sources.length === 0) {
    return { sources: [], primary: null, primaryReason: null, fileLengths, fileDimensions };
  }

  const { source: primary, reason: primaryReason } =
    pickPrimarySource(sources, { primaryFilename, managedFilenames });
  primary.isPrimary = true;

  return { sources, primary, primaryReason, fileLengths, fileDimensions };
}

/**
 * Which source publishes as the title's primary (urls.mp4 / videoURL).
 *
 * 1. The file the library manager tracks. When Radarr or Sonarr upgrades a
 *    title and the old file stays on disk, the old file is a leftover; serving
 *    it is how Nobody kept playing a 1080p SDR copy beside a 4K remux.
 * 2. The identity sidecar's pin, so a title without a manager keeps its URL
 *    (watch history is keyed on it).
 * 3. The best file: HDR first, then resolution class. Ties keep the priority
 *    order (container, then name), so equal duplicates never flip.
 *
 * @param {Array<object>} sources  in priority order
 * @param {Object} options
 * @param {string|null} [options.primaryFilename]
 * @param {Set<string>|null} [options.managedFilenames]
 * @returns {{source: object, reason: 'only'|'managed'|'pinned'|'quality'}}
 */
export function pickPrimarySource(sources, { primaryFilename = null, managedFilenames = null } = {}) {
  if (sources.length === 1) return { source: sources[0], reason: 'only' };

  const managed = managedFilenames ? sources.find(s => managedFilenames.has(s.filename)) : null;
  if (managed) return { source: managed, reason: 'managed' };

  const pinned = primaryFilename ? sources.find(s => s.filename === primaryFilename) : null;
  if (pinned) return { source: pinned, reason: 'pinned' };

  let best = sources[0];
  for (const candidate of sources.slice(1)) {
    if (compareSourceQuality(candidate, best) > 0) best = candidate;
  }
  return { source: best, reason: 'quality' };
}

/**
 * Strip the out-of-band `_info` carrier before the array is published or hashed.
 *
 * @param {Array<object>} sources
 * @returns {Array<object>}
 */
export function publishableSources(sources) {
  return sources.map(({ _info, ...rest }) => rest);
}
