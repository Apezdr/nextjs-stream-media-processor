/**
 * Regression: the scanner's own tmdb.config write must not read back as an
 * operator edit.
 *
 * `updateTmdbConfigWithId()` rewrites tmdb.config when it pins a newly matched
 * id. The config mtime used to be read AFTER that write, so reconcile's
 * stale-by-config branch compared art against OUR OWN write and judged every
 * image downloaded before the pin as stale — deleting and re-downloading a
 * byte-identical file, once per newly matched title. Observed in production
 * (enforce mode): all three deletions in a week were this false positive, with
 * `reconcile.config_mtime` matching the scanner's own "Added tmdb_id" log to
 * the millisecond.
 *
 * These tests drive the REAL tmdbConfig/fileUtils modules against a temp tree
 * so the mtime ordering is genuine, and pin the two halves of the contract:
 * our own pin must not delete; a real operator edit still must.
 *
 * SCANNER_RECONCILE_MODE=enforce is set before import (RECONCILE_MODE is a
 * module-level const resolved at import time), so deletions here are real.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

process.env.SCANNER_RECONCILE_MODE = 'enforce';

const fetchComprehensiveMediaDetails = jest.fn();
jest.unstable_mockModule('../../../utils/tmdb.mjs', () => ({
  TmdbNoMatchError: class TmdbNoMatchError extends Error {},
  fetchComprehensiveMediaDetails,
  getEpisodeDetails: jest.fn(),
  makeTmdbRequest: jest.fn(),
}));

// No-op downloader: if reconcile deletes the poster, nothing puts it back, so
// the assertion below sees the deletion instead of a self-healed re-download.
const downloadMediaImages = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../../../utils/imageDownloader.mjs', () => ({
  downloadMediaImages,
  downloadSeasonPoster: jest.fn(),
  downloadEpisodeThumbnail: jest.fn(),
}));

// utils.mjs drags in native blurhash bindings; the generator only needs
// getLastModifiedTime. Real fs.stat semantics — mtime ordering IS the subject.
jest.unstable_mockModule('../../../utils/utils.mjs', () => ({
  getLastModifiedTime: async (p) => {
    try {
      return (await fs.stat(p)).mtime;
    } catch {
      return null;
    }
  },
}));

const { MetadataGenerator } = await import('../../../lib/metadataGenerator.mjs');

let baseDir;

beforeAll(async () => {
  baseDir = join(tmpdir(), `reconcile-self-pin-test-${randomUUID()}`);
  await fs.mkdir(join(baseDir, 'movies'), { recursive: true });
});

afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

const exists = (p) => fs.access(p).then(() => true, () => false);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Movie dir where tmdb.config is written FIRST and poster.jpg AFTER it — the
 * natural order for art downloaded during a scan. Any later config write
 * (ours or the operator's) inverts that ordering.
 */
async function makeMovie(name, config) {
  const dir = join(baseDir, 'movies', name);
  await fs.mkdir(dir, { recursive: true });
  const configPath = join(dir, 'tmdb.config');
  const posterPath = join(dir, 'poster.jpg');

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  await settle();
  await fs.writeFile(posterPath, 'jpeg-bytes', 'utf8');

  return { dir, configPath, posterPath };
}

const generate = async (movieName, posterPath) => {
  const generator = await MetadataGenerator.create({
    basePath: baseDir,
    forceRefresh: false,
    generateBlurhash: false,
  });
  return generator.generateForMovie(movieName, {
    previousPaths: { poster: posterPath, backdrop: null, logo: null },
    // NULL provenance → the stale-by-source-url branch skips (bootstrap
    // invariant), isolating the stale-by-config branch under test.
    previousSourceUrls: null,
  });
};

describe('reconcile stale-by-config vs. the scanner\'s own id pin', () => {
  it('does not delete art that predates the scanner pinning the tmdb_id', async () => {
    const name = 'Nightcrawler (2014)';
    // No tmdb_id → the fetch below matches by name and pins it, rewriting
    // tmdb.config and making it newer than the poster on disk.
    const { configPath, posterPath } = await makeMovie(name, { update_metadata: true });

    fetchComprehensiveMediaDetails.mockResolvedValue({
      id: 242582,
      title: 'Nightcrawler',
      poster_path: '/p.jpg',
    });

    await settle();
    await generate(name, posterPath);

    // Guard against a vacuous pass: the pin must actually have fired and
    // rewritten the config, otherwise there was no churn trigger to survive.
    const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(written.tmdb_id).toBe(242582);
    const configMtime = (await fs.stat(configPath)).mtime;
    const posterMtime = (await fs.stat(posterPath)).mtime;
    expect(configMtime.getTime()).toBeGreaterThan(posterMtime.getTime());

    // The poster is NOT stale — only our own pin touched the config.
    expect(await exists(posterPath)).toBe(true);
  });

  it('still deletes art older than a real operator edit to tmdb.config', async () => {
    const name = 'Operator Edited (2020)';
    // tmdb_id already present → no pin fires, so the only config write is the
    // operator's below.
    const { configPath, posterPath } = await makeMovie(name, {
      update_metadata: true,
      tmdb_id: 603,
    });

    fetchComprehensiveMediaDetails.mockResolvedValue({
      id: 603,
      title: 'Operator Edited',
      poster_path: '/p.jpg',
    });

    // Operator edits the config after the art landed — the genuine staleness
    // signal the branch exists to catch.
    await settle();
    await fs.writeFile(
      configPath,
      JSON.stringify({ update_metadata: true, tmdb_id: 603, override_poster: null }, null, 2),
      'utf8'
    );
    await settle();

    await generate(name, posterPath);

    expect(await exists(posterPath)).toBe(false);
  });
});
