/**
 * Unit tests for Branch 3 + Branch 2 decision logic in MetadataGenerator:
 *  - reason classification on the failure path ('no-match' vs 'transient-error')
 *  - preserved freeze reasons ('updates-disabled' / 'updates-disabled-overrides-applied')
 *  - refreshMissingEpisodes surfacing `expired` for episodes past the give-up window
 *  - G-3: the up-to-date branch adopts the trusted id from metadata.json
 *    instead of running an unvalidated name search
 *
 * Follows the caption-controller mock pattern: jest.unstable_mockModule for the
 * TMDB / image-downloader boundaries, real fileUtils + tmdbConfig against a
 * temp media tree.
 */

import { describe, it, expect, jest, beforeEach, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// Mock the TMDB boundary. The mock must export TmdbNoMatchError itself so the
// generator's `instanceof` check sees the same class the tests throw.
class TmdbNoMatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TmdbNoMatchError';
    this.code = 'no-match';
  }
}
const fetchComprehensiveMediaDetails = jest.fn();
const getEpisodeDetails = jest.fn();
jest.unstable_mockModule('../../../utils/tmdb.mjs', () => ({
  TmdbNoMatchError,
  fetchComprehensiveMediaDetails,
  getEpisodeDetails,
  makeTmdbRequest: jest.fn(),
}));

// Mock the image downloader (network + blurhash side effects).
const downloadMediaImages = jest.fn().mockResolvedValue({});
const downloadEpisodeThumbnail = jest.fn().mockResolvedValue({ outcome: 'downloaded' });
jest.unstable_mockModule('../../../utils/imageDownloader.mjs', () => ({
  downloadMediaImages,
  downloadSeasonPoster: jest.fn(),
  downloadEpisodeThumbnail,
}));

// utils.mjs drags in native blurhash bindings; the generator only needs
// getLastModifiedTime from it.
jest.unstable_mockModule('../../../utils/utils.mjs', () => ({
  getLastModifiedTime: jest.fn().mockResolvedValue(null),
}));

const { MetadataGenerator, refreshMissingEpisodes, isFrozenReason } = await import('../../../lib/metadataGenerator.mjs');
const { getEpisodeMetadataPath } = await import('../../../utils/fileUtils.mjs');

const DAY_MS = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

let baseDir;

beforeAll(async () => {
  baseDir = join(tmpdir(), `metadata-reason-test-${randomUUID()}`);
  await fs.mkdir(join(baseDir, 'movies'), { recursive: true });
  await fs.mkdir(join(baseDir, 'tv'), { recursive: true });
});

afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
});

async function makeGenerator() {
  return MetadataGenerator.create({ basePath: baseDir, forceRefresh: false, generateBlurhash: false });
}

describe('failure reason classification', () => {
  it('generateForMovie returns reason "no-match" on a typed no-match error', async () => {
    await fs.mkdir(join(baseDir, 'movies', 'No Such Movie (1999)'), { recursive: true });
    fetchComprehensiveMediaDetails.mockRejectedValue(
      new TmdbNoMatchError('No results found for movie: No Such Movie (1999)')
    );

    const generator = await makeGenerator();
    const result = await generator.generateForMovie('No Such Movie (1999)');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('no-match');
    expect(result.error).toMatch(/No results found/);
  });

  it('generateForMovie returns reason "transient-error" on a generic fetch error', async () => {
    await fs.mkdir(join(baseDir, 'movies', 'Flaky Movie (2001)'), { recursive: true });
    fetchComprehensiveMediaDetails.mockRejectedValue(
      new Error('TMDB API request failed: Request failed with status code 500')
    );

    const generator = await makeGenerator();
    const result = await generator.generateForMovie('Flaky Movie (2001)');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('transient-error');
  });

  it('generateForShow returns reason "no-match" on a typed no-match error', async () => {
    await fs.mkdir(join(baseDir, 'tv', 'No Such Show'), { recursive: true });
    fetchComprehensiveMediaDetails.mockRejectedValue(
      new TmdbNoMatchError('No results found for tv: No Such Show')
    );

    const generator = await makeGenerator();
    const result = await generator.generateForShow('No Such Show');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('no-match');
  });

  it('generateForShow returns reason "transient-error" on a generic fetch error', async () => {
    await fs.mkdir(join(baseDir, 'tv', 'Flaky Show'), { recursive: true });
    fetchComprehensiveMediaDetails.mockRejectedValue(new Error('TMDB API request failed after 3 retries'));

    const generator = await makeGenerator();
    const result = await generator.generateForShow('Flaky Show');

    expect(result.success).toBe(false);
    expect(result.reason).toBe('transient-error');
  });
});

