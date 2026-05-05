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
});
