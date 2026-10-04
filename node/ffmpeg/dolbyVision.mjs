// ffmpeg/dolbyVision.mjs
//
// Frames from Dolby Vision sources whose picture only exists once the RPU is
// applied — Profile 5, whose base layer is IPTPQc2 rather than a standard
// signal. ffprobe reports such a stream's primaries, transfer and matrix as
// `unknown`, so isVideoHDR() says SDR, and a plain scale (or a zscale chain
// forced to read it as BT.2020 PQ) renders the base layer green/magenta. Found
// on The Chair Company: its Profile 5 episodes produced green sprite sheets and
// /frame stills.
//
// libplacebo applies the RPU (apply_dolbyvision) on a Vulkan device. Two
// conditions, both measured on the production Arc A380 (2026-10-04):
//   - Software decode. ffmpeg's native HEVC decoder attaches the RPU to each
//     frame; `-hwaccel qsv` hands the stream to hevc_qsv, which does not.
//   - A working Vulkan device. The filter is listed whether or not the
//     container has a Vulkan driver, so capability is proven with a real frame.
//
// Same rule and pipeline as the JIT transcoder's `needs_dovi_reshape`
// (jit-transcoder src/core/probe/types.rs), so a title's stills, sprites and
// stream all agree on what the picture looks like.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createCategoryLogger } from '../lib/logger.mjs';

const execFileAsync = promisify(execFile);
const logger = createCategoryLogger('dolby-vision');

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

/** Input options libplacebo needs: the Vulkan device it runs on. */
export const DOVI_RESHAPE_INPUT_ARGS = Object.freeze(['-init_hw_device', 'vulkan']);

/**
 * Whether a probed video stream is Dolby Vision whose base layer is not a
 * standard signal on its own. True for `dv_bl_signal_compatibility_id` 0
 * (Profile 5) and, for a record without a compat id, for any DV stream without
 * an HDR transfer. Every other id names the signal the base layer IS (1/6 HDR10,
 * 2 SDR, 4 HLG), which the ordinary filters read correctly.
 *
 * @param {object|null|undefined} stream - ffprobe stream (needs color_transfer + side_data_list)
 * @returns {boolean}
 */
export function doviReshapeRequired(stream) {
  const dovi = stream?.side_data_list?.find(
    (sd) => String(sd?.side_data_type ?? '').toLowerCase() === 'dovi configuration record'
  );
  if (!dovi || dovi.dv_profile == null) return false;
  const compat = dovi.dv_bl_signal_compatibility_id;
  if (compat === 0) return true;
  if (compat != null) return false;
  return !HDR_TRANSFERS.has(String(stream.color_transfer ?? '').toLowerCase());
}

/**
 * Probe a file's first video stream for {@link doviReshapeRequired}.
 * Throws when ffprobe cannot read the file, like every other probe here.
 *
 * @param {string} videoPath
 * @returns {Promise<boolean>}
 */
export async function needsDoviReshape(videoPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=color_transfer:stream_side_data',
    '-of', 'json',
    videoPath,
  ]);
  return doviReshapeRequired(JSON.parse(stdout).streams?.[0]);
}

/**
 * The libplacebo filter that applies the RPU, scales, and writes either SDR
 * (BT.709, tone-mapped) or HDR10 (BT.2020 PQ). `width`/`height` take the same
 * values as ffmpeg's scale filter, including -1/-2 to keep the aspect ratio.
 * Limited range is pinned: a Profile 5 base layer is full range, and libplacebo
 * otherwise carries that through.
 *
 * @param {{width: number, height: number, output: 'sdr'|'pq'}} options
 * @returns {string}
 */
export function doviReshapeFilter({ width, height, output }) {
  const target = output === 'pq'
    ? 'colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084:range=tv:format=yuv420p10le'
    : 'colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p';
  return `libplacebo=w=${width}:h=${height}:apply_dolbyvision=1:tonemapping=bt.2390:${target}`;
}

let libplaceboProbe = null;

/**
 * Whether libplacebo actually runs in this process's environment: one 10-bit
 * frame through it on a real Vulkan device. Probed once per process; the
 * outcome is logged once, and a failure is a warning because Profile 5 frames
 * then fall back to the old (green) output.
 *
 * @returns {Promise<boolean>}
 */
export function libplaceboAvailable() {
  if (!libplaceboProbe) {
    libplaceboProbe = execFileAsync('ffmpeg', [
      '-hide_banner', '-v', 'error',
      ...DOVI_RESHAPE_INPUT_ARGS,
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.2',
      '-vf', 'format=yuv420p10le,libplacebo=w=32:h=32:format=yuv420p',
      '-frames:v', '1',
      '-f', 'null', '-',
    ]).then(
      () => {
        logger.info('libplacebo runs on a Vulkan device: Dolby Vision Profile 5 frames will be reshaped');
        return true;
      },
      (error) => {
        logger.warn(
          'libplacebo has no usable Vulkan device in this environment: Dolby Vision Profile 5 ' +
          `sprites and stills will keep the green base-layer colors (${String(error.stderr || error.message).trim().slice(0, 300)})`
        );
        return false;
      }
    );
  }
  return libplaceboProbe;
}
