import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { join } from 'path';
import os from 'os';
import {
  isVideoFile,
  listVideoFiles,
  episodeFilePattern,
  episodeKeyFor,
  matchesEpisodeKey,
  findSeasonEntry,
  findEpisodeEntry,
  resolveMovieVideo,
  resolveSeasonDir,
  resolveEpisodeVideo,
} from '../../../utils/mediaResolution.mjs';
import { PathTraversalError } from '../../../utils/utils.mjs';

let tmpRoot;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'media-resolution-'));

  const write = async (dir, ...files) => {
    await fs.mkdir(dir, { recursive: true });
    for (const f of files) await fs.writeFile(join(dir, f), 'x');
  };

  // Movie in a single non-mp4 container
  await write(join(tmpRoot, 'movies', 'Mkv Movie'), 'Mkv.Movie.2005.mkv');
  // Movie in .mov — the container this pivot adds
  await write(join(tmpRoot, 'movies', 'Mov Movie'), 'Mov.Movie.mov');
  // Mixed containers: .mp4 must win (VIDEO_EXTENSIONS priority)
  await write(join(tmpRoot, 'movies', 'Mixed Movie'), 'Mixed Movie.mkv', 'Mixed Movie.mp4');
  // Non-video clutter must never be selected
  await write(
    join(tmpRoot, 'movies', 'Cluttered Movie'),
    'Cluttered.en.srt',
    'metadata.json',
    'poster.jpg',
    'Cluttered.mkv'
  );
  // Tdarr writes a valid container mid-transcode; it must be ignored
  await write(
    join(tmpRoot, 'movies', 'Tdarr Movie'),
    'Real.Movie.mkv',
    'Real.Movie-TdarrCacheFile-abc.mp4'
  );
  // Movie folder with no video at all
  await fs.mkdir(join(tmpRoot, 'movies', 'Empty Movie'), { recursive: true });

  // TV: padded season folder
  await write(join(tmpRoot, 'tv', 'Padded Show', 'Season 01'), 'Padded Show - S01E03.mkv');
  // TV: season folder with trailing text
  await write(join(tmpRoot, 'tv', 'Arc Show', 'Season 2 - Pilot Arc'), 'Arc Show.S02E01.mov');
  // TV: multiple episodes, must select the right one
  await write(
    join(tmpRoot, 'tv', 'Multi Show', 'Season 1'),
    'Multi Show - S01E01.mp4',
    'Multi Show - S01E02.mkv',
    'Multi Show - S01E03.mp4'
  );
  // TV: legacy "03 - Name" filename convention
  await write(join(tmpRoot, 'tv', 'Legacy Show', 'Season 1'), '03 - The Third One.mkv');
  // TV: a stray file whose name starts with a digit must not be read as a season
  await write(join(tmpRoot, 'tv', 'Stray Show'), 'Season 1 notes.txt');
  await write(join(tmpRoot, 'tv', 'Stray Show', 'Season 1'), 'Stray Show - S01E01.mp4');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('isVideoFile', () => {
  it.each([
    ['Movie.mp4', true],
    ['Movie.MKV', true],
    ['Movie.mov', true],
    ['Movie.m4v', true],
    ['Movie.avi', true],
    ['Movie.srt', false],
    ['Movie.mp4.info', false],
    ['metadata.json', false],
  ])('%s -> %s', (name, expected) => {
    expect(isVideoFile(name)).toBe(expected);
  });

  it('rejects Tdarr in-progress transcodes even though the container is valid', () => {
    expect(isVideoFile('Show-TdarrCacheFile-123.mp4')).toBe(false);
  });
});

describe('listVideoFiles', () => {
  it('orders by container priority, then name — never readdir order', async () => {
    const files = await listVideoFiles(join(tmpRoot, 'movies', 'Mixed Movie'));
    expect(files).toEqual(['Mixed Movie.mp4', 'Mixed Movie.mkv']);
  });

  it('excludes non-video files', async () => {
    const files = await listVideoFiles(join(tmpRoot, 'movies', 'Cluttered Movie'));
    expect(files).toEqual(['Cluttered.mkv']);
  });

  it('returns an empty array for an unreadable directory rather than throwing', async () => {
    await expect(listVideoFiles(join(tmpRoot, 'does-not-exist'))).resolves.toEqual([]);
  });
});

