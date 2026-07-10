/**
 * Branch 11 (V-4) tests for getInfo()'s stat-based staleness check: the
 * version/shape gate cannot see an in-place file replacement, so the sidecar
 * records the source file's stat identity and getInfo regenerates (rotating
 * the uuid the video cache keys depend on) when it no longer matches.
 * The ffprobe/mediainfo boundary is mocked; files are real temp files.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';

// child_process.exec backs the ffprobe call; promisify.custom keeps the
// { stdout } shape extractAdditionalMetadata destructures.
const ffprobePayload = JSON.stringify({ format: { duration: '10.5', size: '1000' }, streams: [] });
const execMock = (cmd, cb) => cb(null, ffprobePayload, '');
execMock[promisify.custom] = async () => ({ stdout: ffprobePayload });
jest.unstable_mockModule('child_process', () => ({ exec: execMock }));

// mediainfo boundary — headerData drives the uuid (sha256 of it), so tests
// rotate it to simulate a genuinely different file arriving in place.
let headerData = 'AAA';
const getMediaInfoCombined = jest.fn(async () => ({
  headerData,
  mediaQuality: { isHDR: false },
  hdr: null,
}));
jest.unstable_mockModule('../../mediaInfo/mediaInfo.mjs', () => ({
  getMediaInfoCombined,
  extractHDRInfo: jest.fn(),
  extractMediaQuality: jest.fn(),
  getHeaderData: jest.fn(),
}));

// utils.mjs drags in the blurhash worker pool; getInfo only needs fileExists.
jest.unstable_mockModule('../../utils/utils.mjs', () => ({
  fileExists: async (p) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
}));

const { getInfo, CURRENT_VERSION } = await import('../../infoManager.mjs');

let dir;
let videoPath;

beforeAll(async () => {
  dir = join(tmpdir(), `info-manager-test-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  videoPath = join(dir, 'movie.mp4');
  await fs.writeFile(videoPath, 'original-bytes');
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('getInfo stat-based staleness (V-4)', () => {
  it('generates a sidecar carrying the source stat identity', async () => {
    const info = await getInfo(videoPath);

    expect(getMediaInfoCombined).toHaveBeenCalledTimes(1);
    expect(info.version).toBe(CURRENT_VERSION);
    expect(typeof info.uuid).toBe('string');
    const stats = await fs.stat(videoPath);
    expect(info.source).toEqual({ size: stats.size, mtimeMs: Math.floor(stats.mtimeMs) });
  });

  it('does not regenerate while the source file is unchanged', async () => {
    const before = getMediaInfoCombined.mock.calls.length;
    const info = await getInfo(videoPath);
    expect(getMediaInfoCombined.mock.calls.length).toBe(before);
    expect(info.uuid).toBeDefined();
  });

  it('regenerates — and rotates the uuid — when the file is replaced in place', async () => {
    const oldInfo = await getInfo(videoPath);

    headerData = 'BBB'; // the replacement is a genuinely different file
    await fs.writeFile(videoPath, 'replacement-bytes-with-different-length');

    const newInfo = await getInfo(videoPath);

    expect(newInfo.uuid).not.toBe(oldInfo.uuid);
    const stats = await fs.stat(videoPath);
    expect(newInfo.source).toEqual({ size: stats.size, mtimeMs: Math.floor(stats.mtimeMs) });
  });

  it('converges a pre-V-4 sidecar (no source field) by regenerating once', async () => {
    const legacyPath = join(dir, 'legacy.mp4');
    await fs.writeFile(legacyPath, 'legacy-bytes');
    // Hand-write a sidecar that passes the version/shape gate but predates
    // provenance tracking.
    await fs.writeFile(`${legacyPath}.info`, JSON.stringify({
      version: CURRENT_VERSION,
      uuid: 'legacy-uuid',
      length: 1000,
      dimensions: '1920x1080',
      hdr: null,
      mediaQuality: { isHDR: false },
      additionalMetadata: {},
    }));

    const before = getMediaInfoCombined.mock.calls.length;
    const info = await getInfo(legacyPath);
    expect(getMediaInfoCombined.mock.calls.length).toBe(before + 1);
    expect(info.source).toBeDefined();

    // Second read: converged, no further regeneration.
    await getInfo(legacyPath);
    expect(getMediaInfoCombined.mock.calls.length).toBe(before + 1);
  });
});
