/**
 * `sources[]` is folded wholesale into the movie hash (sqlite/metadataHashes.mjs
 * hashes `movie.urls`), so its ORDER is a correctness property, not a
 * presentation one: a readdir-order-dependent array would make the stored hash
 * flap between scans and force a permanent full-catalog resync loop.
 *
 * The ffprobe/mediainfo boundary is mocked; files are real temp files.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// getInfo is the only external dependency of the module under test.
const infoByFile = new Map();
const getInfo = jest.fn(async (filePath) => {
  const name = filePath.split(/[\\/]/).pop();
  if (infoByFile.has(name)) return infoByFile.get(name);
  throw new Error(`no info for ${name}`);
});
jest.unstable_mockModule('../../../infoManager.mjs', () => ({ getInfo }));

const { buildVideoSources, publishableSources, audioLanguagesOf } = await import(
  '../../../components/media-scanner/domain/video-sources.mjs'
);

let dir;

beforeAll(async () => {
  dir = join(tmpdir(), `video-sources-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  for (const f of ['Movie.mp4', 'Movie.mkv', 'Movie.mov', 'Movie.avi']) {
    await fs.writeFile(join(dir, f), 'x'.repeat(f.length * 10));
  }

  infoByFile.set('Movie.mp4', {
    uuid: 'uuid-mp4',
    length: 7200000,
    dimensions: '1920x1080',
    hdr: null,
    mediaQuality: { isHDR: false },
    additionalMetadata: {
      format: { formatName: 'mov,mp4,m4a,3gp,3g2,mj2' },
      video: [{ codec: 'h264', pix_fmt: 'yuv420p', field_order: 'progressive' }],
      audio: [{ codec: 'aac', languageTag: 'eng' }],
    },
  });
  infoByFile.set('Movie.mkv', {
    uuid: 'uuid-mkv',
    length: 7200500,
    dimensions: '3840x2160',
    hdr: 'HDR10',
    mediaQuality: { isHDR: true },
    additionalMetadata: {
      format: { formatName: 'matroska,webm' },
      video: [{ codec: 'hevc', pix_fmt: 'yuv420p10le', field_order: 'progressive' }],
      audio: [
        { codec: 'eac3', languageTag: 'eng' },
        { codec: 'aac', languageTag: 'jpn' },
        { codec: 'aac', languageTag: null },
      ],
    },
  });
  infoByFile.set('Movie.avi', {
    uuid: 'uuid-avi',
    length: 3000000,
    dimensions: '640x480',
    hdr: null,
    mediaQuality: { isHDR: false },
    additionalMetadata: {
      format: { formatName: 'avi' },
      video: [{ codec: 'mpeg4', pix_fmt: 'yuv420p', field_order: 'progressive' }],
      audio: [{ codec: 'mp3', languageTag: 'eng' }],
    },
  });
  // Movie.mov intentionally has NO info entry — getInfo throws for it.
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const urlFor = (f) => `/media/movies/Test/${encodeURIComponent(f)}`;

describe('audioLanguagesOf', () => {
  it('returns distinct sorted languageTags, ignoring untagged tracks', () => {
    expect(
      audioLanguagesOf({ audio: [{ languageTag: 'jpn' }, { languageTag: 'eng' }, { languageTag: null }] })
    ).toEqual(['eng', 'jpn']);
  });

  it('reads languageTag, never the loose `language` field', () => {
    // `language` falls back to the stream title, so it holds things like
    // "Director Commentary". Counting it would report bogus extra languages.
    expect(audioLanguagesOf({ audio: [{ language: 'Director Commentary' }] })).toEqual([]);
  });

  it('is empty for missing or malformed metadata', () => {
    expect(audioLanguagesOf(undefined)).toEqual([]);
    expect(audioLanguagesOf({})).toEqual([]);
    expect(audioLanguagesOf({ audio: 'nope' })).toEqual([]);
  });
});

describe('buildVideoSources', () => {
  it('builds one self-describing entry per container', async () => {
    const { sources } = await buildVideoSources({
      videoFiles: ['Movie.mp4', 'Movie.mkv'],
      dir,
      urlFor,
    });

    expect(sources).toHaveLength(2);

    const mkv = sources.find(s => s.container === 'mkv');
    expect(mkv).toMatchObject({
      filename: 'Movie.mkv',
      container: 'mkv',
      formatName: 'matroska,webm',
      dimensions: '3840x2160',
      videoCodec: 'hevc',
      pixFmt: 'yuv420p10le',
      fieldOrder: 'progressive',
      hdr: 'HDR10',
      audioTrackCount: 3,
      audioLanguages: ['eng', 'jpn'],
      uuid: 'uuid-mkv',
    });
    expect(typeof mkv.size).toBe('number');
    expect(mkv.mediaLastModified).toMatch(/^\d{4}-/);
  });

  it('marks exactly one primary', async () => {
    const { sources, primary } = await buildVideoSources({
      videoFiles: ['Movie.mp4', 'Movie.mkv'],
      dir,
      urlFor,
    });
    expect(sources.filter(s => s.isPrimary)).toHaveLength(1);
    expect(primary.filename).toBe('Movie.mp4');
  });

  it('honours a pinned primary over list order', async () => {
    const { primary } = await buildVideoSources({
      videoFiles: ['Movie.mp4', 'Movie.mkv'],
      dir,
      urlFor,
      primaryFilename: 'Movie.mkv',
    });
    expect(primary.filename).toBe('Movie.mkv');
  });

  it('falls back to the first entry when the pinned primary is gone', async () => {
    const { primary } = await buildVideoSources({
      videoFiles: ['Movie.mp4', 'Movie.mkv'],
      dir,
      urlFor,
      primaryFilename: 'Deleted.mp4',
    });
    expect(primary.filename).toBe('Movie.mp4');
  });

  it('PRESERVES CALLER ORDER — the hash-stability contract', async () => {
    // The caller (listVideoFiles / the scanners) sorts by container priority
    // then name. This module must not reorder, and must not depend on readdir.
    const a = await buildVideoSources({ videoFiles: ['Movie.mp4', 'Movie.mkv'], dir, urlFor });
    const b = await buildVideoSources({ videoFiles: ['Movie.mp4', 'Movie.mkv'], dir, urlFor });

    expect(publishableSources(a.sources)).toEqual(publishableSources(b.sources));
    expect(a.sources.map(s => s.filename)).toEqual(['Movie.mp4', 'Movie.mkv']);
  });

  it('keeps an unprobeable file as a source with null facts', async () => {
    // A file ffprobe cannot read is still a real, servable file. Dropping it
    // from the payload would make it invisible; publishing it with nulls keeps
    // the catalog honest.
    const { sources } = await buildVideoSources({
      videoFiles: ['Movie.mp4', 'Movie.mov'],
      dir,
      urlFor,
    });

    const mov = sources.find(s => s.container === 'mov');
    expect(mov).toBeDefined();
    expect(mov.videoCodec).toBeNull();
    expect(mov.formatName).toBeNull();
    expect(mov.length).toBeNull();
    expect(mov.audioLanguages).toEqual([]);
    // stat still succeeded, so these are real
    expect(typeof mov.size).toBe('number');
    expect(mov.mediaLastModified).toMatch(/^\d{4}-/);
  });

  it('returns an empty result for a folder with no video', async () => {
    const r = await buildVideoSources({ videoFiles: [], dir, urlFor });
    expect(r.sources).toEqual([]);
    expect(r.primary).toBeNull();
  });

  it('collects per-file lengths and dimensions for every source, not just the primary', async () => {
    const { fileLengths, fileDimensions } = await buildVideoSources({
      videoFiles: ['Movie.mp4', 'Movie.mkv'],
      dir,
      urlFor,
    });
    expect(fileLengths['Movie.mp4']).toBe(7200000);
    expect(fileLengths['Movie.mkv']).toBe(7200500);
    expect(fileDimensions['Movie.mkv']).toBe('3840x2160');
  });
});

/**
 * `jitEligible` is a RECOMMENDATION ("routing this through JIT loses nothing");
 * `jitKey`/`jitUrl` are ADDRESSABILITY ("the transcoder can serve this at all").
 * They were one field, which meant a multi-audio file could never get a URL —
 * so the frontend's per-title "Always JIT" override had nothing to point at.
 * See docs/jit-url-addressability.md.
 */
