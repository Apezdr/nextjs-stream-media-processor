// ffmpeg/clipEncode.mjs
//
// How a /videoClip file is produced. There are two kinds, and both are MP4 with
// the index at the front (faststart), because that is the one container every
// client of this endpoint plays: desktop browsers, Safari on an iPhone,
// ExoPlayer on Android TV and AVPlayer on Apple TV.
//
//   transcode  H.264 High, 8-bit 4:2:0, AAC stereo, fitted inside 1280x720 (or
//              854x480 at the lowest quality level; see CLIP_QUALITIES).
//              ONE ffmpeg pass seeks, decodes and encodes, so the clip starts on
//              the requested frame with audio and video together. HDR and Dolby
//              Vision are tone-mapped to BT.709. Every browser gets this one.
//
//   original   The source's own video stream, copied (H.264 / HEVC only), with
//              the audio re-encoded to AAC stereo. A copy can only begin on a
//              keyframe, so it begins on the last one at or before the requested
//              time. The TV app asks for this one (?useOriginalVideo=true).
//
// The argument builders are pure, so the exact command lines are unit-tested.
// Both were run against production titles on 2026-10-04: a 1080p AVC remux,
// 2160p HDR10 (WEB-DL and remux), Dolby Vision Profile 5, and a UHD remux with
// DTS:X audio.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { createCategoryLogger } from '../lib/logger.mjs';
import { executeFFmpeg } from './ffmpeg.mjs';
import { withClipGenerationSpan } from './videoTracer.mjs';
import {
  doviReshapeRequired,
  doviReshapeFilter,
  libplaceboAvailable,
  DOVI_RESHAPE_INPUT_ARGS,
} from './dolbyVision.mjs';

const execFileAsync = promisify(execFile);
const logger = createCategoryLogger('clip-encode');

/**
 * A clip is written under this suffix and renamed into place only once ffmpeg
 * has exited cleanly, so a cache file that exists is always a whole clip. Left
 * behind only if the process dies mid-encode; see sweepClipTempFiles.
 */
export const CLIP_TEMP_SUFFIX = '.part';

/** A copy needs a keyframe near the start; beyond this the source is odd enough to transcode instead. */
const MAX_KEYFRAME_LEAD_SECONDS = 30;

/**
 * How far past a keyframe the copy seeks, in seconds.
 *
 * ffmpeg moves an input seek back by 3/23 s (0.1304) when the container seeks
 * by DTS and the video has B-frames. Matroska does; MP4 seeks by PTS and is not
 * moved. Seeking to the keyframe's own time therefore lands a whole GOP early
 * in an MKV (measured: 2.0 s early on a 2 s GOP). A quarter second past it
 * lands on that keyframe in both, with room for millisecond rounding. If
 * another keyframe sits inside the margin the copy starts there instead, a
 * fraction of a second later, which is just as good a place to start.
 */
const KEYFRAME_SEEK_MARGIN_SECONDS = 0.25;

const HDR_TRANSFERS = Object.freeze({ smpte2084: 'pq', 'arib-std-b67': 'hlg' });
const UNSET_COLOR_TAGS = new Set(['', 'unknown', 'unspecified', 'reserved']);

/** Video the original path may copy: what a hardware decoder on a TV or phone accepts. */
const COPYABLE_PIXEL_FORMATS = Object.freeze({
  h264: new Set(['yuv420p', 'yuvj420p']),
  hevc: new Set(['yuv420p', 'yuvj420p', 'yuv420p10le']),
});

/**
 * How much picture a transcoded clip carries, chosen with `?quality=`.
 *
 * Named levels rather than encoder numbers, so a URL keeps meaning the same
 * thing if the encoder behind it changes. Each level is a box the picture is
 * fitted inside, an x264 quality target with a bitrate ceiling, and an audio
 * bitrate. Measured on three 20 s samples from the production library (clean
 * digital, dark, grainy film), video only:
 *
 *   high    987 / 221 / 2011 kb/s   the default
 *   medium  476 / 106 / 1203 kb/s   about half of high
 *   low     206 /  46 /  608 kb/s   about a fifth of high, at 480p
 *
 * For scale, the hardware VP9 clips this endpoint used to make came out at
 * 509 / 331 / 517 kb/s on the same samples.
 *
 * Changing a level's numbers changes the bytes of clips already in the cache
 * under that name: bump VIDEO_CLIP_VERSION in videoHandler.mjs when you do.
 */
