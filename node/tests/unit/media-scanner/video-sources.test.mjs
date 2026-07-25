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
  for (const f of ['Movie.mp4', 'Movie.mkv', 'Movie.mov']) {
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
