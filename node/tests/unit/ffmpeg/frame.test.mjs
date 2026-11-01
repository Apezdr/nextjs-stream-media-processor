/**
 * Chapter-menu frames (GET /frame/...). Three faults met in production:
 *
 * - The URL's timestamp went into a shell command (`exec("ffmpeg -ss ${t} ...")`),
 *   so `/frame/movie/<title>/00:00:01%3Bid` ran `id`. It is now validated and
 *   handed to ffmpeg as one argv entry (execFile, no shell).
 * - A chapter list from a longer video asked for times past the end. ffmpeg
 *   exited 0 there, writing an AVIF with an empty mdat that ffprobe 8.0.1
 *   segfaulted on. Such times are refused before ffmpeg runs.
 * - The broken file stayed in the cache and was served from then on. Any
 *   failure now removes the output.
 *
 * ffprobe and ffmpeg are mocked; the mock ffmpeg writes the output file.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execFile = jest.fn();
jest.unstable_mockModule('child_process', () => ({ execFile, exec: jest.fn(), spawn: jest.fn() }));
// ffprobe.mjs (pickDuration) imports utils.mjs, which this test doesn't need.
jest.unstable_mockModule('../../../utils/utils.mjs', () => ({ execFileAsync: jest.fn() }));
const quiet = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../lib/logger.mjs', () => ({ createCategoryLogger: () => quiet }));
const needsDoviReshape = jest.fn();
jest.unstable_mockModule('../../../ffmpeg/dolbyVision.mjs', () => ({
  needsDoviReshape,
  libplaceboAvailable: jest.fn(async () => true),
  doviReshapeFilter: () => 'libplacebo=w=-2:h=140',
  DOVI_RESHAPE_INPUT_ARGS: ['-init_hw_device', 'vulkan'],
}));

const { generateFrame, parseFrameTimestamp, hasPictureData, FrameOutOfRangeError } = await import(
  '../../../ffmpeg/frame.mjs'
);

const box = (type, payload = Buffer.alloc(0)) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
};
const ftyp = box('ftyp', Buffer.from('avif\0\0\0\0avifmif1miafMA1B', 'latin1'));
// What ffmpeg wrote past the end of the video: every box, but an mdat with only its header.
const EMPTY_AVIF = Buffer.concat([ftyp, box('meta', Buffer.alloc(40)), box('mdat')]);
const PICTURE_AVIF = Buffer.concat([ftyp, box('meta', Buffer.alloc(40)), box('mdat', Buffer.from([0x12, 0x00, 0x0a, 0x0a]))]);

const VIDEO = '/lib/movies/Title/Title.mkv';

let dir;
let output;
let ffmpegWrites;
let ffmpegError;
let probe;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'frame-test-'));
  output = join(dir, 'movie_Title_01-43-14.avif');
  ffmpegWrites = PICTURE_AVIF;
  ffmpegError = null;
  probe = { streams: [{ color_transfer: 'bt709' }], format: { duration: '7427.552000' } };
  needsDoviReshape.mockReset().mockResolvedValue(false);
  execFile.mockReset().mockImplementation((command, args, callback) => {
    if (command === 'ffprobe') return callback(null, { stdout: JSON.stringify(probe), stderr: '' });
    writeFile(args[args.length - 1], ffmpegWrites).then(() => callback(ffmpegError, { stdout: '', stderr: '' }));
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ffmpegCalls = () => execFile.mock.calls.filter(([command]) => command === 'ffmpeg');
const exists = (path) => access(path).then(() => true, () => false);

describe('parseFrameTimestamp', () => {
  it('reads H:MM:SS with an optional fraction', () => {
    expect(parseFrameTimestamp('01:43:14')).toBe(6194);
    expect(parseFrameTimestamp('0:00:00')).toBe(0);
    expect(parseFrameTimestamp('02:08:50.930')).toBeCloseTo(7730.93, 5);
    expect(parseFrameTimestamp('100:00:00')).toBe(360000);
  });

  it('refuses anything else, shell syntax included', () => {
    for (const value of [
      '00:00:01;id > $HOME/pwned',
      '1$(id)',
      '00:00:01`id`',
      '00:61:00',
      '00:00:60',
      '43:14',
      '6194',
      '00:00:01 ',
      '-1:00:00',
      '00:00:01.1234',
      '',
      undefined,
      6194,
    ]) {
      expect(parseFrameTimestamp(value)).toBeNull();
    }
  });
});

describe('hasPictureData', () => {
  it('is true for an mdat with a payload and false for a header-only one', () => {
    expect(hasPictureData(PICTURE_AVIF)).toBe(true);
    expect(hasPictureData(EMPTY_AVIF)).toBe(false);
  });

  it('is false without an mdat, or for a truncated file', () => {
    expect(hasPictureData(Buffer.concat([ftyp, box('meta')]))).toBe(false);
    expect(hasPictureData(PICTURE_AVIF.subarray(0, 10))).toBe(false);
    expect(hasPictureData(Buffer.alloc(0))).toBe(false);
  });

  it('reads 64-bit and to-end-of-file box sizes', () => {
    const large = Buffer.alloc(20);
    large.writeUInt32BE(1, 0);
    large.write('mdat', 4, 'latin1');
    large.writeBigUInt64BE(20n, 8);
    expect(hasPictureData(Buffer.concat([ftyp, large]))).toBe(true);

    const toEnd = Buffer.from([0, 0, 0, 0, ...Buffer.from('mdat', 'latin1'), 1, 2, 3]);
    expect(hasPictureData(Buffer.concat([ftyp, toEnd]))).toBe(true);
  });
});

describe('generateFrame', () => {
  it('writes the frame and resolves with its path', async () => {
    await expect(generateFrame(VIDEO, '01:43:14', output)).resolves.toBe(output);
    expect(await exists(output)).toBe(true);
  });

  it('hands the timestamp to ffmpeg as its own argument, with no shell', async () => {
    await generateFrame(VIDEO, '01:43:14', output);

    const [[command, args, callback]] = ffmpegCalls();
    expect(command).toBe('ffmpeg');
    expect(args[args.indexOf('-ss') + 1]).toBe('01:43:14');
    expect(args[args.indexOf('-i') + 1]).toBe(VIDEO);
    expect(args[args.length - 1]).toBe(output);
    expect(typeof callback).toBe('function'); // no options object, so no `shell`
  });

  it('refuses a non-timestamp before running anything', async () => {
    await expect(generateFrame(VIDEO, '00:00:01;id', output)).rejects.toThrow(TypeError);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('refuses a time at or past the end of the video without running ffmpeg', async () => {
    await expect(generateFrame(VIDEO, '02:06:02', output)).rejects.toBeInstanceOf(FrameOutOfRangeError);

    probe = { streams: [{}], format: { duration: '10.000000' } };
    await expect(generateFrame(VIDEO, '00:00:10', output)).rejects.toBeInstanceOf(FrameOutOfRangeError);

    expect(ffmpegCalls()).toHaveLength(0);
    expect(await exists(output)).toBe(false);
  });

  it('removes the output when ffmpeg encodes no picture', async () => {
    ffmpegWrites = EMPTY_AVIF;

    await expect(generateFrame(VIDEO, '01:43:14', output)).rejects.toThrow(/no picture/);
    expect(await exists(output)).toBe(false);
  });

  it('removes the output when ffmpeg fails', async () => {
    ffmpegError = new Error('Command failed: ffmpeg');

    await expect(generateFrame(VIDEO, '01:43:14', output)).rejects.toThrow('Command failed: ffmpeg');
    expect(await exists(output)).toBe(false);
  });

  it('encodes even when the duration is unreadable, and the output check still applies', async () => {
    probe = { streams: [{}], format: {} };
    ffmpegWrites = EMPTY_AVIF;

    await expect(generateFrame(VIDEO, '05:00:00', output)).rejects.toThrow(/no picture/);
    expect(ffmpegCalls()).toHaveLength(1);
  });

  it('keeps HDR10 for a PQ source and reshapes Dolby Vision Profile 5 on Vulkan', async () => {
    probe = { streams: [{ color_transfer: 'smpte2084' }], format: { duration: '7427.552000' } };
    await generateFrame(VIDEO, '01:43:14', output);
    let [, args] = ffmpegCalls()[0];
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=-2:140:flags=lanczos,format=yuv420p10le');
    expect(args[args.indexOf('-color_trc') + 1]).toBe('smpte2084');

    needsDoviReshape.mockResolvedValue(true);
    await generateFrame(VIDEO, '01:43:14', join(dir, 'dovi.avif'));
    [, args] = ffmpegCalls()[1];
    expect(args.slice(args.indexOf('-init_hw_device'), args.indexOf('-init_hw_device') + 2)).toEqual(['-init_hw_device', 'vulkan']);
    expect(args.indexOf('-init_hw_device')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-vf') + 1]).toBe('libplacebo=w=-2:h=140');
  });
});
