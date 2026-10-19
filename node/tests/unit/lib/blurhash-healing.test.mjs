/**
 * The startup blurhash healing pass (lib/blurhashHealing.mjs): which images
 * it looks at, and what it does with each.
 *
 *  - The image list comes from the rows: movie and show posters and backdrops by stored path
 *    (by URL for an older row without one), season posters and episode
 *    thumbnails by URL, decoded and stripped of the prefix and `?hash=`.
 *  - A missing sidecar of an existing image is written; an SVG, an image with
 *    a sidecar, and an image whose file is gone are left alone. A logo is not
 *    looked at: it has no blurhash.
 *  - A generation that fails or throws is counted as failed and the pass goes
 *    on. The last block runs the real encoder: a corrupt image is a failure,
 *    not an exception.
 */

import { describe, it, expect, jest, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const { fileForPublishedUrl, publishedImagePaths, healMissingBlurhashSidecars } = await import(
  '../../../lib/blurhashHealing.mjs'
);

const BASE = join(tmpdir(), 'healing-base');
const PREFIX = '/media';

describe('fileForPublishedUrl', () => {
  it('maps a published URL to its file: prefix and token removed, segments decoded', () => {
    expect(fileForPublishedUrl('/media/tv/Some%20Show/Season%2001/01%20-%20Thumbnail.jpg?hash=abc', { basePath: BASE, prefixPath: PREFIX }))
      .toBe(join(BASE, 'tv', 'Some Show', 'Season 01', '01 - Thumbnail.jpg'));
    expect(fileForPublishedUrl('/movies/A%20Movie/poster.jpg', { basePath: BASE }))
      .toBe(join(BASE, 'movies', 'A Movie', 'poster.jpg'));
  });

  it('refuses anything that is not a media URL under the prefix', () => {
    const opts = { basePath: BASE, prefixPath: PREFIX };
    for (const url of [
      null,
      '',
      '/other/tv/Show/x.jpg',
      '/media/cache/x.jpg',
      '/media/tv/x.jpg',
      '/media/tv/..%2F..%2Fetc/passwd',
      '/media/tv/Show/../../x.jpg',
      '/media/tv/Show/%E0%A4%A.jpg',
      'https://image.tmdb.org/t/p/original/x.jpg',
    ]) {
      expect({ url, file: fileForPublishedUrl(url, opts) }).toEqual({ url, file: null });
    }
  });
});

describe('publishedImagePaths', () => {
  it('lists movie and show posters and backdrops, season posters and episode thumbnails, each once, and no logo', () => {
    const movies = [
      { name: 'A', posterFilePath: '/lib/movies/A/poster.jpg', backdropFilePath: '/lib/movies/A/backdrop.jpg', logoFilePath: '/lib/movies/A/logo.png', urls: {} },
      // An older row with no stored paths: its URLs stand in.
      { name: 'B', urls: { poster: '/media/movies/B/poster.png?hash=1', logo: '/media/movies/B/logo.png?hash=5' } },
    ];
    const shows = [
      {
        name: 'S',
        posterFilePath: '/lib/tv/S/show_poster.jpg',
        backdropFilePath: null,
        backdrop: '/media/tv/S/show_backdrop.jpg?hash=2',
        logoFilePath: '/lib/tv/S/show_logo.png',
        logo: '/media/tv/S/show_logo.png?hash=6',
        seasons: {
          'Season 1': {
            season_poster: '/media/tv/S/Season%2001/season_poster.jpg?hash=3',
            episodes: {
              S01E01: { thumbnail: '/media/tv/S/Season%2001/01%20-%20Thumbnail.jpg?hash=4' },
              S01E02: {},
              S01E03: null,
            },
          },
          'Season 2': null,
        },
      },
      { name: 'T', seasons: null },
    ];

    expect(publishedImagePaths({ movies, shows, basePath: BASE, prefixPath: PREFIX })).toEqual([
      '/lib/movies/A/poster.jpg',
      '/lib/movies/A/backdrop.jpg',
      join(BASE, 'movies', 'B', 'poster.png'),
      '/lib/tv/S/show_poster.jpg',
      join(BASE, 'tv', 'S', 'show_backdrop.jpg'),
      join(BASE, 'tv', 'S', 'Season 01', 'season_poster.jpg'),
      join(BASE, 'tv', 'S', 'Season 01', '01 - Thumbnail.jpg'),
    ]);
  });
});

describe('healMissingBlurhashSidecars', () => {
  // A fake file system: the files that exist.
  const run = async (files, rows, generate) => {
    const present = new Set(files);
    const exists = jest.fn(async (path) => present.has(path));
    const summary = await healMissingBlurhashSidecars({ ...rows, basePath: BASE, prefixPath: PREFIX, exists, generate });
    return { summary, exists };
  };

  it('writes the sidecar of an existing image that has none', async () => {
    const generate = jest.fn(async () => '/media/movies/A/poster.jpg.blurhash');
    const { summary } = await run(['/m/A/poster.jpg'], { movies: [{ posterFilePath: '/m/A/poster.jpg' }] }, generate);
    expect(generate).toHaveBeenCalledWith('/m/A/poster.jpg', BASE);
    expect(summary).toEqual({ checked: 1, generated: 1, failed: 0 });
  });

  it('leaves an SVG, an image with a sidecar and an image whose file is gone alone', async () => {
    const generate = jest.fn(async () => 'url');
    const { summary, exists } = await run(
      ['/m/S/show_poster.svg', '/m/A/poster.jpg', '/m/A/poster.jpg.blurhash'],
      {
        movies: [{ posterFilePath: '/m/A/poster.jpg', backdropFilePath: '/m/A/backdrop.jpg' }],
        shows: [{ posterFilePath: '/m/S/show_poster.svg' }],
      },
      generate
    );
    expect(generate).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 2, generated: 0, failed: 0 });
    // An SVG is not even stat'ed; an image with a sidecar costs one stat.
    expect(exists.mock.calls.map(([path]) => path)).toEqual([
      '/m/A/poster.jpg.blurhash',
      '/m/A/backdrop.jpg.blurhash',
      '/m/A/backdrop.jpg',
    ]);
  });

  it('ignores a logo with no sidecar: no stat, no generation', async () => {
    const generate = jest.fn(async () => 'url');
    const { summary, exists } = await run(
      ['/m/A/logo.png', '/m/B/logo.jpg', '/m/S/show_logo.png', '/m/S/show_poster.jpg', '/m/S/show_poster.jpg.blurhash'],
      {
        movies: [
          { logoFilePath: '/m/A/logo.png' },
          // An older row: the logo comes by URL only.
          { urls: { logo: '/media/movies/B/logo.jpg?hash=1' } },
        ],
        shows: [{ posterFilePath: '/m/S/show_poster.jpg', logoFilePath: '/m/S/show_logo.png', logo: '/media/tv/S/show_logo.png?hash=2' }],
      },
      generate
    );
    expect(generate).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, generated: 0, failed: 0 });
    expect(exists.mock.calls.map(([path]) => path)).toEqual(['/m/S/show_poster.jpg.blurhash']);
  });

  it('counts a generation that fails or throws as failed, and goes on', async () => {
    const generate = jest.fn(async (path) => {
      if (path.endsWith('/poster.jpg')) return null;
      if (path.endsWith('backdrop.jpg')) throw new Error('decoder blew up');
      return 'url';
    });
    const { summary } = await run(
      ['/m/A/poster.jpg', '/m/A/backdrop.jpg', '/m/S/show_poster.jpg'],
      {
        movies: [{ posterFilePath: '/m/A/poster.jpg', backdropFilePath: '/m/A/backdrop.jpg' }],
        shows: [{ posterFilePath: '/m/S/show_poster.jpg' }],
      },
      generate
    );
    expect(generate).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({ checked: 3, generated: 1, failed: 2 });
  });
});

