/**
 * I-3 image source-URL provenance tests (generator side):
 *
 *  - sourceUrlsFromImageResults: download URLs are true provenance; cache-hits
 *    adopt ONLY into a NULL slot (bootstrap rule); everything else preserves
 *    (null) — so a pending stale-by-URL mismatch survives dry-run passes.
 *  - _reconcileImageOwnership stale-by-source-url branch (enforce mode):
 *    deletes a DB-tracked file whose recorded provenance differs from the
 *    current effective URL, and — the hard invariant — SKIPS the comparison
 *    entirely when the stored provenance is NULL (a naive NULL-means-mismatch
 *    rule would wipe every image in the library on the first post-deploy pass).
 *
 * SCANNER_RECONCILE_MODE is set to `enforce` before the module import (the
 * generator reads it once at import time), so deletions here are real unlinks
 * against the temp tree.
 */

import { describe, it, expect, jest, beforeEach, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// Must be set before metadataGenerator.mjs is imported — RECONCILE_MODE is a
// module-level const resolved at import time.
process.env.SCANNER_RECONCILE_MODE = 'enforce';

jest.unstable_mockModule('../../../utils/tmdb.mjs', () => ({
  TmdbNoMatchError: class TmdbNoMatchError extends Error {},
  fetchComprehensiveMediaDetails: jest.fn(),
  getEpisodeDetails: jest.fn(),
  makeTmdbRequest: jest.fn(),
}));

const downloadMediaImages = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../../../utils/imageDownloader.mjs', () => ({
  downloadMediaImages,
  downloadSeasonPoster: jest.fn(),
  downloadEpisodeThumbnail: jest.fn(),
}));

// utils.mjs drags in native blurhash bindings; the generator only needs
// getLastModifiedTime from it. Null keeps the mtime-based stale branch (branch
// 2) quiet so these tests isolate the source-URL branch (branch 3).
jest.unstable_mockModule('../../../utils/utils.mjs', () => ({
  getLastModifiedTime: jest.fn().mockResolvedValue(null),
}));

const { MetadataGenerator, sourceUrlsFromImageResults } = await import('../../../lib/metadataGenerator.mjs');

const CDN = 'https://image.tmdb.org/t/p/original';

let baseDir;

beforeAll(async () => {
  baseDir = join(tmpdir(), `source-url-provenance-test-${randomUUID()}`);
  await fs.mkdir(join(baseDir, 'movies'), { recursive: true });
});

afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sourceUrlsFromImageResults', () => {
  it('returns null for a null/absent results map', () => {
    expect(sourceUrlsFromImageResults(null)).toBeNull();
    expect(sourceUrlsFromImageResults(undefined)).toBeNull();
  });

  it('records the download URL as true provenance on a real download', () => {
    const out = sourceUrlsFromImageResults(
      { poster: { outcome: 'downloaded', url: `${CDN}/p.jpg` } },
      null
    );
    expect(out.poster).toBe(`${CDN}/p.jpg`);
  });

  it('adopts the effective URL on a cache-hit ONLY when nothing is stored (NULL bootstrap)', () => {
    const results = { poster: { outcome: 'cache-hit', url: `${CDN}/current.jpg` } };

    // Nothing stored → adopt.
    expect(sourceUrlsFromImageResults(results, null).poster).toBe(`${CDN}/current.jpg`);
    expect(sourceUrlsFromImageResults(results, { poster: null }).poster).toBe(`${CDN}/current.jpg`);

    // Something stored → preserve (null), even when it differs. Overwriting
    // here would paper over a pending stale-by-URL mismatch during dry-run
    // passes (the file on disk still holds the OLD url's bytes).
    expect(sourceUrlsFromImageResults(results, { poster: `${CDN}/old.jpg` }).poster).toBeNull();
    expect(sourceUrlsFromImageResults(results, { poster: `${CDN}/current.jpg` }).poster).toBeNull();
  });

  it('preserves (null) on failed / no-url / absent outcomes', () => {
    const out = sourceUrlsFromImageResults(
      {
        poster: { outcome: 'failed', url: `${CDN}/p.jpg` },
        backdrop: { success: false, path: null }, // downloader's untouched initial shape
        // logo absent entirely
      },
      null
    );
    expect(out).toEqual({ poster: null, backdrop: null, logo: null });
  });
});