export const CLIP_QUALITIES = Object.freeze({
  high: Object.freeze({ width: 1280, height: 720, crf: 23, maxrate: '2M', bufsize: '4M', audioBitrate: '128k' }),
  medium: Object.freeze({ width: 1280, height: 720, crf: 28, maxrate: '1200k', bufsize: '2400k', audioBitrate: '96k' }),
  low: Object.freeze({ width: 854, height: 480, crf: 30, maxrate: '600k', bufsize: '1200k', audioBitrate: '64k' }),
});

/** The level a request gets when it does not ask for one. */
export const DEFAULT_CLIP_QUALITY = 'high';

/** Every value `?quality=` accepts, for error messages and docs. */
export const CLIP_QUALITY_VALUES = Object.freeze(Object.keys(CLIP_QUALITIES));

/**
 * Parse `?quality=`. Absent or empty is the default level; a known level, in
 * any case, is itself; anything else (a repeated parameter included, which
 * Express hands over as an array) is null, for the caller to reject rather
 * than quietly serve a level nobody asked for.
 *
 * @param {unknown} param - req.query.quality
 * @returns {keyof typeof CLIP_QUALITIES | null}
 */
export function resolveClipQuality(param) {
  if (param === undefined || param === '') return DEFAULT_CLIP_QUALITY;
  if (typeof param !== 'string') return null;
  const value = param.trim().toLowerCase();
  return Object.hasOwn(CLIP_QUALITIES, value) ? value : null;
}

// The picture fits inside the level's box and is never enlarged; libx264 needs even sides.
const fitWidth = (level) => `'min(${level.width},iw)'`;
const fitHeight = (level) => `'min(${level.height},ih)'`;
const FIT_FLAGS = 'force_original_aspect_ratio=decrease:force_divisible_by=2';

const QUIET_FLAGS = Object.freeze(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']);

// First real video stream (`V` skips cover art), first audio stream if there is
// one, and nothing else: subtitles, data tracks, chapters and global tags would
// each add a track or box that a strict player has to cope with.
const STREAM_SELECTION = Object.freeze([
  '-map', '0:V:0',
  '-map', '0:a:0?',
  '-sn', '-dn',
  '-map_chapters', '-1',
  '-map_metadata', '-1',
]);

// libx264 rather than a hardware encoder: the same bitstream on every
// deployment, and on the production host (72 threads) the encode is not the
// slow part — software decode of the source is.
//   subme=1   measured there on a 50 s 1080p clip: 12.1 s with veryfast's
//             default of 2, 5.1 s with 1, for a file within 3% of the same
//             size. More encoder threads did not close that gap.
//   crf with a bitrate ceiling (both from the quality level): at the default
//             level a 50 s clip stays under ~13 MB however grainy the film.
//   -g 48     a keyframe at least every 2 s at film rates.
const h264Args = (level) => [
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-x264-params', 'subme=1',
  '-crf', String(level.crf),
  '-maxrate', level.maxrate,
  '-bufsize', level.bufsize,
  '-profile:v', 'high',
  '-pix_fmt', 'yuv420p',
  '-g', '48',
];

// Only for a tone-mapped clip, where the output is BT.709 by construction. An
// SDR source keeps whatever tags it came with (an SD title is BT.601, and
// stamping it BT.709 would shift its colors).
const BT709_TAGS = Object.freeze([
  '-colorspace', 'bt709',
  '-color_primaries', 'bt709',
  '-color_trc', 'bt709',
  '-color_range', 'tv',
]);

const MP4_OUTPUT_FLAGS = Object.freeze([
  '-max_muxing_queue_size', '9999',
  '-movflags', '+faststart',
  '-f', 'mp4', // the temp file's extension says nothing, so name the muxer
]);

/** Stamp frames as BT.2020 with the given transfer, for a source whose own tags are missing or partial. */
const bt2020Tags = (transfer) =>
  `setparams=color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc`;

const aacArgs = (bitrate) => ['-c:a', 'aac', '-b:a', bitrate, '-ac', '2', '-ar', '48000'];

/** Seconds as ffmpeg takes them: at most millisecond precision, no float noise. */
const seconds = (value) => String(Number(value.toFixed(3)));

/** Thrown when a source cannot be stream-copied after all; the caller transcodes instead. */
export class ClipNotCopyableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClipNotCopyableError';
  }
}