describe('healMissingBlurhashSidecars with the real encoder', () => {
  const root = join(tmpdir(), `blurhash-healing-${randomUUID()}`);
  const JPEG = fileURLToPath(new URL('../../fixtures/backdrops/backdrop (7).jpg', import.meta.url));

  afterAll(async () => {
    const { destroyPool } = await import('../../../lib/blurhash-pool.mjs');
    await destroyPool();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('writes the missing sidecar, skips the logo and the existing sidecar, and counts a corrupt image as failed', async () => {
    const dir = join(root, 'movies', 'A Movie');
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(JPEG, join(dir, 'poster.jpg'));
    await fs.copyFile(JPEG, join(dir, 'backdrop.jpg'));
    await fs.writeFile(join(dir, 'backdrop.jpg.blurhash'), 'kept as it is');
    await fs.copyFile(JPEG, join(dir, 'logo.jpg'));
    const showDir = join(root, 'tv', 'A Show', 'Season 01');
    await fs.mkdir(showDir, { recursive: true });
    await fs.writeFile(join(showDir, '01 - Thumbnail.jpg'), 'not an image');

    const movies = [{
      posterFilePath: join(dir, 'poster.jpg'),
      backdropFilePath: join(dir, 'backdrop.jpg'),
      logoFilePath: join(dir, 'logo.jpg'),
    }];
    const shows = [{
      seasons: {
        'Season 1': { episodes: { S01E01: { thumbnail: '/tv/A%20Show/Season%2001/01%20-%20Thumbnail.jpg?hash=1' } } },
      },
    }];

    const summary = await healMissingBlurhashSidecars({ movies, shows, basePath: root });

    expect(summary).toEqual({ checked: 3, generated: 1, failed: 1 });
    expect((await fs.readFile(join(dir, 'poster.jpg.blurhash'), 'utf8')).length).toBeGreaterThan(0);
    expect(await fs.readFile(join(dir, 'backdrop.jpg.blurhash'), 'utf8')).toBe('kept as it is');
    await expect(fs.access(join(dir, 'logo.jpg.blurhash'))).rejects.toThrow();
    await expect(fs.access(join(showDir, '01 - Thumbnail.jpg.blurhash'))).rejects.toThrow();
  }, 60000);
});