describe('freeze reasons are preserved', () => {
  it('frozen movie with no overrides returns "updates-disabled" and never fetches', async () => {
    const dir = join(baseDir, 'movies', 'Frozen Movie (2010)');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'tmdb.config'), JSON.stringify({ update_metadata: false }));

    const generator = await makeGenerator();
    const result = await generator.generateForMovie('Frozen Movie (2010)');

    expect(result).toEqual({ success: true, updated: false, reason: 'updates-disabled' });
    expect(fetchComprehensiveMediaDetails).not.toHaveBeenCalled();
  });

  it('frozen movie with overrides returns "updates-disabled-overrides-applied" and writes metadata.json', async () => {
    const dir = join(baseDir, 'movies', 'Frozen Override (2011)');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'tmdb.config'),
      JSON.stringify({ update_metadata: false, metadata: { title: 'Manual Title' } })
    );

    const generator = await makeGenerator();
    const result = await generator.generateForMovie('Frozen Override (2011)');

    expect(result).toEqual({ success: true, updated: true, reason: 'updates-disabled-overrides-applied' });
    expect(fetchComprehensiveMediaDetails).not.toHaveBeenCalled();
    const written = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8'));
    expect(written.title).toBe('Manual Title');
  });
});

describe('isFrozenReason (scanner-facing reason contract)', () => {
  it('recognizes exactly the two frozen reasons', () => {
    expect(isFrozenReason('updates-disabled')).toBe(true);
    expect(isFrozenReason('updates-disabled-overrides-applied')).toBe(true);
  });

  it('rejects failure reasons and absent reasons', () => {
    expect(isFrozenReason('no-match')).toBe(false);
    expect(isFrozenReason('transient-error')).toBe(false);
    expect(isFrozenReason('up-to-date')).toBe(false);
    expect(isFrozenReason(null)).toBe(false);
    expect(isFrozenReason(undefined)).toBe(false);
  });
});

describe('G-3: up-to-date branch adopts the id from metadata.json', () => {
  it('uses the trusted id from a fresh metadata.json instead of a name search, and pins it via the ratchet', async () => {
    const dir = join(baseDir, 'tv', 'Fresh Show With Id');
    await fs.mkdir(dir, { recursive: true });
    // Fresh metadata.json (mtime = now) with a trusted id → the up-to-date
    // branch must not fetch at all.
    await fs.writeFile(
      join(dir, 'metadata.json'),
      JSON.stringify({ id: 4242, name: 'Fresh Show With Id', overview: 'from a previous full generation' })
    );

    const generator = await makeGenerator();
    const result = await generator.generateForShow('Fresh Show With Id');

    expect(result.success).toBe(true);
    expect(fetchComprehensiveMediaDetails).not.toHaveBeenCalled();
    // No fetch happened → no pristine payload this invocation.
    expect(result.pristineMetadata).toBe(null);
    // The adopted id is persisted through the add-only ratchet.
    const config = JSON.parse(await fs.readFile(join(dir, 'tmdb.config'), 'utf8'));
    expect(config.tmdb_id).toBe(4242);
  });

  it('falls back to the name search only when the fresh metadata.json carries no usable id', async () => {
    const dir = join(baseDir, 'tv', 'Fresh Show No Id');
    await fs.mkdir(dir, { recursive: true });
    // Fresh, parseable, but id-less (e.g. an override-only file recreated
    // while frozen, later unfrozen).
    await fs.writeFile(join(dir, 'metadata.json'), JSON.stringify({ overview: 'no id here' }));
    fetchComprehensiveMediaDetails.mockResolvedValue({ id: 777, name: 'Fresh Show No Id' });

    const generator = await makeGenerator();
    const result = await generator.generateForShow('Fresh Show No Id');

    expect(result.success).toBe(true);
    expect(fetchComprehensiveMediaDetails).toHaveBeenCalledTimes(1);
    expect(fetchComprehensiveMediaDetails).toHaveBeenCalledWith('Fresh Show No Id', 'tv', null, false);
    // The corner fetch is genuine → pristine payload captured (G-5).
    expect(result.pristineMetadata).toBe(JSON.stringify({ id: 777, name: 'Fresh Show No Id' }));
    const config = JSON.parse(await fs.readFile(join(dir, 'tmdb.config'), 'utf8'));
    expect(config.tmdb_id).toBe(777);
  });
});

