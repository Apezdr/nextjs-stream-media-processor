/**
 * The media table generations (sqliteDatabase.mjs): every writer of movies and
 * tv_shows bumps its table's generation when, and only when, it changed a row.
 * The cached /media/tv and /media/movies bodies (lib/mediaPayloadCache.mjs)
 * are dropped at the end of a scan only when their table's generation moved.
 *
 * What it pins:
 *
 *   - an insert, an update that changes a column, and a delete of a present
 *     row each move their own table's generation by one, and only that table's;
 *   - a write that would leave the row as it is changes nothing: SQLite counts
 *     no change (total_changes) and the generation stays. That includes the TV
 *     upsert, which has no directory_hash guard, and a movie the movie guard
 *     lets through because its backdrop_focal_suggested is NULL;
 *   - every column an upsert writes is compared: changing any one argument
 *     lands, and moves the generation;
 *   - the COALESCE-preserved columns: a null for a stored value is no change;
 *   - a delete of a row that is not there changes nothing.
 *
 * Uses the MEDIA_DB_DIRECTORY test seam (set BEFORE sqliteDatabase.mjs is
 * imported), as the schema-parity suite does.
 */

import { describe, it, expect, jest, beforeAll, afterAll, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// utils/utils.mjs initializes the piscina blurhash worker pool at import time;
// the sqlite import chain only needs fileExists.
jest.unstable_mockModule('../../../utils/utils.mjs', () => ({
  fileExists: async (p) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
}));

// metadataHashes.mjs transitively imports lib/mongo.mjs, which constructs a
// real MongoClient at import time and keeps the Jest worker alive.
jest.unstable_mockModule('../../../lib/mongo.mjs', () => ({
  mongoClient: {
    db: () => {
      throw new Error('Mongo is not available in media-table-generation tests');
    },
  },
}));

const tmpDir = join(tmpdir(), `media-table-generation-test-${randomUUID()}`);
process.env.MEDIA_DB_DIRECTORY = tmpDir;
const jitBefore = process.env.JIT_ELIGIBILITY_ENABLED;

let sqliteDb;
let db;

beforeAll(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  sqliteDb = await import('../../../sqliteDatabase.mjs');
  db = await sqliteDb.initializeDatabase('main');
});

afterAll(async () => {
  await sqliteDb.closeAllDatabaseConnections();
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows can briefly hold the WAL file open; leave the temp dir behind.
  }
});

afterEach(() => {
  if (jitBefore === undefined) delete process.env.JIT_ELIGIBILITY_ENABLED;
  else process.env.JIT_ELIGIBILITY_ENABLED = jitBefore;
});

// ---------------------------------------------------------------- helpers

const generations = () => ({
  movies: sqliteDb.getMediaTableGeneration('movies'),
  tv_shows: sqliteDb.getMediaTableGeneration('tv_shows'),
});

async function totalChanges() {
  return (await db.get('SELECT total_changes() AS n')).n;
}

const rowOf = (table, name) => db.get(`SELECT * FROM ${table} WHERE name = ?`, [name]);

/**
 * Run `write` and report what it did: the rows SQLite counted as changed, how
 * far each generation moved, and the row before and after.
 */
async function measure(table, name, write) {
  const before = { row: await rowOf(table, name), generations: generations(), changes: await totalChanges() };
  await write();
  const after = { row: await rowOf(table, name), generations: generations(), changes: await totalChanges() };
  return {
    changes: after.changes - before.changes,
    moved: {
      movies: after.generations.movies - before.generations.movies,
      tv_shows: after.generations.tv_shows - before.generations.tv_shows,
    },
    before: before.row,
    after: after.row,
  };
}

