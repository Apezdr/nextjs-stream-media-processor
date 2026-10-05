/**
 * How a clip reaches the cache: ffmpeg writes a temp file, and it is renamed
 * into place only after a clean exit. Before this, ffmpeg wrote straight to
 * the cache path, and a request arriving mid-encode was handed the growing
 * file with a one-year Cache-Control (seen in production, 2026-09-27).
 *
 * ffmpeg and ffprobe are mocked here; the directory is real.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const quiet = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../lib/logger.mjs', () => ({
  createCategoryLogger: () => quiet,
}));

// Stand-in for the ffmpeg process: by default it "encodes" by writing to the
// output path, which is always the last argument.
const executeFFmpeg = jest.fn();
jest.unstable_mockModule('../../../ffmpeg/ffmpeg.mjs', () => ({ executeFFmpeg }));

const libplaceboAvailable = jest.fn();
const actualDolbyVision = await import('../../../ffmpeg/dolbyVision.mjs');
jest.unstable_mockModule('../../../ffmpeg/dolbyVision.mjs', () => ({
  ...actualDolbyVision,
  libplaceboAvailable,
}));

// The two things this module runs with execFile(file, args[, options], callback):
// ffprobe for the keyframe, and ffmpeg for a one-frame encoder probe.
let keyframeProbeOutput = '';
let brokenEncoders = new Set();
const execFile = jest.fn((file, args, optionsOrCallback, maybeCallback) => {
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
  if (file === 'ffmpeg') {
    const encoder = args[args.indexOf('-c:v') + 1];
    if (brokenEncoders.has(encoder)) {
      callback(Object.assign(new Error('Command failed'), { stderr: `[${encoder}] Error creating a MFX session: -9.` }));
      return;
    }
    callback(null, { stdout: '', stderr: '' });
    return;
  }
  callback(null, { stdout: keyframeProbeOutput, stderr: '' });
});
jest.unstable_mockModule('child_process', () => ({ execFile }));

// av1_qsv is "broken" for the whole file: the probe result is kept per process,
// as it is in production, so it is decided before the first import.
brokenEncoders = new Set(['av1_qsv']);

const {
  transcodeClip,
  copyOriginalClip,
  sweepClipTempFiles,
  clipEncoderAvailable,
  ClipNotCopyableError,
  CLIP_TEMP_SUFFIX,
} = await import('../../../ffmpeg/clipEncode.mjs');

const SDR = { codec: 'h264', pixFmt: 'yuv420p', transfer: 'sdr', assumedPq: false, wideGamut: false, dovi: false, duration: 5400, startTime: 0 };
const HDR10 = { ...SDR, codec: 'hevc', pixFmt: 'yuv420p10le', transfer: 'pq' };

let dir;
let outputPath;

beforeEach(async () => {
  jest.clearAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-write-'));
  outputPath = path.join(dir, 'A Film-key_abc-start_3200-end_3250-v2-h264.mp4');
  executeFFmpeg.mockImplementation(async (args) => {
    await fs.writeFile(args.at(-1), 'clip bytes');
  });
  libplaceboAvailable.mockResolvedValue(true);
  keyframeProbeOutput = '3199.196000,\n';
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const transcode = (source = SDR) =>
  transcodeClip({ videoPath: '/media/a.mkv', start: 3200, duration: 50, source, outputPath });

describe('writing a clip', () => {
  it('has ffmpeg write a temp file beside the destination, then renames it into place', async () => {
    let seenWhileEncoding;
    executeFFmpeg.mockImplementation(async (args) => {
      const tempPath = args.at(-1);
      await fs.writeFile(tempPath, 'clip bytes');
      seenWhileEncoding = { tempPath, entries: await fs.readdir(dir) };
    });

    await transcode();

    // While ffmpeg ran, the cache path did not exist: only the temp file did.
    expect(path.dirname(seenWhileEncoding.tempPath)).toBe(dir);
    expect(seenWhileEncoding.tempPath.endsWith(CLIP_TEMP_SUFFIX)).toBe(true);
    expect(seenWhileEncoding.entries).toEqual([path.basename(seenWhileEncoding.tempPath)]);

    // Afterwards the clip is there, whole, and the temp file is gone.
    expect(await fs.readdir(dir)).toEqual([path.basename(outputPath)]);
    expect(await fs.readFile(outputPath, 'utf8')).toBe('clip bytes');
  });

  it('leaves nothing behind when ffmpeg fails, and passes the failure on', async () => {
    executeFFmpeg.mockImplementation(async (args) => {
      await fs.writeFile(args.at(-1), 'half a cl');
      throw new Error('FFmpeg exited with code 1: Conversion failed!');
    });

    await expect(transcode()).rejects.toThrow('FFmpeg exited with code 1');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('treats an empty output as a failure, not a clip', async () => {
    executeFFmpeg.mockImplementation(async (args) => {
      await fs.writeFile(args.at(-1), '');
    });

    await expect(transcode()).rejects.toThrow('FFmpeg wrote an empty clip');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('kills an ffmpeg that stops making progress', async () => {
    await transcode();
    // 120 s + 10x the clip length.
    expect(executeFFmpeg.mock.calls[0][1]).toEqual({ timeout: 620_000, killSignal: 'SIGKILL' });
  });
});

describe('clipEncoderAvailable', () => {
  it('runs one small frame through the encoder, with the settings a clip uses, and remembers the answer', async () => {
    execFile.mockClear();
    expect(await clipEncoderAvailable('libsvtav1')).toBe(true);
    expect(await clipEncoderAvailable('libsvtav1')).toBe(true);

    const probes = execFile.mock.calls.filter(([file, args]) => file === 'ffmpeg' && args.includes('libsvtav1'));
    expect(probes).toHaveLength(1);
    const [, args, options] = probes[0];
    // Not 64x64: the Arc's AV1 encoder refuses a picture that small.
    expect(args).toEqual(expect.arrayContaining(['-i', 'color=c=black:s=256x144:d=0.2', '-frames:v', '1']));
    expect(args.join(' ')).toContain('-c:v libsvtav1 -preset 10 -crf 52 -svtav1-params mbr=600');
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    // The encoder's banner is kept out of the result.
    expect(options.env.SVT_LOG).toBe('1');
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('says no for an encoder that is listed but cannot open, and logs why once', async () => {
    quiet.warn.mockClear();
    expect(await clipEncoderAvailable('av1_qsv')).toBe(false);
    expect(await clipEncoderAvailable('av1_qsv')).toBe(false);

    expect(quiet.warn).toHaveBeenCalledTimes(1);
    expect(quiet.warn.mock.calls[0][0]).toContain('av1_qsv does not work here');
    expect(quiet.warn.mock.calls[0][0]).toContain('Error creating a MFX session');

    const probe = execFile.mock.calls.find(([file, args]) => file === 'ffmpeg' && args.includes('av1_qsv'));
    expect(probe[1].join(' ')).toContain('-vf format=nv12 -c:v av1_qsv -global_quality 33');
    expect(probe[2].env.LIBVA_MESSAGING_LEVEL).toBe('1');
  });
});

describe('transcodeClip', () => {
  it('does not probe for Vulkan to encode an SDR source', async () => {
    await transcode(SDR);
    expect(libplaceboAvailable).not.toHaveBeenCalled();
    expect(executeFFmpeg.mock.calls[0][0]).not.toContain('-init_hw_device');
  });

  it('tone-maps HDR with libplacebo where the host has it', async () => {
    await transcode(HDR10);
    const args = executeFFmpeg.mock.calls[0][0];
    expect(args).toContain('-init_hw_device');
    expect(args[args.indexOf('-vf') + 1]).toMatch(/^libplacebo=/);
  });

  it('makes AV1 with the encoder it is given, with that encoder\'s log noise turned off', async () => {
    await transcodeClip({
      videoPath: '/media/a.mkv', start: 3200, duration: 50, source: SDR, encoder: 'libsvtav1', outputPath,
    });
    const [args, options] = executeFFmpeg.mock.calls[0];
    expect(args).toContain('libsvtav1');
    expect(options.env.SVT_LOG).toBe('1');
    expect(options.env.PATH ?? options.env.Path).toBe(process.env.PATH ?? process.env.Path); // the rest of the environment is kept

    await transcodeClip({
      videoPath: '/media/a.mkv', start: 3200, duration: 50, source: SDR, encoder: 'av1_qsv', outputPath: `${outputPath}.qsv`,
    });
    expect(executeFFmpeg.mock.calls[1][0]).toContain('av1_qsv');
    expect(executeFFmpeg.mock.calls[1][1].env.LIBVA_MESSAGING_LEVEL).toBe('1');
  });

  it('tone-maps HDR on the CPU where it does not', async () => {
    libplaceboAvailable.mockResolvedValue(false);
    await transcode(HDR10);
    const args = executeFFmpeg.mock.calls[0][0];
    expect(args).not.toContain('-init_hw_device');
    expect(args[args.indexOf('-vf') + 1]).toContain('tonemap=tonemap=hable');
  });
});

describe('copyOriginalClip', () => {
  const copy = (source = HDR10) =>
    copyOriginalClip({ videoPath: '/media/a.mkv', start: 3200, duration: 50, source, outputPath });

  it('asks ffprobe for the keyframe at the requested time and starts the copy on it', async () => {
    await copy();

    const probeArgs = execFile.mock.calls[0][1];
    expect(execFile.mock.calls[0][0]).toBe('ffprobe');
    expect(probeArgs).toEqual(expect.arrayContaining(['-select_streams', 'V:0', '-skip_frame', 'nokey', '-read_intervals', '3200%+#1']));

    const args = executeFFmpeg.mock.calls[0][0];
    expect(args[args.indexOf('-ss') + 1]).toBe('3199.446'); // 3199.196 + 0.25
    expect(args[args.indexOf('-t') + 1]).toBe('50.554'); // to 3250
    expect(await fs.readdir(dir)).toEqual([path.basename(outputPath)]);
  });

  it('probes on the container timeline when the file does not start at zero', async () => {
    keyframeProbeOutput = '7.000000\n';
    await copyOriginalClip({
      videoPath: '/media/a.mkv', start: 3, duration: 4, source: { ...SDR, startTime: 4.977 }, outputPath,
    });

    expect(execFile.mock.calls[0][1]).toEqual(expect.arrayContaining(['-read_intervals', '7.977%+#1']));
    const args = executeFFmpeg.mock.calls[0][0];
    expect(args[args.indexOf('-ss') + 1]).toBe('7.25');
    expect(args[args.indexOf('-t') + 1]).toBe('4.727'); // to 11.977
  });

  it('says the source cannot be copied when ffprobe finds no keyframe, without running ffmpeg', async () => {
    keyframeProbeOutput = '';
    await expect(copy()).rejects.toBeInstanceOf(ClipNotCopyableError);
    expect(executeFFmpeg).not.toHaveBeenCalled();
  });

  it('says the same when the nearest keyframe is too far back to be a sensible start', async () => {
    keyframeProbeOutput = '3100.000000\n';
    await expect(copy()).rejects.toBeInstanceOf(ClipNotCopyableError);
    expect(executeFFmpeg).not.toHaveBeenCalled();
  });
});

describe('sweepClipTempFiles', () => {
  it('removes temp files and nothing else', async () => {
    await fs.writeFile(path.join(dir, `dead-encode${CLIP_TEMP_SUFFIX}`), 'x');
    await fs.writeFile(path.join(dir, 'A Film-key_abc-start_0-end_50-v2-h264.mp4'), 'x');
    await fs.writeFile(path.join(dir, 'A Film-key_abc-start_0-end_50-v2-original.mp4'), 'x');

    expect(await sweepClipTempFiles(dir)).toBe(1);
    expect((await fs.readdir(dir)).sort()).toEqual([
      'A Film-key_abc-start_0-end_50-v2-h264.mp4',
      'A Film-key_abc-start_0-end_50-v2-original.mp4',
    ]);
  });

  it('is fine with a cache directory that does not exist yet', async () => {
    expect(await sweepClipTempFiles(path.join(dir, 'missing'))).toBe(0);
  });
});