describe('B-1: scanner-triggered fetches never request embedded blurhash', () => {
  it('generateForMovie fetches with includeBlurhash=false even when configured generateBlurhash=true, while the sidecar path keeps the config value', async () => {
    await fs.mkdir(join(baseDir, 'movies', 'Blurhash Movie (2020)'), { recursive: true });
    fetchComprehensiveMediaDetails.mockResolvedValue({ id: 55, title: 'Blurhash Movie' });

    const generator = await MetadataGenerator.create({ basePath: baseDir, forceRefresh: false, generateBlurhash: true });
    const result = await generator.generateForMovie('Blurhash Movie (2020)');

    expect(result.success).toBe(true);
    expect(fetchComprehensiveMediaDetails).toHaveBeenCalledWith('Blurhash Movie (2020)', 'movie', null, false);
    // The consumed pipeline — sidecar .blurhash files via downloadMediaImages —
    // stays governed by the config flag.
    expect(downloadMediaImages).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'movie',
      expect.objectContaining({ generateBlurhash: true })
    );
  });

  it('generateForShow fetches with includeBlurhash=false on the pinned-id path', async () => {
    const dir = join(baseDir, 'tv', 'Blurhash Show');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'tmdb.config'), JSON.stringify({ tmdb_id: 4321 }));
    fetchComprehensiveMediaDetails.mockResolvedValue({ id: 4321, name: 'Blurhash Show' });

    const generator = await MetadataGenerator.create({ basePath: baseDir, forceRefresh: false, generateBlurhash: true });
    const result = await generator.generateForShow('Blurhash Show');

    expect(result.success).toBe(true);
    expect(fetchComprehensiveMediaDetails).toHaveBeenCalledWith('Blurhash Show', 'tv', 4321, false);
  });
});

describe('refreshMissingEpisodes expired signal', () => {
  let seasonPath;

  beforeAll(async () => {
    seasonPath = join(baseDir, 'tv', 'Expiry Show', 'Season 1');
    await fs.mkdir(seasonPath, { recursive: true });
  });

  const writeEpisode = async (episodeNumber, data) => {
    await fs.writeFile(getEpisodeMetadataPath(seasonPath, episodeNumber), JSON.stringify(data));
  };

  it('flags an episode past the give-up window as expired without fetching', async () => {
    await writeEpisode(1, { air_date: daysAgo(200) }); // sparse + long past window

    const [outcome] = await refreshMissingEpisodes(123, [
      { seasonNumber: 1, episodeNumber: 1, seasonPath, lastAttempt: null },
    ]);

    expect(outcome).toMatchObject({ expired: true, attempted: false, written: false, resolved: false });
    expect(outcome.airDate).toBe(daysAgo(200));
    expect(getEpisodeDetails).not.toHaveBeenCalled();
  });

  it('expired wins even when a cooldown row exists (row can be pruned)', async () => {
    await writeEpisode(2, { air_date: daysAgo(120) });

    const [outcome] = await refreshMissingEpisodes(123, [
      { seasonNumber: 1, episodeNumber: 2, seasonPath, lastAttempt: new Date().toISOString() },
    ]);

    expect(outcome.expired).toBe(true);
    expect(outcome.attempted).toBe(false);
  });

  it('does not flag a TBA episode (no air_date) as expired', async () => {
    await writeEpisode(3, { overview: 'thin, no air date' });

    const [outcome] = await refreshMissingEpisodes(123, [
      { seasonNumber: 1, episodeNumber: 3, seasonPath, lastAttempt: null },
    ]);

    expect(outcome).toMatchObject({ expired: false, attempted: false, written: false, resolved: false });
  });

  it('a due in-window episode is still attempted (not expired)', async () => {
    await writeEpisode(4, { air_date: daysAgo(10) });
    getEpisodeDetails.mockResolvedValue({ air_date: daysAgo(10) }); // still sparse

    const [outcome] = await refreshMissingEpisodes(123, [
      { seasonNumber: 1, episodeNumber: 4, seasonPath, lastAttempt: null },
    ]);

    expect(outcome).toMatchObject({ expired: false, attempted: true, written: false });
    expect(getEpisodeDetails).toHaveBeenCalledTimes(1);
  });

  it('a due episode with a full TMDB response is written (not expired)', async () => {
    await writeEpisode(5, { air_date: daysAgo(10) });
    getEpisodeDetails.mockResolvedValue({
      name: 'Filled In',
      overview: 'Now complete',
      still_path: '/abc.jpg',
      air_date: daysAgo(10),
    });

    const [outcome] = await refreshMissingEpisodes(123, [
      { seasonNumber: 1, episodeNumber: 5, seasonPath, lastAttempt: null },
    ]);

    expect(outcome).toMatchObject({ expired: false, attempted: true, written: true });
    expect(downloadEpisodeThumbnail).toHaveBeenCalledTimes(1);
  });

  it('an already-complete on-disk file reports resolved (not expired)', async () => {
    await writeEpisode(6, {
      name: 'Done',
      overview: 'Complete already',
      still_path: '/done.jpg',
      air_date: daysAgo(200),
    });

    const [outcome] = await refreshMissingEpisodes(123, [
      { seasonNumber: 1, episodeNumber: 6, seasonPath, lastAttempt: null },
    ]);

    expect(outcome).toMatchObject({ resolved: true, expired: false, attempted: false });
  });
});
