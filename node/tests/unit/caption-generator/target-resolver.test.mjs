import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { join } from 'path';
import os from 'os';
import { resolveTarget } from '../../../components/caption-generator/domain/target-resolver.mjs';

let tmpRoot;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'target-resolver-'));
  // Movie fixture
  const movieDir = join(tmpRoot, 'movies', 'Sample Movie 2024');
  await fs.mkdir(movieDir, { recursive: true });
  await fs.writeFile(join(movieDir, 'Sample Movie 2024.mp4'), 'x');
  // TV fixture
  const seasonDir = join(tmpRoot, 'tv', 'Some Show', 'Season 1');
  await fs.mkdir(seasonDir, { recursive: true });
  await fs.writeFile(join(seasonDir, 'Some Show - S01E03.mp4'), 'x');
  // TV fixture with apostrophe in title and zero-padded season folder
  // (mirrors a real-world failure: A Grunt's Life / Season 01)
  const padded = join(tmpRoot, 'tv', "A Grunt's Life", 'Season 01');
  await fs.mkdir(padded, { recursive: true });
  await fs.writeFile(join(padded, "A Grunt's Life - S01E10.mp4"), 'x');
  // TV fixture with extra text after the season number
  const extras = join(tmpRoot, 'tv', 'Other Show', 'Season 2 - Pilot Arc');
  await fs.mkdir(extras, { recursive: true });
  await fs.writeFile(join(extras, 'Other Show.S02E01.mp4'), 'x');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('resolveTarget', () => {
  it('resolves a movie target with public URL', async () => {
    const r = await resolveTarget({
      basePath: tmpRoot,
      publicPrefix: '/media',
      mediaType: 'movie',
      mediaTitle: 'Sample Movie 2024',
      langCode: 'en'
    });
    expect(r.srtFilename).toBe('Sample Movie 2024.en.auto.srt');
    expect(r.srtPath).toContain('Sample Movie 2024.en.auto.srt');
    expect(r.srtPublicUrl).toBe('/media/movies/Sample%20Movie%202024/Sample%20Movie%202024.en.auto.srt');
  });

  it('resolves a tv episode target with public URL', async () => {
    const r = await resolveTarget({
      basePath: tmpRoot,
      publicPrefix: '/media',
      mediaType: 'tv',
      mediaTitle: 'Some Show',
      langCode: 'en',
      season: '1',
      episode: '3'
    });
    expect(r.srtFilename).toBe('Some Show - S01E03.en.auto.srt');
    expect(r.srtPublicUrl).toBe('/media/tv/Some%20Show/Season%201/Some%20Show%20-%20S01E03.en.auto.srt');
  });

  it('handles empty publicPrefix', async () => {
    const r = await resolveTarget({
      basePath: tmpRoot,
      mediaType: 'movie',
      mediaTitle: 'Sample Movie 2024',
      langCode: 'en'
    });
    expect(r.srtPublicUrl).toBe('/movies/Sample%20Movie%202024/Sample%20Movie%202024.en.auto.srt');
  });

  it('throws when mediaType is unknown', async () => {
    await expect(
      resolveTarget({ basePath: tmpRoot, mediaType: 'podcast', mediaTitle: 'foo', langCode: 'en' })
    ).rejects.toThrow(/Unsupported mediaType/);
  });

  it('throws when tv season/episode missing', async () => {
    await expect(
      resolveTarget({ basePath: tmpRoot, mediaType: 'tv', mediaTitle: 'Some Show', langCode: 'en' })
    ).rejects.toThrow(/season and episode are required/);
  });

  it('finds "Season 1" folder when called with padded season "01"', async () => {
    const r = await resolveTarget({
      basePath: tmpRoot,
      publicPrefix: '/media',
      mediaType: 'tv',
      mediaTitle: 'Some Show',
      langCode: 'en',
      season: '01',
      episode: '3'
    });
    expect(r.srtPublicUrl).toBe('/media/tv/Some%20Show/Season%201/Some%20Show%20-%20S01E03.en.auto.srt');
  });

  it('finds "Season 01" folder when called with unpadded season "1"', async () => {
    const r = await resolveTarget({
      basePath: tmpRoot,
      publicPrefix: '/media',
      mediaType: 'tv',
      mediaTitle: "A Grunt's Life",
      langCode: 'en',
      season: '1',
      episode: '10'
    });
    expect(r.srtFilename).toBe("A Grunt's Life - S01E10.en.auto.srt");
    // Apostrophe gets percent-encoded; folder is "Season 01" on disk
    expect(r.srtPublicUrl).toContain('/Season%2001/');
  });

  it('matches a season folder with extra text after the number', async () => {
    const r = await resolveTarget({
      basePath: tmpRoot,
      publicPrefix: '/media',
      mediaType: 'tv',
      mediaTitle: 'Other Show',
      langCode: 'en',
      season: '2',
      episode: '1'
    });
    expect(r.srtPublicUrl).toContain('/Season%202%20-%20Pilot%20Arc/');
  });

  it('throws a clear error when the season folder is missing', async () => {
    await expect(
      resolveTarget({
        basePath: tmpRoot,
        mediaType: 'tv',
        mediaTitle: 'Some Show',
        langCode: 'en',
        season: '99',
        episode: '1'
      })
    ).rejects.toThrow(/Season 99 not found/);
  });

  it('rejects non-numeric season values', async () => {
    await expect(
      resolveTarget({
        basePath: tmpRoot,
        mediaType: 'tv',
        mediaTitle: 'Some Show',
        langCode: 'en',
        season: 'abc',
        episode: '1'
      })
    ).rejects.toThrow(/must be numeric/);
  });
});
