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
import { evaluateJitEligibility } from './jit-eligibility.mjs';

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
 *        folder; otherwise the first file in priority order wins.
 * @param {string|null} [params.libraryRelativeDir]
 *        Directory path relative to BASE_PATH, e.g. 'movies/Dune (2021)'. Used
 *        to build the transcoder's path key. Omit to skip JIT emission.
 * @returns {Promise<{
 *   sources: Array<object>,
 *   primary: object|null,
 *   fileLengths: Record<string, number>,
 *   fileDimensions: Record<string, string>
 * }>}
 */
export async function buildVideoSources({
  videoFiles,
  dir,
  urlFor,
  primaryFilename = null,
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

    const verdict = evaluateJitEligibility({
      container,
      formatName,
      videoCodec: video?.codec ?? null,
      audioLanguages,
      hostEnabled,
    });

    // The URL is only emitted for a file the transcoder can actually serve, and
    // only when a public transcoder URL is configured. Eligibility and reach
    // are separate concerns: a host can be enabled without one.
    const relPath = libraryRelativeDir ? `${libraryRelativeDir}/${filename}` : null;
    const emitJit = verdict.eligible && urlConfigured && relPath;

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
      jitEligible: verdict.eligible,
      // Why a source is NOT eligible, so this is diagnosable from the payload
      // instead of requiring a log dive. Null when it is.
      jitReason: verdict.eligible ? null : verdict.reason,
      jitKey: emitJit ? jitPathKey(relPath) : null,
      jitUrl: emitJit ? jitMasterUrl(relPath) : null,
      // Carried out of band for the scanner's own row fields; not published.
      _info: info,
    });
  }

  if (sources.length === 0) {
    return { sources: [], primary: null, fileLengths, fileDimensions };
  }

  const primary =
    (primaryFilename && sources.find(s => s.filename === primaryFilename)) || sources[0];
  primary.isPrimary = true;

  return { sources, primary, fileLengths, fileDimensions };
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