/**
 * What the clip builders need to know about a source.
 * @typedef {Object} ClipSource
 * @property {string} codec       - Video codec name ('h264', 'hevc', ...)
 * @property {string} pixFmt      - Video pixel format ('yuv420p10le', ...)
 * @property {'sdr'|'pq'|'hlg'} transfer
 * @property {boolean} assumedPq  - BT.2020 with no transfer tag, read as PQ
 * @property {boolean} wideGamut  - BT.2020 primaries with an SDR transfer
 * @property {boolean} dovi       - Dolby Vision whose RPU must be applied (Profile 5)
 * @property {number|null} duration - Container duration in seconds, when it has one
 * @property {number} startTime   - Timestamp the container starts at, in seconds.
 *   Usually 0, but not always (an audio track that leads the video makes it
 *   slightly negative). A clip's `start` counts from here.
 */

/**
 * Reduce `ffprobe -show_streams -show_format` output to a {@link ClipSource}.
 * The video stream is the one `-map 0:V:0` selects: the first that is not
 * cover art.
 *
 * @param {object} probe - Parsed ffprobe JSON
 * @returns {ClipSource|null} null when the file has no video stream
 */
export function describeClipSource(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find(
    (stream) =>
      stream.codec_type === 'video' &&
      !stream.disposition?.attached_pic &&
      !stream.disposition?.timed_thumbnails
  );
  if (!video) return null;

  const tag = (value) => String(value ?? '').toLowerCase();
  const transferTag = tag(video.color_transfer);
  const bt2020 = tag(video.color_primaries) === 'bt2020' || tag(video.color_space).startsWith('bt2020');

  // A BT.2020 stream whose transfer was never tagged is HDR10 with a careless
  // mux far more often than it is anything else, so it is read as PQ. A
  // transfer that IS tagged is believed, whatever it says.
  const assumedPq = bt2020 && UNSET_COLOR_TAGS.has(transferTag);
  const transfer = HDR_TRANSFERS[transferTag] ?? (assumedPq ? 'pq' : 'sdr');

  const duration = parseFloat(probe?.format?.duration);
  const startTime = parseFloat(probe?.format?.start_time);

  return {
    codec: tag(video.codec_name),
    pixFmt: tag(video.pix_fmt),
    transfer,
    assumedPq,
    wideGamut: bt2020 && transfer === 'sdr',
    dovi: doviReshapeRequired(video),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    // ffmpeg reads a missing start time as 0 too, so the two stay in step.
    startTime: Number.isFinite(startTime) ? startTime : 0,
  };
}

/**
 * ffprobe a source. No shell is involved: the path is a single argument,
 * whatever characters the filename holds.
 *
 * @param {string} videoPath
 * @returns {Promise<ClipSource>}
 */
export async function probeClipSource(videoPath) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', videoPath],
    { maxBuffer: 16 * 1024 * 1024 }
  );
  const source = describeClipSource(JSON.parse(stdout));
  if (!source) {
    throw new Error(`No video stream in ${videoPath}`);
  }
  return source;
}

/**
 * Which filter chain brings a source to 8-bit BT.709.
 *
 *   none        Already SDR BT.709 (or BT.601): scale only.
 *   libplacebo  HDR10, HLG, Dolby Vision Profile 5 or wide-gamut SDR, on a host
 *               with a working Vulkan device.
 *   zscale      HDR10 / HLG on a host without one (CPU tone-map).
 *
 * Without libplacebo, a Profile 5 source and a wide-gamut SDR source fall to
 * `none`: nothing else can apply an RPU, and dolbyVision.mjs has already warned
 * once that such frames keep their base-layer colors.
 *
 * @param {ClipSource} source
 * @param {{ libplacebo: boolean }} capabilities
 * @returns {'none'|'libplacebo'|'zscale'}
 */
