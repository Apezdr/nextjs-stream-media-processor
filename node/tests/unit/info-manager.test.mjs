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
let ffprobePayload = JSON.stringify({ format: { duration: '10.5', size: '1000' }, streams: [] });
let ffprobeShouldFail = false;
const execMock = (cmd, cb) => cb(null, ffprobePayload, '');
execMock[promisify.custom] = async () => {
  if (ffprobeShouldFail) throw new Error('ffprobe: Invalid data found when processing input');
  return { stdout: ffprobePayload };
};
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

describe('sidecar v1.0011 container/codec fields', () => {
  const richPayload = JSON.stringify({
    format: {
      duration: '3600.5',
      size: '2000',
      format_name: 'matroska,webm',
      format_long_name: 'Matroska / WebM',
      bit_rate: '8000000',
    },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'hevc',
        width: 3840,
        height: 2160,
        pix_fmt: 'yuv420p10le',
        field_order: 'progressive',
        color_transfer: 'smpte2084',
        color_primaries: 'bt2020',
        color_space: 'bt2020nc',
        profile: 'Main 10',
        level: 153,
      },
      {
        codec_type: 'audio',
        codec_name: 'eac3',
        channels: 6,
        tags: { language: 'ENG', title: 'English [DTS-HD MA 5.1]' },
        disposition: { default: 1 },
      },
      {
        codec_type: 'audio',
        codec_name: 'aac',
        channels: 2,
        tags: { language: 'und', title: 'Descriptive Audio' },
        disposition: { visual_impaired: 1 },
      },
      // No language tag at all — this is the track that exposes the trap: the
      // legacy `language` field falls through to tags.title here.
      {
        codec_type: 'audio',
        codec_name: 'aac',
        channels: 2,
        tags: { title: 'Director Commentary' },
        disposition: { comment: 1 },
      },
    ],
  });

  let richPath;

  beforeAll(async () => {
    richPath = join(dir, 'rich.mkv');
    await fs.writeFile(richPath, 'rich-bytes');
    ffprobePayload = richPayload;
  });

  it('captures the container format block', async () => {
    const info = await getInfo(richPath);
    expect(info.additionalMetadata.format).toEqual({
      formatName: 'matroska,webm',
      formatLongName: 'Matroska / WebM',
      bitrate: 8000000,
    });
  });

  it('captures pix_fmt and field_order, which gate the remux path', async () => {
    const info = await getInfo(richPath);
    expect(info.additionalMetadata.video[0]).toMatchObject({
      codec: 'hevc',
      pix_fmt: 'yuv420p10le',
      field_order: 'progressive',
      color_transfer: 'smpte2084',
      profile: 'Main 10',
    });
  });

  it('normalizes languageTag and keeps the loose `language` field intact', async () => {
    const info = await getInfo(richPath);
    const [track1, track2, track3] = info.additionalMetadata.audio;

    // Strict tag: lowercased; 'und' and a missing tag both become null.
    expect(track1.languageTag).toBe('eng');
    expect(track2.languageTag).toBeNull();
    expect(track3.languageTag).toBeNull();

    // The legacy field is deliberately unchanged — it is published in
    // additional_metadata and the frontend reads it.
    expect(track1.language).toBe('ENG');
    expect(track2.language).toBe('und');
    // ...and here is the trap languageTag exists to avoid: with no language
    // tag, `language` falls through to tags.title, which is not a language
    // code. Counting distinct `language` values across these three tracks
    // yields 3 "languages" for what is really one tagged language.
    expect(track3.language).toBe('Director Commentary');

    const distinctLoose = new Set(info.additionalMetadata.audio.map(a => a.language));
    const distinctStrict = new Set(
      info.additionalMetadata.audio.map(a => a.languageTag).filter(Boolean)
    );
    expect(distinctLoose.size).toBe(3);
    expect(distinctStrict.size).toBe(1);
  });

  it('captures dispositions so commentary and descriptive tracks are distinguishable', async () => {
    const info = await getInfo(richPath);
    const [track1, track2, track3] = info.additionalMetadata.audio;
    expect(track1.disposition.default).toBe(true);
    expect(track1.disposition.comment).toBe(false);
    expect(track2.disposition.visual_impaired).toBe(true);
    expect(track3.disposition.comment).toBe(true);
  });
});

describe('probe failure does not cause a regeneration loop', () => {
  it('writes a shaped-empty sidecar once and accepts it on re-read', async () => {
    const brokenPath = join(dir, 'broken.mkv');
    await fs.writeFile(brokenPath, 'not-really-a-video');

    ffprobeShouldFail = true;
    try {
      const before = getMediaInfoCombined.mock.calls.length;

      const first = await getInfo(brokenPath);
      expect(getMediaInfoCombined.mock.calls.length).toBe(before + 1);

      // The `format` KEY must exist even though probing failed — validateInfo
      // tests for presence, not for a non-null value. A bare {} here would fail
      // validation, regenerate, fail again, on every getInfo call forever.
      expect(first.additionalMetadata).toHaveProperty('format');
      expect(first.additionalMetadata.format).toBeNull();

      // Re-read: must be accepted as valid, NOT regenerated.
      await getInfo(brokenPath);
      expect(getMediaInfoCombined.mock.calls.length).toBe(before + 1);

      // And again, to be sure it is stable rather than alternating.
      await getInfo(brokenPath);
      expect(getMediaInfoCombined.mock.calls.length).toBe(before + 1);
    } finally {
      ffprobeShouldFail = false;
    }
  });
});