// insertOrUpdateTVShow's arguments, in order, for one show.
function tvArgs(name, overrides = {}) {
  const args = {
    showName: name,
    metadata: '{"id":1}',
    metadataPath: '/tv/Show/metadata.json',
    poster: '/tv/Show/show.jpg',
    posterBlurhash: 'Lposter',
    logo: '/tv/Show/logo.png',
    logoBlurhash: 'Llogo',
    backdrop: '/tv/Show/backdrop.jpg',
    backdropBlurhash: 'Lbackdrop',
    seasonsObj: { 'Season 1': { episodes: { S01E01: { videoURL: '/tv/Show/Season%201/e1.mkv' } } } },
    posterFilePath: '/media/tv/Show/show.jpg',
    backdropFilePath: '/media/tv/Show/backdrop.jpg',
    logoFilePath: '/media/tv/Show/logo.png',
    basePath: '/media',
    directoryHash: 'dir-1',
    backdropFocal: '{"x":0.5,"y":0.5}',
    backdropFocalSuggested: '{"x":0.4,"y":0.6}',
    imageHashes: {
      poster: { hash: 'ph', mtime: 1001 },
      backdrop: { hash: 'bh', mtime: 1002 },
      logo: { hash: 'lh', mtime: 1003 },
    },
    pristineMetadata: '{"raw":1}',
    sourceUrls: { poster: 'https://img/p.jpg', backdrop: 'https://img/b.jpg', logo: 'https://img/l.png' },
    mediaId: 'mid:show',
    firstSeen: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
  return Object.values(args);
}

// insertOrUpdateMovie's arguments, in order, for one movie. No backdrop focal
// suggestion: the movie guard's backdrop_focal_suggested IS NULL hatch stays
// open, so the guard lets every write through and only the content decides.
function movieArgs(name, overrides = {}) {
  const args = {
    name,
    fileNames: ['movie.mkv'],
    lengths: { 'movie.mkv': 7200000 },
    dimensions: { 'movie.mkv': '1920x1080' },
    urls: { mp4: '/movies/M/movie.mkv' },
    metadataUrl: '/movies/M/metadata.json',
    hash: 'dir-1',
    hdr: 'HDR10',
    mediaQuality: { isHDR: true },
    additionalMetadata: { duration: 7200000 },
    _id: 'uuid-1',
    posterFilePath: '/media/movies/M/poster.jpg',
    backdropFilePath: '/media/movies/M/backdrop.jpg',
    logoFilePath: '/media/movies/M/logo.png',
    basePath: '/media',
    backdropFocal: '{"x":0.5,"y":0.5}',
    backdropFocalSuggested: null,
    imageHashes: {
      poster: { hash: 'ph', mtime: 1001 },
      backdrop: { hash: 'bh', mtime: 1002 },
      logo: { hash: 'lh', mtime: 1003 },
    },
    metadata: '{"id":2}',
    pristineMetadata: '{"raw":2}',
    sourceUrls: { poster: 'https://img/p.jpg', backdrop: 'https://img/b.jpg', logo: 'https://img/l.png' },
    mediaId: 'mid:movie',
    firstSeen: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
  return Object.values(args);
}

const imageHashVariants = (base) =>
  ['poster', 'backdrop', 'logo'].flatMap((kind) => [
    [`imageHashes.${kind}.hash`, { imageHashes: { ...base, [kind]: { ...base[kind], hash: `${kind}-new` } } }],
    [`imageHashes.${kind}.mtime`, { imageHashes: { ...base, [kind]: { ...base[kind], mtime: 9999 } } }],
  ]);

const sourceUrlVariants = (base) =>
  ['poster', 'backdrop', 'logo'].map((kind) => [
    `sourceUrls.${kind}`,
    { sourceUrls: { ...base, [kind]: `https://img/${kind}-new` } },
  ]);

// ---------------------------------------------------------------- tests

describe('getMediaTableGeneration', () => {
  it('is kept for movies and tv_shows only', () => {
    expect(Number.isInteger(sqliteDb.getMediaTableGeneration('movies'))).toBe(true);
    expect(Number.isInteger(sqliteDb.getMediaTableGeneration('tv_shows'))).toBe(true);
    expect(() => sqliteDb.getMediaTableGeneration('metadata_hashes')).toThrow(/metadata_hashes/);
  });
});

describe('insertOrUpdateTVShow', () => {
  it('moves tv_shows\' generation on an insert, and on nothing else', async () => {
    const result = await measure('tv_shows', 'Insert Show', () => sqliteDb.insertOrUpdateTVShow(...tvArgs('Insert Show')));
    expect(result.before).toBeUndefined();
    expect(result.after.name).toBe('Insert Show');
    expect(result.changes).toBe(1);
    expect(result.moved).toEqual({ movies: 0, tv_shows: 1 });
  });

  it('changes nothing when it would store what the row holds', async () => {
    await sqliteDb.insertOrUpdateTVShow(...tvArgs('Same Show'));
    const result = await measure('tv_shows', 'Same Show', () => sqliteDb.insertOrUpdateTVShow(...tvArgs('Same Show')));
    expect(result.changes).toBe(0);
    expect(result.moved).toEqual({ movies: 0, tv_shows: 0 });
    expect(result.after).toEqual(result.before);
  });

  it('keeps a stored value for a null on a COALESCE column, as no change', async () => {
    await sqliteDb.insertOrUpdateTVShow(...tvArgs('Coalesce Show'));
    const result = await measure('tv_shows', 'Coalesce Show', () =>
      sqliteDb.insertOrUpdateTVShow(
        ...tvArgs('Coalesce Show', { pristineMetadata: null, sourceUrls: null, mediaId: null, firstSeen: null })
      )
    );
    expect(result.changes).toBe(0);
    expect(result.moved.tv_shows).toBe(0);
    expect(result.after).toEqual(result.before);
    expect(result.after.pristine_metadata).toBe('{"raw":1}');
    expect(result.after.media_id).toBe('mid:show');
  });

  it('lands a change to any one column, and moves the generation', async () => {
    const base = tvArgs('Column Show');
    await sqliteDb.insertOrUpdateTVShow(...base);
    const baseHashes = { poster: { hash: 'ph', mtime: 1001 }, backdrop: { hash: 'bh', mtime: 1002 }, logo: { hash: 'lh', mtime: 1003 } };
    const baseUrls = { poster: 'https://img/p.jpg', backdrop: 'https://img/b.jpg', logo: 'https://img/l.png' };
    const variants = [
      ['metadata', { metadata: '{"id":1,"v":2}' }],
      ['metadataPath', { metadataPath: '/tv/Show/metadata.json?v=2' }],
      ['poster', { poster: '/tv/Show/show.png' }],
      ['posterBlurhash', { posterBlurhash: 'Lposter2' }],
      ['logo', { logo: '/tv/Show/logo.svg' }],
      ['logoBlurhash', { logoBlurhash: null }],
      ['backdrop', { backdrop: '/tv/Show/backdrop.png' }],
      ['backdropBlurhash', { backdropBlurhash: 'Lbackdrop2' }],
      ['seasonsObj', { seasonsObj: { 'Season 1': { episodes: { S01E01: {}, S01E02: {} } } } }],
      ['posterFilePath', { posterFilePath: '/media/tv/Show/show.png' }],
      ['backdropFilePath', { backdropFilePath: null }],
      ['logoFilePath', { logoFilePath: '/media/tv/Show/logo.svg' }],
      ['basePath', { basePath: '/media2' }],
      ['directoryHash', { directoryHash: 'dir-2' }],
      ['backdropFocal', { backdropFocal: null }],
      ['backdropFocalSuggested', { backdropFocalSuggested: '{"x":0.1,"y":0.1}' }],
      ...imageHashVariants(baseHashes),
      ['pristineMetadata', { pristineMetadata: '{"raw":2}' }],
      ...sourceUrlVariants(baseUrls),
      ['mediaId', { mediaId: 'mid:show-2' }],
      ['firstSeen', { firstSeen: '2025-01-01T00:00:00.000Z' }],
    ];

    for (const [label, override] of variants) {
      await sqliteDb.insertOrUpdateTVShow(...base); // back to the base row (moves the generation)
      const result = await measure('tv_shows', 'Column Show', () =>
        sqliteDb.insertOrUpdateTVShow(...tvArgs('Column Show', override))
      );
      expect({ label, changes: result.changes, moved: result.moved.tv_shows }).toEqual({ label, changes: 1, moved: 1 });
      expect({ label, same: JSON.stringify(result.after) === JSON.stringify(result.before) }).toEqual({ label, same: false });
    }

    // The payload signature is a column too (the JIT toggle feeds it).
    await sqliteDb.insertOrUpdateTVShow(...base);
    process.env.JIT_ELIGIBILITY_ENABLED = process.env.JIT_ELIGIBILITY_ENABLED === 'true' ? 'false' : 'true';
    const flipped = await measure('tv_shows', 'Column Show', () => sqliteDb.insertOrUpdateTVShow(...base));
    expect(flipped.moved.tv_shows).toBe(1);
    expect(flipped.after.payload_signature).not.toBe(flipped.before.payload_signature);
  });
});

describe('insertOrUpdateMovie', () => {
  it('moves movies\' generation on an insert, and on nothing else', async () => {
    const result = await measure('movies', 'Insert Movie', () => sqliteDb.insertOrUpdateMovie(...movieArgs('Insert Movie')));
    expect(result.before).toBeUndefined();
    expect(result.changes).toBe(1);
    expect(result.moved).toEqual({ movies: 1, tv_shows: 0 });
  });

  it('changes nothing when it would store what the row holds, though its guard is open', async () => {
    await sqliteDb.insertOrUpdateMovie(...movieArgs('Same Movie'));
    const stored = await rowOf('movies', 'Same Movie');
    // The guard lets this one through: backdrop_focal_suggested is NULL. Before
    // the content check, every reprocess of such a movie rewrote its row.
    expect(stored.backdrop_focal_suggested).toBeNull();

    const result = await measure('movies', 'Same Movie', () => sqliteDb.insertOrUpdateMovie(...movieArgs('Same Movie')));
    expect(result.changes).toBe(0);
    expect(result.moved).toEqual({ movies: 0, tv_shows: 0 });
    expect(result.after).toEqual(result.before);
  });

  it('changes nothing when its guard holds the write back', async () => {
    await sqliteDb.insertOrUpdateMovie(...movieArgs('Guarded Movie', { backdropFocalSuggested: '{"x":0.4,"y":0.6}' }));
    const result = await measure('movies', 'Guarded Movie', () =>
      sqliteDb.insertOrUpdateMovie(
        ...movieArgs('Guarded Movie', { backdropFocalSuggested: '{"x":0.4,"y":0.6}', hdr: 'Dolby Vision' })
      )
    );
    expect(result.changes).toBe(0);
    expect(result.moved.movies).toBe(0);
    expect(result.after.hdr).toBe('HDR10');
  });

  it('lands a change to any one column, and moves the generation', async () => {
    const base = movieArgs('Column Movie');
    await sqliteDb.insertOrUpdateMovie(...base);
    const baseHashes = { poster: { hash: 'ph', mtime: 1001 }, backdrop: { hash: 'bh', mtime: 1002 }, logo: { hash: 'lh', mtime: 1003 } };
    const baseUrls = { poster: 'https://img/p.jpg', backdrop: 'https://img/b.jpg', logo: 'https://img/l.png' };
    const variants = [
      ['fileNames', { fileNames: ['movie.mkv', 'movie.en.srt'] }],
      ['lengths', { lengths: { 'movie.mkv': 7200001 } }],
      ['dimensions', { dimensions: { 'movie.mkv': '3840x2160' } }],
      ['urls', { urls: { mp4: '/movies/M/movie2.mkv' } }],
      ['metadataUrl', { metadataUrl: '/movies/M/metadata.json?v=2' }],
      ['hash', { hash: 'dir-2' }],
      ['hdr', { hdr: null }],
      ['mediaQuality', { mediaQuality: null }],
      ['additionalMetadata', { additionalMetadata: { duration: 1 } }],
      ['_id', { _id: 'uuid-2' }],
      ['posterFilePath', { posterFilePath: null }],
      ['backdropFilePath', { backdropFilePath: '/media/movies/M/backdrop.png' }],
      ['logoFilePath', { logoFilePath: null }],
      ['basePath', { basePath: '/media2' }],
      ['backdropFocal', { backdropFocal: '{"x":0.1,"y":0.9}' }],
      ['backdropFocalSuggested', { backdropFocalSuggested: '{"x":0.3,"y":0.3}' }],
      ...imageHashVariants(baseHashes),
      ['metadata', { metadata: '{"id":3}' }],
      ['pristineMetadata', { pristineMetadata: '{"raw":3}' }],
      ...sourceUrlVariants(baseUrls),
      ['mediaId', { mediaId: 'mid:movie-2' }],
      ['firstSeen', { firstSeen: '2025-01-01T00:00:00.000Z' }],
    ];

    for (const [label, override] of variants) {
      // Back to the base row. Re-inserted rather than updated: a stored focal
      // suggestion closes the guard, which would hold the update back.
      await sqliteDb.deleteMovie('Column Movie');
      await sqliteDb.insertOrUpdateMovie(...base);
      const result = await measure('movies', 'Column Movie', () =>
        sqliteDb.insertOrUpdateMovie(...movieArgs('Column Movie', override))
      );
      expect({ label, changes: result.changes, moved: result.moved.movies }).toEqual({ label, changes: 1, moved: 1 });
      expect({ label, same: JSON.stringify(result.after) === JSON.stringify(result.before) }).toEqual({ label, same: false });
    }

    await sqliteDb.deleteMovie('Column Movie');
    await sqliteDb.insertOrUpdateMovie(...base);
    process.env.JIT_ELIGIBILITY_ENABLED = process.env.JIT_ELIGIBILITY_ENABLED === 'true' ? 'false' : 'true';
    const flipped = await measure('movies', 'Column Movie', () => sqliteDb.insertOrUpdateMovie(...base));
    expect(flipped.moved.movies).toBe(1);
    expect(flipped.after.payload_signature).not.toBe(flipped.before.payload_signature);
  });
});

describe('deleteMovie and deleteTVShow', () => {
  it('move their table\'s generation when a row goes, and not when there was none', async () => {
    await sqliteDb.insertOrUpdateMovie(...movieArgs('Doomed Movie'));
    await sqliteDb.insertOrUpdateTVShow(...tvArgs('Doomed Show'));

    const movie = await measure('movies', 'Doomed Movie', () => sqliteDb.deleteMovie('Doomed Movie'));
    expect(movie.after).toBeUndefined();
    expect(movie.changes).toBe(1);
    expect(movie.moved).toEqual({ movies: 1, tv_shows: 0 });

    const show = await measure('tv_shows', 'Doomed Show', () => sqliteDb.deleteTVShow('Doomed Show'));
    expect(show.after).toBeUndefined();
    expect(show.moved).toEqual({ movies: 0, tv_shows: 1 });

    const again = await measure('movies', 'Doomed Movie', async () => {
      await sqliteDb.deleteMovie('Doomed Movie');
      await sqliteDb.deleteTVShow('Doomed Show');
    });
    expect(again.changes).toBe(0);
    expect(again.moved).toEqual({ movies: 0, tv_shows: 0 });
  });
});