describe('buildVideoSources — JIT emission', () => {
  const withEnv = async (vars, fn) => {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const ON = { JIT_ELIGIBILITY_ENABLED: 'true', JIT_TRANSCODER_URL: 'https://t.test', JIT_SOURCE_PREFIX: '' };

  const build = (videoFiles) =>
    buildVideoSources({ videoFiles, dir, urlFor, libraryRelativeDir: 'movies/Test' });

  const decode = (key) => Buffer.from(key, 'base64url').toString('utf8');

  it('emits a URL for an eligible source', () =>
    withEnv(ON, async () => {
      const { sources } = await build(['Movie.mp4']);
      expect(sources[0].jitEligible).toBe(true);
      expect(sources[0].jitReason).toBeNull();
      expect(sources[0].jitUrl).toBe(`https://t.test/stream/${sources[0].jitKey}/master.m3u8`);
      expect(decode(sources[0].jitKey)).toBe('movies/Test/Movie.mp4');
    }));

  it('RECOMMENDS a multi-language source now that audio groups ship', () =>
    withEnv(ON, async () => {
      // Movie.mkv is eng+jpn+untagged. It was the canonical ineligible file
      // (`multi-audio-language`); the transcoder publishes every track as an
      // audio group now, so it is a plain eligible source with no reason.
      const { sources } = await build(['Movie.mkv']);
      expect(sources[0].jitEligible).toBe(true);
      expect(sources[0].jitReason).toBeNull();
      // The languages are still PUBLISHED — they just stopped gating anything.
      expect(sources[0].audioLanguages).toEqual(['eng', 'jpn']);
      expect(decode(sources[0].jitKey)).toBe('movies/Test/Movie.mkv');
      expect(sources[0].jitUrl).toContain('/stream/');
    }));

  it('ADDRESSES a probe-incomplete source — the transcoder probes at serve time', () =>
    withEnv(ON, async () => {
      // Movie.mov has no sidecar at all, so the predicate fails closed. That is
      // a recommendation gap, not an addressing one.
      const { sources } = await build(['Movie.mov']);
      expect(sources[0].jitEligible).toBe(false);
      expect(sources[0].jitReason).toBe('probe-incomplete');
      expect(decode(sources[0].jitKey)).toBe('movies/Test/Movie.mov');
    }));

  it('does NOT address .avi — unsupported container means no URL, still', () =>
    withEnv(ON, async () => {
      const { sources } = await build(['Movie.avi']);
      expect(sources[0].jitEligible).toBe(false);
      expect(sources[0].jitReason).toBe('container-unsupported');
      expect(sources[0].jitKey).toBeNull();
      expect(sources[0].jitUrl).toBeNull();
    }));

  it('emits nothing anywhere when the host toggle is off — the rollback', () =>
    withEnv({ ...ON, JIT_ELIGIBILITY_ENABLED: 'false' }, async () => {
      const { sources } = await build(['Movie.mp4', 'Movie.mkv']);
      for (const s of sources) {
        expect(s.jitEligible).toBe(false);
        expect(s.jitReason).toBe('host-disabled');
        expect(s.jitKey).toBeNull();
        expect(s.jitUrl).toBeNull();
      }
    }));

  it('emits no URL when no transcoder URL is configured, flag or not', () =>
    withEnv({ ...ON, JIT_TRANSCODER_URL: undefined }, async () => {
      const { sources } = await build(['Movie.mp4']);
      expect(sources[0].jitEligible).toBe(true);
      expect(sources[0].jitKey).toBeNull();
      expect(sources[0].jitUrl).toBeNull();
    }));

  it('emits no URL without a library-relative dir to key on', () =>
    withEnv(ON, async () => {
      const { sources } = await buildVideoSources({ videoFiles: ['Movie.mp4'], dir, urlFor });
      expect(sources[0].jitKey).toBeNull();
      expect(sources[0].jitUrl).toBeNull();
    }));
});

describe('publishableSources', () => {
  it('strips the out-of-band _info carrier', async () => {
    const { sources } = await buildVideoSources({ videoFiles: ['Movie.mp4'], dir, urlFor });
    expect(sources[0]).toHaveProperty('_info');

    const published = publishableSources(sources);
    expect(published[0]).not.toHaveProperty('_info');
    // Everything else survives.
    expect(published[0].filename).toBe('Movie.mp4');
    expect(published[0].isPrimary).toBe(true);
  });

  it('produces a stable serialization for hashing', async () => {
    const { sources } = await buildVideoSources({
      videoFiles: ['Movie.mp4', 'Movie.mkv'],
      dir,
      urlFor,
    });
    const once = JSON.stringify(publishableSources(sources));
    const twice = JSON.stringify(publishableSources(sources));
    expect(once).toBe(twice);
    expect(once).not.toContain('_info');
  });
});