describe('episodeFilePattern / episodeKeyFor', () => {
  it('matches the standard S##E## token', () => {
    expect(episodeFilePattern(1, 3).test('Show - S01E03.mkv')).toBe(true);
    expect(episodeFilePattern(1, 3).test('Show - S01E30.mkv')).toBe(false);
  });

  it('matches the alternate leading-number form', () => {
    expect(episodeFilePattern(1, 3).test('03 - The Third One.mkv')).toBe(true);
  });

  it('normalises pre-padded and unpadded inputs identically', () => {
    expect(episodeKeyFor('01', '03')).toBe('S01E03');
    expect(episodeKeyFor(1, 3)).toBe('S01E03');
  });
});

describe('matchesEpisodeKey', () => {
  it('matches standard keys', () => {
    expect(matchesEpisodeKey('S01E03', 1, 3)).toBe(true);
    expect(matchesEpisodeKey('S01E03', 1, 4)).toBe(false);
    expect(matchesEpisodeKey('S02E03', 1, 3)).toBe(false);
  });

  it('matches the alternate "03 - Name" key form', () => {
    expect(matchesEpisodeKey('03 - The Third One', 1, 3)).toBe(true);
  });

  it('matches legacy loose keys, which two of the four old matchers dropped', () => {
    expect(matchesEpisodeKey('03 - Something', 1, 3)).toBe(true);
    expect(matchesEpisodeKey('Show 03 - Something', 1, 3)).toBe(true);
  });

  it('rejects non-numeric season/episode instead of throwing', () => {
    expect(matchesEpisodeKey('S01E03', 'abc', 3)).toBe(false);
    expect(matchesEpisodeKey('S01E03', 1, undefined)).toBe(false);
  });
});

describe('findSeasonEntry / findEpisodeEntry', () => {
  const showData = {
    name: 'Padded Show',
    seasons: {
      'Season 01': { episodes: { S01E03: { filename: 'Padded Show - S01E03.mkv', _id: 'a' } } },
      'Season 2 - Pilot Arc': { episodes: { S02E01: { filename: 'Arc.mov', _id: 'b' } } },
    },
  };

  it('finds a season by number, not by literal `Season ${n}` key', () => {
    // The old code did showData.seasons[`Season ${season}`], which misses both of these.
    expect(findSeasonEntry(showData, 1)?.seasonName).toBe('Season 01');
    expect(findSeasonEntry(showData, 2)?.seasonName).toBe('Season 2 - Pilot Arc');
    expect(findSeasonEntry(showData, '01')?.seasonName).toBe('Season 01');
  });

  it('returns null for a missing season instead of throwing', () => {
    expect(findSeasonEntry(showData, 99)).toBeNull();
    expect(findSeasonEntry({}, 1)).toBeNull();
  });

  it('finds an episode and returns its stored record', () => {
    const entry = findEpisodeEntry(showData, 1, 3);
    expect(entry?.episodeKey).toBe('S01E03');
    expect(entry?.episode.filename).toBe('Padded Show - S01E03.mkv');
    expect(entry?.seasonName).toBe('Season 01');
  });

  it('returns null for a missing episode', () => {
    expect(findEpisodeEntry(showData, 1, 99)).toBeNull();
  });
});

describe('resolveMovieVideo', () => {
  it('resolves an mkv-only movie', async () => {
    const ref = await resolveMovieVideo({ basePath: tmpRoot, movieName: 'Mkv Movie' });
    expect(ref.filename).toBe('Mkv.Movie.2005.mkv');
    expect(ref.container).toBe('mkv');
  });

  it('resolves a mov-only movie', async () => {
    const ref = await resolveMovieVideo({ basePath: tmpRoot, movieName: 'Mov Movie' });
    expect(ref.container).toBe('mov');
  });

  it('prefers the .mp4 in a mixed-container folder (scanner parity)', async () => {
    const ref = await resolveMovieVideo({ basePath: tmpRoot, movieName: 'Mixed Movie' });
    expect(ref.filename).toBe('Mixed Movie.mp4');
  });

  it('falls back to a stem match when the stored container is stale', async () => {
    // Stored filename says .mp4, Tdarr remuxed it to .mkv. This 404'd before.
    const ref = await resolveMovieVideo({
      basePath: tmpRoot,
      movieName: 'Mkv Movie',
      preferFilename: 'Mkv.Movie.2005.mp4',
    });
    expect(ref.filename).toBe('Mkv.Movie.2005.mkv');
  });

  it('honours an exact preferFilename over container priority', async () => {
    const ref = await resolveMovieVideo({
      basePath: tmpRoot,
      movieName: 'Mixed Movie',
      preferFilename: 'Mixed Movie.mkv',
    });
    expect(ref.filename).toBe('Mixed Movie.mkv');
  });

  it('ignores Tdarr cache files', async () => {
    const ref = await resolveMovieVideo({ basePath: tmpRoot, movieName: 'Tdarr Movie' });
    expect(ref.filename).toBe('Real.Movie.mkv');
  });

  it('returns null when the folder has no video', async () => {
    await expect(
      resolveMovieVideo({ basePath: tmpRoot, movieName: 'Empty Movie' })
    ).resolves.toBeNull();
  });

  it('returns null for a missing movie rather than throwing', async () => {
    await expect(
      resolveMovieVideo({ basePath: tmpRoot, movieName: 'No Such Movie' })
    ).resolves.toBeNull();
  });

  it('rejects a traversal attempt', async () => {
    await expect(
      resolveMovieVideo({ basePath: tmpRoot, movieName: '../../etc' })
    ).rejects.toThrow(PathTraversalError);
  });
});