export function selectColorPipeline(source, { libplacebo }) {
  const hdr = source.transfer !== 'sdr';
  if (!hdr && !source.dovi && !source.wideGamut) return 'none';
  if (libplacebo) return 'libplacebo';
  return hdr ? 'zscale' : 'none';
}

/**
 * The -vf for a transcoded clip: fit inside the quality level's box, 8-bit
 * 4:2:0, BT.709.
 *
 * @param {ClipSource} source
 * @param {'none'|'libplacebo'|'zscale'} pipeline
 * @param {keyof typeof CLIP_QUALITIES} [quality]
 * @returns {string}
 */
export function buildClipVideoFilter(source, pipeline, quality = DEFAULT_CLIP_QUALITY) {
  const level = CLIP_QUALITIES[quality];

  if (pipeline === 'libplacebo') {
    // Tone-map and scale in one GPU pass. The same filter (and so the same
    // look) as the stills and sprite sheets of a Dolby Vision title. It reads
    // the frame's own color tags, so only a source that has none needs telling.
    const toneMap = doviReshapeFilter({
      width: fitWidth(level),
      height: fitHeight(level),
      output: 'sdr',
      fitInside: true,
    });
    return source.assumedPq ? `${bt2020Tags('smpte2084')},${toneMap}` : toneMap;
  }

  const fit = `scale=w=${fitWidth(level)}:h=${fitHeight(level)}:${FIT_FLAGS}`;

  if (pipeline === 'zscale') {
    const transferIn = source.transfer === 'hlg' ? 'arib-std-b67' : 'smpte2084';
    return [
      // zscale takes the OUTPUT primaries of its first step from the frame's
      // tags. A source with any of them missing fails there ("no path between
      // colorspaces"), so the frames are tagged in full first.
      bt2020Tags(transferIn),
      // Scale before the float tone-map, so it runs on the small picture, not a 2160p one.
      fit,
      `zscale=tin=${transferIn}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100`,
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0:peak=100',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p',
    ].join(',');
  }

  return `${fit},format=yuv420p`;
}

/**
 * ffmpeg arguments for a transcoded clip. `-ss` before `-i` with a re-encode is
 * frame-accurate: ffmpeg decodes from the previous keyframe and discards up to
 * the requested time, so both streams start exactly there.
 *
 * @param {Object} params
 * @param {string} params.videoPath
 * @param {number} params.start     - Seconds into the source
 * @param {number} params.duration  - Seconds
 * @param {ClipSource} params.source
 * @param {'none'|'libplacebo'|'zscale'} params.pipeline
 * @param {keyof typeof CLIP_QUALITIES} [params.quality]
 * @param {string} params.outputPath
 * @returns {string[]}
 */
export function buildTranscodeArgs({
  videoPath,
  start,
  duration,
  source,
  pipeline,
  quality = DEFAULT_CLIP_QUALITY,
  outputPath,
}) {
  const level = CLIP_QUALITIES[quality];
  return [
    ...QUIET_FLAGS,
    ...(pipeline === 'libplacebo' ? DOVI_RESHAPE_INPUT_ARGS : []),
    '-ss', seconds(start),
    '-i', videoPath,
    '-t', seconds(duration),
    ...STREAM_SELECTION,
    '-vf', buildClipVideoFilter(source, pipeline, quality),
    ...h264Args(level),
    ...(pipeline === 'none' ? [] : BT709_TAGS),
    ...aacArgs(level.audioBitrate),
    ...MP4_OUTPUT_FLAGS,
    outputPath,
  ];
}

/**
 * Whether the original path may copy this source's video stream. Anything else
 * (AV1, VP9, 10-bit H.264, 4:2:2, Dolby Vision that needs its RPU) gets the
 * transcode, which every device plays.
 *
 * @param {ClipSource} source
 * @returns {boolean}
 */