describe('_reconcileImageOwnership stale-by-source-url (enforce)', () => {
  async function makeMovieDirWithPoster(name) {
    const dir = join(baseDir, 'movies', name);
    await fs.mkdir(dir, { recursive: true });
    const posterPath = join(dir, 'poster.jpg');
    await fs.writeFile(posterPath, 'jpeg-bytes');
    return { dir, posterPath };
  }

  async function reconcile({ dir, posterPath, previousSourceUrls, posterPathInMetadata = '/new.jpg' }) {
    const generator = await MetadataGenerator.create({
      basePath: baseDir, forceRefresh: false, generateBlurhash: false,
    });
    await generator._reconcileImageOwnership({
      mediaName: 'test',
      mediaDir: dir,
      mediaType: 'movie',
      tmdbConfig: { update_metadata: true, backdrop_focal: null },
      enhancedMetadata: { poster_path: posterPathInMetadata },
      previousPaths: { poster: posterPath, backdrop: null, logo: null },
      previousSourceUrls,
      tmdbConfigLastModified: null,
      transactionId: 'test-tx',
    });
  }

  const exists = (p) => fs.access(p).then(() => true, () => false);

  it('deletes a DB-tracked file whose recorded provenance differs from the current effective URL', async () => {
    const { dir, posterPath } = await makeMovieDirWithPoster('Url Moved (2024)');
    await reconcile({
      dir,
      posterPath,
      // Same extension (.jpg → .jpg) so the orphan branch stays quiet; only
      // the source-url mismatch can fire.
      previousSourceUrls: { poster: `${CDN}/old.jpg`, backdrop: null, logo: null },
    });
    expect(await exists(posterPath)).toBe(false);
  });

  it('NULL stored provenance skips the comparison — the file survives (bootstrap invariant)', async () => {
    const { dir, posterPath } = await makeMovieDirWithPoster('Null Provenance (2024)');
    await reconcile({ dir, posterPath, previousSourceUrls: { poster: null, backdrop: null, logo: null } });
    expect(await exists(posterPath)).toBe(true);

    // A wholly absent previousSourceUrls (pre-I-3 caller) must behave the same.
    await reconcile({ dir, posterPath, previousSourceUrls: null });
    expect(await exists(posterPath)).toBe(true);
  });

  it('matching provenance leaves the file alone', async () => {
    const { dir, posterPath } = await makeMovieDirWithPoster('Url Unchanged (2024)');
    await reconcile({
      dir,
      posterPath,
      previousSourceUrls: { poster: `${CDN}/new.jpg`, backdrop: null, logo: null },
    });
    expect(await exists(posterPath)).toBe(true);
  });

  it('a vanished effective URL preserves the file regardless of stored provenance', async () => {
    const { dir, posterPath } = await makeMovieDirWithPoster('Url Vanished (2024)');
    await reconcile({
      dir,
      posterPath,
      previousSourceUrls: { poster: `${CDN}/old.jpg`, backdrop: null, logo: null },
      posterPathInMetadata: null, // TMDB dropped the asset, no override
    });
    expect(await exists(posterPath)).toBe(true);
  });

  it('a non-DB-tracked path is never deleted by the source-url branch (ownership check)', async () => {
    const { dir, posterPath } = await makeMovieDirWithPoster('Manual File (2024)');
    const generator = await MetadataGenerator.create({
      basePath: baseDir, forceRefresh: false, generateBlurhash: false,
    });
    await generator._reconcileImageOwnership({
      mediaName: 'test',
      mediaDir: dir,
      mediaType: 'movie',
      tmdbConfig: { update_metadata: true, backdrop_focal: null },
      enhancedMetadata: { poster_path: '/new.jpg' },
      previousPaths: null, // first scan — nothing DB-tracked
      previousSourceUrls: { poster: `${CDN}/old.jpg`, backdrop: null, logo: null },
      tmdbConfigLastModified: null,
      transactionId: 'test-tx',
    });
    expect(await exists(posterPath)).toBe(true);
  });
});
