// ffmpeg/frame.mjs
//
// One still from a video for the player's chapter menu (GET /frame/...): an
// AVIF 140 pixels high at the requested time, HDR sources kept as HDR10.
//
// The time comes from the request URL. It is checked here as well as in the
// route, and every argument goes to ffmpeg as its own argv entry (execFile, no
// shell): built as a shell string, a time like `00:00:01;id` ran `id`.
//
// A time at or past the end of the video is refused before ffmpeg runs. There
// ffmpeg encodes no frame but still exits 0, leaving an AVIF with an empty
// av1C and an empty mdat, which ffprobe 8.0.1 segfaults on. Stale chapter files
// asked for such times (a chapter list from a longer video the folder used to
// hold). Any failure removes the output, so a broken file is never cached.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import pLimit from 'p-limit';
import { pickDuration } from './ffprobe.mjs';
import { needsDoviReshape, libplaceboAvailable, doviReshapeFilter, DOVI_RESHAPE_INPUT_ARGS } from './dolbyVision.mjs';

const execFileAsync = promisify(execFile);

const FRAME_HEIGHT = 140;
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

// At most this many encodes at once (libaom at -preset slower is CPU-heavy).
const limit = pLimit(10);

/** The requested time is at or past the end of the video: there is no frame there. */
export class FrameOutOfRangeError extends Error {
  constructor(seconds, duration) {
    super(`No frame at ${seconds}s: the video is ${duration}s long`);
    this.name = 'FrameOutOfRangeError';
    this.seconds = seconds;
    this.duration = duration;
  }
}

/**
 * A frame time from the URL, in seconds: H:MM:SS with an optional fraction of
 * up to three digits (the player sends HH:MM:SS, e.g. 01:43:14). Null for
 * anything else; nothing else may reach ffmpeg or the cache file name.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseFrameTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)(\.\d{1,3})?$/.exec(value);
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + (fraction ? Number(fraction) : 0);
}

/**
 * Whether an AVIF (ISO BMFF) holds picture data: a top-level mdat box with a
 * payload. ffmpeg's empty output has every box but an 8-byte, header-only mdat.
 * @param {Buffer} data
 * @returns {boolean}
 */
export function hasPictureData(data) {
  let offset = 0;
  while (offset + 8 <= data.length) {
    let size = data.readUInt32BE(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > data.length) return false;
      size = Number(data.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = data.length - offset;
    }
    if (size < header) return false;
    if (data.toString('latin1', offset + 4, offset + 8) === 'mdat') return size > header;
    offset += size;
  }
  return false;
}

async function probeSource(videoPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=color_transfer,duration:format=duration',
    '-of', 'json',
    videoPath,
  ]);
  const probe = JSON.parse(stdout);
  return { colorTransfer: probe.streams?.[0]?.color_transfer ?? null, duration: pickDuration(probe) };
}

/**
 * ffmpeg's arguments for one frame. `mode` is 'dovi' (Profile 5: libplacebo
 * applies the RPU and writes HDR10), 'hdr' (kept as HDR10) or 'sdr'.
 */
export function frameEncodeArgs({ videoPath, timestamp, outputPath, mode }) {
  const filter =
    mode === 'dovi'
      ? doviReshapeFilter({ width: -2, height: FRAME_HEIGHT, output: 'pq' })
      : `scale=-2:${FRAME_HEIGHT}:flags=lanczos,format=${mode === 'hdr' ? 'yuv420p10le' : 'yuv420p'}`;
  return [
    '-hide_banner',
    '-v', 'error',
    '-y',
    ...(mode === 'dovi' ? DOVI_RESHAPE_INPUT_ARGS : []),
    '-ss', timestamp,
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', filter,
    ...(mode === 'sdr' ? [] : ['-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc']),
    '-c:v', 'libaom-av1',
    '-crf', '10',
    '-b:v', '0',
    '-preset', 'slower',
    outputPath,
  ];
}

async function renderFrame(videoPath, timestamp, outputPath) {
  const seconds = parseFrameTimestamp(timestamp);
  if (seconds === null) throw new TypeError(`Not a frame timestamp: ${JSON.stringify(timestamp)}`);

  const { colorTransfer, duration } = await probeSource(videoPath);
  // An unreadable duration doesn't stop the encode: the output check below
  // still catches a time with no frame.
  if (duration !== null && seconds >= duration) throw new FrameOutOfRangeError(seconds, duration);

  // Dolby Vision Profile 5 reads as SDR by its transfer, and either plain
  // branch renders its base layer green/magenta. libplacebo applies the RPU and
  // writes HDR10. Without a usable libplacebo the plain branches still run (see
  // dolbyVision.mjs; the probe has warned once).
  const dovi = (await needsDoviReshape(videoPath)) && (await libplaceboAvailable());
  const mode = dovi ? 'dovi' : HDR_TRANSFERS.has(colorTransfer) ? 'hdr' : 'sdr';

  try {
    await execFileAsync('ffmpeg', frameEncodeArgs({ videoPath, timestamp, outputPath, mode }));
    if (!hasPictureData(await fs.readFile(outputPath))) {
      throw new Error(`ffmpeg encoded no picture at ${timestamp} (the AVIF has an empty mdat)`);
    }
  } catch (error) {
    await fs.rm(outputPath, { force: true });
    throw error;
  }
  return outputPath;
}

/**
 * Write the frame at `timestamp` (H:MM:SS[.fff]) of `videoPath` to
 * `outputPath` (an .avif). Rejects with FrameOutOfRangeError for a time at or
 * past the end, and leaves no file behind on any failure.
 * @returns {Promise<string>} outputPath
 */
export function generateFrame(videoPath, timestamp, outputPath) {
  return limit(() => renderFrame(videoPath, timestamp, outputPath));
}