export function canCopyOriginal(source) {
  return !source.dovi && COPYABLE_PIXEL_FORMATS[source.codec]?.has(source.pixFmt) === true;
}

/**
 * Where a stream copy seeks to and how long it runs, given the keyframe the
 * source has at or before the requested start.
 *
 * Both results are on the container's own timeline (what ffprobe reports and
 * what `-seek_timestamp 1` seeks by), which is the clip's `start` plus the
 * container's start time.
 *
 * The copy covers [keyframe, start + duration]. It seeks just past the keyframe
 * (see KEYFRAME_SEEK_MARGIN_SECONDS) with -noaccurate_seek, so the copied video
 * and the re-encoded audio both begin at the keyframe; an accurate seek would
 * trim only the audio and leave it starting late.
 *
 * @param {Object} params
 * @param {number} params.start        - Seconds from the start of the source
 * @param {number} params.duration
 * @param {number} params.startTime    - ClipSource.startTime
 * @param {number|null} params.keyframeTime - From probeKeyframeAtOrBefore
 * @returns {{ seekTo: number, length: number }|null} null when the keyframe is unusable
 */
export function planOriginalCopy({ start, duration, startTime, keyframeTime }) {
  if (keyframeTime === null || !Number.isFinite(keyframeTime)) return null;

  // A first keyframe a moment after the start is normal (B-frame delay); one
  // further away than a second, or a GOP longer than the limit, is not.
  const requested = startTime + start;
  const lead = requested - keyframeTime;
  if (lead < -1 || lead > MAX_KEYFRAME_LEAD_SECONDS) return null;

  const seekTo = keyframeTime + KEYFRAME_SEEK_MARGIN_SECONDS;
  const length = requested + duration - seekTo;
  return length > 0 ? { seekTo, length } : null;
}

/**
 * ffmpeg arguments for an original-quality clip.
 *
 * `-t` sits before `-i`: an input limit ends the copied video at the requested
 * end. HEVC is tagged `hvc1` because AVFoundation does not open `hev1`. The
 * audio is always AAC stereo: a source's best track is often DTS or TrueHD,
 * which neither AVPlayer nor most TVs decode.
 *
 * @param {Object} params
 * @param {string} params.videoPath
 * @param {ClipSource} params.source
 * @param {{ seekTo: number, length: number }} params.plan - From planOriginalCopy
 * @param {string} params.outputPath
 * @returns {string[]}
 */
export function buildOriginalArgs({ videoPath, source, plan, outputPath }) {
  return [
    ...QUIET_FLAGS,
    '-seek_timestamp', '1', // -ss is a timestamp in the file, as ffprobe reported the keyframe
    '-noaccurate_seek',
    '-ss', seconds(plan.seekTo),
    '-t', seconds(plan.length),
    '-i', videoPath,
    ...STREAM_SELECTION,
    '-c:v', 'copy',
    ...(source.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    ...aacArgs('192k'),
    '-avoid_negative_ts', 'make_zero',
    ...MP4_OUTPUT_FLAGS,
    outputPath,
  ];
}

/**
 * The presentation time of the keyframe a seek to `time` lands on: the last one
 * at or before it. Both are timestamps in the file (see ClipSource.startTime),
 * not seconds from its start.
 *
 * @param {string} videoPath
 * @param {number} time - Timestamp in seconds
 * @returns {Promise<number|null>} null when ffprobe reports no frame
 */
export async function probeKeyframeAtOrBefore(videoPath, time) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'V:0',
    '-skip_frame', 'nokey',
    '-show_entries', 'frame=pts_time',
    '-of', 'csv=p=0',
    '-read_intervals', `${seconds(time)}%+#1`,
    videoPath,
  ]);
  const keyframeTime = parseFloat(stdout);
  return Number.isFinite(keyframeTime) ? keyframeTime : null;
}

// Backstops for an ffmpeg that stops making progress (a stalled mount, a hung
// GPU). Generous: a 2160p remux decodes at about real time on the production
// host, and a host without a GPU tone-maps on the CPU.
const transcodeTimeoutMs = (duration) => (120 + duration * 10) * 1000;
const copyTimeoutMs = (duration) => (60 + duration * 2) * 1000;

