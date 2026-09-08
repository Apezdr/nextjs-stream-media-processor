/**
 * getVideoDuration used to read only the per-stream duration, which Matroska
 * never carries: ffprobe answered N/A, parseFloat gave NaN, and every MKV in
 * the library failed sprite, chapter and caption-duration probes. The probe
 * now asks for the stream and container durations in one call and prefers
 * the stream value where it exists. These tests pin that fallback order with
 * ffprobe's process mocked; the real binary is exercised in
 * tests/integration/ffprobe-real-binary.test.mjs.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const execFileAsync = jest.fn();
jest.unstable_mockModule('../../../utils/utils.mjs', () => ({ execFileAsync }));

const quiet = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../lib/logger.mjs', () => ({
  createCategoryLogger: () => quiet,
}));

const { getVideoDuration, pickDuration } = await import('../../../ffmpeg/ffprobe.mjs');

// Shape of `ffprobe -select_streams v:0 -show_entries stream=duration:format=duration -of json`.
// The JSON writer omits N/A fields, so an MKV's stream object is simply `{}`.
const probeOutput = (streams, format) => ({ stdout: JSON.stringify({ streams, format }), stderr: '' });

describe('pickDuration', () => {
  it('prefers the stream duration when it is a positive number', () => {
    expect(pickDuration({ streams: [{ duration: '2.500000' }], format: { duration: '2.600000' } })).toBe(2.5);
  });

  it('falls back to the container duration when the stream has none (Matroska)', () => {
    expect(pickDuration({ streams: [{}], format: { duration: '13690.040000' } })).toBe(13690.04);
  });

  it('treats a literal N/A or a zero stream duration as absent', () => {
    expect(pickDuration({ streams: [{ duration: 'N/A' }], format: { duration: '10' } })).toBe(10);
    expect(pickDuration({ streams: [{ duration: '0.000000' }], format: { duration: '10' } })).toBe(10);
  });

  it('falls back to the container when no video stream was selected', () => {
    expect(pickDuration({ streams: [], format: { duration: '1.525000' } })).toBe(1.525);
  });

  it('returns null when neither value is usable', () => {
    expect(pickDuration({ streams: [{}], format: {} })).toBeNull();
    expect(pickDuration({ streams: [{ duration: 'N/A' }], format: { duration: 'N/A' } })).toBeNull();
    expect(pickDuration({})).toBeNull();
  });
});

describe('getVideoDuration', () => {
  beforeEach(() => {
    execFileAsync.mockReset();
    quiet.error.mockReset();
  });

  it('asks ffprobe for the stream and container durations in a single call', async () => {
    execFileAsync.mockResolvedValue(probeOutput([{ duration: '2.5' }], { duration: '2.5' }));

    await getVideoDuration('/lib/clip.mp4');

    expect(execFileAsync).toHaveBeenCalledTimes(1);
    const [, args] = execFileAsync.mock.calls[0];
    expect(args[args.indexOf('-select_streams') + 1]).toBe('v:0');
    expect(args[args.indexOf('-show_entries') + 1]).toBe('stream=duration:format=duration');
    expect(args[args.indexOf('-of') + 1]).toBe('json');
    expect(args[args.length - 1]).toBe('/lib/clip.mp4');
  });

  it('returns the stream duration for a container that carries one (MP4)', async () => {
    execFileAsync.mockResolvedValue(probeOutput([{ duration: '5400.120000' }], { duration: '5400.150000' }));
    await expect(getVideoDuration('/lib/clip.mp4')).resolves.toBe(5400.12);
  });

  it('returns the container duration for an MKV, whose stream carries none', async () => {
    execFileAsync.mockResolvedValue(probeOutput([{}], { duration: '13690.040000' }));
    await expect(getVideoDuration('/lib/clip.mkv')).resolves.toBe(13690.04);
    expect(execFileAsync).toHaveBeenCalledTimes(1);
  });

  it('throws, naming both raw values, when neither duration parses', async () => {
    execFileAsync.mockResolvedValue(probeOutput([{}], {}));
    await expect(getVideoDuration('/lib/clip.mkv')).rejects.toThrow(
      'Failed to parse video duration (stream=N/A, format=N/A).'
    );
    expect(quiet.error).toHaveBeenCalledTimes(1);
  });

  it('propagates an ffprobe process failure unchanged', async () => {
    const failure = Object.assign(new Error('Command failed: ffprobe'), {
      stderr: 'Invalid data found when processing input',
    });
    execFileAsync.mockRejectedValue(failure);
    await expect(getVideoDuration('/lib/notmedia.txt')).rejects.toBe(failure);
  });
});