describe('resolveSeasonDir', () => {
  it('matches a zero-padded season folder', async () => {
    const r = await resolveSeasonDir({ basePath: tmpRoot, showName: 'Padded Show', season: 1 });
    expect(r.seasonFolder).toBe('Season 01');
  });

  it('matches a season folder with trailing text', async () => {
    const r = await resolveSeasonDir({ basePath: tmpRoot, showName: 'Arc Show', season: 2 });
    expect(r.seasonFolder).toBe('Season 2 - Pilot Arc');
  });

  it('ignores files, matching only directories', async () => {
    // "Season 1 notes.txt" sits beside the real "Season 1" directory and would
    // satisfy a naive first-digit-run match over raw readdir entries.
    const r = await resolveSeasonDir({ basePath: tmpRoot, showName: 'Stray Show', season: 1 });
    expect(r.seasonFolder).toBe('Season 1');
  });

  it('returns null for a missing season', async () => {
    await expect(
      resolveSeasonDir({ basePath: tmpRoot, showName: 'Padded Show', season: 99 })
    ).resolves.toBeNull();
  });

  it('rejects a traversal attempt', async () => {
    await expect(
      resolveSeasonDir({ basePath: tmpRoot, showName: '../../etc', season: 1 })
    ).rejects.toThrow(PathTraversalError);
  });
});

describe('resolveEpisodeVideo', () => {
  it('resolves an mkv episode inside a padded season folder', async () => {
    const ref = await resolveEpisodeVideo({
      basePath: tmpRoot,
      showName: 'Padded Show',
      season: 1,
      episode: 3,
    });
    expect(ref.filename).toBe('Padded Show - S01E03.mkv');
  });

  it('resolves a mov episode in a season folder with trailing text', async () => {
    const ref = await resolveEpisodeVideo({
      basePath: tmpRoot,
      showName: 'Arc Show',
      season: 2,
      episode: 1,
    });
    expect(ref.container).toBe('mov');
  });

  it('selects the right episode among several, across containers', async () => {
    const ref = await resolveEpisodeVideo({
      basePath: tmpRoot,
      showName: 'Multi Show',
      season: 1,
      episode: 2,
    });
    expect(ref.filename).toBe('Multi Show - S01E02.mkv');
  });

  it('does not fall back to a different episode when the requested one is absent', async () => {
    // findMp4File's "any .mp4 in the directory" fallback would have returned
    // S01E01 here, silently serving the wrong episode.
    await expect(
      resolveEpisodeVideo({ basePath: tmpRoot, showName: 'Multi Show', season: 1, episode: 9 })
    ).resolves.toBeNull();
  });

  it('resolves the legacy "03 - Name" filename convention', async () => {
    const ref = await resolveEpisodeVideo({
      basePath: tmpRoot,
      showName: 'Legacy Show',
      season: 1,
      episode: 3,
    });
    expect(ref.filename).toBe('03 - The Third One.mkv');
  });

  it('falls back to a stem match when the stored container is stale', async () => {
    const ref = await resolveEpisodeVideo({
      basePath: tmpRoot,
      showName: 'Multi Show',
      season: 1,
      episode: 2,
      preferFilename: 'Multi Show - S01E02.mp4',
    });
    expect(ref.filename).toBe('Multi Show - S01E02.mkv');
  });

  it('accepts pre-padded season/episode inputs', async () => {
    const ref = await resolveEpisodeVideo({
      basePath: tmpRoot,
      showName: 'Multi Show',
      season: '01',
      episode: '03',
    });
    expect(ref.filename).toBe('Multi Show - S01E03.mp4');
  });

  it('rejects a traversal attempt', async () => {
    await expect(
      resolveEpisodeVideo({ basePath: tmpRoot, showName: '../../etc', season: 1, episode: 1 })
    ).rejects.toThrow(PathTraversalError);
  });
});