/**
 * Run ffmpeg into a temp file beside the destination and move it into place
 * only if it exits cleanly with something in it. The rename is atomic, so a
 * reader sees no file or the whole file, never a growing one.
 */
async function writeClipFile({ outputPath, buildArgs, timeoutMs, span }) {
  const tempPath = join(dirname(outputPath), `${randomUUID()}${CLIP_TEMP_SUFFIX}`);
  const args = buildArgs(tempPath);

  return withClipGenerationSpan({ ...span, outputPath }, async () => {
    const startedAt = Date.now();
    logger.info(`ffmpeg ${args.join(' ')}`);
    try {
      await executeFFmpeg(args, { timeout: timeoutMs, killSignal: 'SIGKILL' });
      const { size } = await fs.stat(tempPath);
      if (size === 0) {
        throw new Error('FFmpeg wrote an empty clip');
      }
      await fs.rename(tempPath, outputPath);
      logger.info(`Clip ready in ${Date.now() - startedAt} ms (${size} bytes): ${outputPath}`);
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
  });
}

/**
 * Encode the H.264 clip every browser gets.
 *
 * @param {Object} params
 * @param {string} params.videoPath
 * @param {number} params.start
 * @param {number} params.duration
 * @param {ClipSource} params.source
 * @param {keyof typeof CLIP_QUALITIES} [params.quality]
 * @param {string} params.outputPath - Final cache path
 * @returns {Promise<void>}
 */
export async function transcodeClip({
  videoPath,
  start,
  duration,
  source,
  quality = DEFAULT_CLIP_QUALITY,
  outputPath,
}) {
  // Probed only for a source that needs it; an SDR library never touches Vulkan.
  const wantsColorManagement = selectColorPipeline(source, { libplacebo: true }) === 'libplacebo';
  const libplacebo = wantsColorManagement && (await libplaceboAvailable());
  const pipeline = selectColorPipeline(source, { libplacebo });

  await writeClipFile({
    outputPath,
    buildArgs: (tempPath) =>
      buildTranscodeArgs({ videoPath, start, duration, source, pipeline, quality, outputPath: tempPath }),
    timeoutMs: transcodeTimeoutMs(duration),
    span: { inputPath: videoPath, startTime: start, duration, codec: `h264-${quality}` },
  });
}

/**
 * Copy the source's video stream into the original-quality clip.
 *
 * @param {Object} params
 * @param {string} params.videoPath
 * @param {number} params.start
 * @param {number} params.duration
 * @param {ClipSource} params.source - Must satisfy canCopyOriginal
 * @param {string} params.outputPath - Final cache path
 * @returns {Promise<void>}
 * @throws {ClipNotCopyableError} when the source has no usable keyframe near `start`
 */
export async function copyOriginalClip({ videoPath, start, duration, source, outputPath }) {
  const keyframeTime = await probeKeyframeAtOrBefore(videoPath, source.startTime + start);
  const plan = planOriginalCopy({ start, duration, startTime: source.startTime, keyframeTime });
  if (!plan) {
    throw new ClipNotCopyableError(
      `no usable keyframe at or before ${start}s (ffprobe reported ${keyframeTime})`
    );
  }

  await writeClipFile({
    outputPath,
    buildArgs: (tempPath) => buildOriginalArgs({ videoPath, source, plan, outputPath: tempPath }),
    timeoutMs: copyTimeoutMs(duration),
    span: { inputPath: videoPath, startTime: start, duration, codec: `copy-${source.codec}` },
  });
}

/**
 * Delete temp files an interrupted encode left in the clip cache. For startup
 * only: it does not know which temp files belong to an encode still running.
 *
 * @param {string} directory
 * @returns {Promise<number>} How many were removed
 */
export async function sweepClipTempFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  const leftovers = entries.filter((name) => name.endsWith(CLIP_TEMP_SUFFIX));
  await Promise.all(leftovers.map((name) => fs.rm(join(directory, name), { force: true })));
  return leftovers.length;
}
