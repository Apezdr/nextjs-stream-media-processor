/**
 * SI-P0 — "failed ≠ absent": per-item isolation in both scanners.
 *
 * Real fixture library → real scanner → real SQLite. Only the ffprobe/mediainfo
 * boundary and Mongo-backed config are mocked (same scaffold as
 * media-payload.test.mjs).
 *
 * WHAT THIS LOCKS IN. Before SI-P0:
 *   - one throwing movie directory rejected scanMovies' Promise.all, so the
 *     end-of-scan removal loop never ran (departed titles stayed in the DB
 *     forever) and — via app.mjs runGenerateList's sequential orchestration —
 *     the TV scan and autoSync were skipped for that tick, every tick;
 *   - one throwing show aborted every show after it AND the removal loop,
 *     because a single try/catch wrapped the whole loop;
 *   - the naive fix (per-item try/catch) would have been WORSE for movies:
 *     `existingMovieNames.delete(dirName)` ran after the first I/O, so a
 *     swallowed blip would have left the name in the removal set and the loop
 *     would have deleted a live movie.
 *
 * Two real failures are injected:
 *   - a dangling link INSIDE a title folder: readdir succeeds, then
 *     calculateDirectoryHash() stats every entry unguarded → fs.stat ENOENT
 *     (a vanished hardlink / temp file);
 *   - the title's OWN readdir rejecting ENOENT (spied): the folder disappeared
 *     between the root listing and its processing. This is the case that only
 *     "delete before ANY I/O" survives — a regression that moved the delete to
 *     just after the per-title readdir would pass the first injection and fail
 *     this one.
 * Plus a cascade failure (SQLite trigger on the title row) to prove per-title
 * isolation of the removal loop and the "title row is the retry anchor" order.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const tmpRoot = join(tmpdir(), `scan-fna-${randomUUID()}`);
const MEDIA = join(tmpRoot, 'media');
const DB_DIR = join(tmpRoot, 'db');

process.env.MEDIA_DB_DIRECTORY = DB_DIR;

// ---------------------------------------------------------------- mocks

const genericProbe = (name) => ({
  uuid: `uuid-${name}`, length: 1200000, dimensions: '1920x1080', hdr: null,
  mediaQuality: { isHDR: false },
  additionalMetadata: {
    format: { formatName: 'mov,mp4,m4a,3gp,3g2,mj2' },
    video: [{ codec: 'h264', pix_fmt: 'yuv420p', field_order: 'progressive' }],
    audio: [{ codec: 'aac', languageTag: 'eng' }],
  },
});

jest.unstable_mockModule('../../infoManager.mjs', () => ({
  CURRENT_VERSION: 1.0011,
  getInfo: jest.fn(async (filePath) => genericProbe(filePath.split(/[\\/]/).pop())),
  writeInfo: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../ffmpeg/ffprobe.mjs', () => ({
  chapterInfo: jest.fn(async () => null),
  isVideoHDR: jest.fn(async () => false),
  getVideoDuration: jest.fn(async () => 0),
  getVideoCodec: jest.fn(async () => 'h264'),
  getAudioTracks: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../chapter-generator.mjs', () => ({
  generateChapters: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../utils/backdropFocalDetector.mjs', () => ({
  detectBackdropFocal: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../components/caption-generator/data-access/caption-config.mjs', () => ({
  getAutoCaptionsConfigCached: jest.fn(async () => ({ enabled: false, languages: [] })),
}));
jest.unstable_mockModule('../../lib/metadataGenerator.mjs', () => ({
  isFrozenReason: jest.fn(() => false),
  refreshMissingEpisodes: jest.fn(async () => 0),
  MetadataGenerator: class {},
}));

const { scanMovies } = await import('../../components/media-scanner/domain/movie-scanner.mjs');
const { scanTVShows } = await import('../../components/media-scanner/domain/tv-scanner.mjs');
const sqliteDb = await import('../../sqliteDatabase.mjs');
const { initializeDatabase, releaseDatabase, getMovies, getTVShows } = sqliteDb;

// ---------------------------------------------------------------- fixtures

const PREFIX = '/media';
const MOVIES = join(MEDIA, 'movies');
const TV = join(MEDIA, 'tv');
let db;

async function writeFiles(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  for (const f of files) await fs.writeFile(join(dir, f), 'x'.repeat(64));
}

/** A link whose target does not exist: readdir lists it, fs.stat throws ENOENT. */
async function plantDanglingLink(dir) {
  // 'junction' is required for unprivileged creation on Windows and ignored elsewhere.
  await fs.symlink(join(tmpRoot, 'does-not-exist'), join(dir, 'dangling'), 'junction');
}

const scanMoviesOnce = () =>
  scanMovies(db, MOVIES, PREFIX, MEDIA, {}, 1.0011, false, async () => {});
const scanTVOnce = () =>
  scanTVShows(db, TV, PREFIX, MEDIA, {}, false, async () => {});

const movieNames = async () => (await getMovies()).map((m) => m.name).sort();
const showNames = async () => (await getTVShows()).map((s) => s.name).sort();
const hashRows = (mediaType, title) =>
  db.get('SELECT COUNT(*) AS c FROM metadata_hashes WHERE media_type = ? AND title = ?', [mediaType, title])
    .then((r) => r.c);
const cooldownRows = (name) =>
  db.get('SELECT COUNT(*) AS c FROM missing_data_media WHERE name = ?', [name]).then((r) => r.c);

beforeAll(async () => {
  // Note on order: on NTFS/HFS+ readdir is alphabetical, so "Boom *" precedes
  // "Good *" and the pre-P0 TV scanner demonstrably skipped Good; ext4/xfs/APFS
  // return hash order. No assertion below depends on order — every non-throwing
  // title must be processed wherever it sits.
  await writeFiles(join(MOVIES, 'Boom Movie'), ['Boom.mp4']);
  await writeFiles(join(MOVIES, 'Departing Movie'), ['Depart.mp4']);
  await writeFiles(join(MOVIES, 'Good Movie'), ['Good.mp4']);
  await writeFiles(join(MOVIES, 'Vanish Movie'), ['Vanish.mp4']);

  await writeFiles(join(TV, 'Boom Show', 'Season 1'), ['Boom Show - S01E01.mp4']);
  await writeFiles(join(TV, 'Departing Show', 'Season 1'), ['Departing Show - S01E01.mp4']);
  await writeFiles(join(TV, 'Good Show', 'Season 1'), ['Good Show - S01E01.mp4']);
  await writeFiles(join(TV, 'Vanish Show', 'Season 1'), ['Vanish Show - S01E01.mp4']);

  await fs.mkdir(DB_DIR, { recursive: true });
  db = await initializeDatabase();

  // Tick 1 — healthy library.
  await scanMoviesOnce();
  await scanTVOnce();
});

afterAll(async () => {
  if (db) await releaseDatabase(db);
  await sqliteDb.closeAllDatabaseConnections();
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows may still hold the sqlite file; the temp dir is the OS's to reclaim.
  }
});

// ---------------------------------------------------------------- tests

describe('SI-P0 failed ≠ absent — baseline', () => {
  it('tick 1 discovered every title and wrote hash + cooldown rows', async () => {
    expect(await movieNames()).toEqual(['Boom Movie', 'Departing Movie', 'Good Movie', 'Vanish Movie']);
    expect(await showNames()).toEqual(['Boom Show', 'Departing Show', 'Good Show', 'Vanish Show']);
    for (const t of ['Boom Movie', 'Departing Movie', 'Good Movie', 'Vanish Movie']) {
      expect(await hashRows('movies', t)).toBe(1);
    }
    for (const t of ['Boom Show', 'Departing Show', 'Good Show', 'Vanish Show']) {
      expect(await hashRows('tv', t)).toBeGreaterThanOrEqual(3); // show + season + episode
    }
    // No metadata.json → the generator was invoked and the cooldown row written,
    // which is what lets the cascade assertions below prove R-4 coverage.
    expect(await cooldownRows('Departing Movie')).toBe(1);
    expect(await cooldownRows('Departing Show')).toBe(1);
  });

  it('a root-level failure (the media root itself unreadable) still rejects', async () => {
    const missing = join(MEDIA, 'no-such-root');
    await expect(scanMovies(db, missing, PREFIX, MEDIA, {}, 1.0011, false, async () => {}))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(scanTVShows(db, missing, PREFIX, MEDIA, {}, false, async () => {}))
      .rejects.toMatchObject({ code: 'ENOENT' });
    // Nothing was removed by the rejected passes.
    expect((await movieNames()).length).toBe(4);
    expect((await showNames()).length).toBe(4);
  });
});

describe('SI-P0 failed ≠ absent — a title whose OWN readdir fails (vanished between root listing and processing)', () => {
  let spy;
  beforeAll(async () => {
    const real = fs.readdir;
    const isVanish = (p) =>
      String(p).endsWith(join('movies', 'Vanish Movie')) || String(p).endsWith(join('tv', 'Vanish Show'));
    spy = jest.spyOn(fs, 'readdir').mockImplementation((p, ...rest) =>
      isVanish(p)
        ? Promise.reject(Object.assign(new Error(`ENOENT: injected, scandir '${p}'`), { code: 'ENOENT' }))
        : real.call(fs, p, ...rest)
    );
    await scanMoviesOnce();
    await scanTVOnce();
  });
  afterAll(() => spy.mockRestore());

  it('is RETAINED with its rows intact — the delete-before-any-I/O invariant', async () => {
    // This is the assertion that fails if existingMovieNames.delete(dirName)
    // is moved to after the per-title fs.readdir.
    expect(await movieNames()).toContain('Vanish Movie');
    expect(await hashRows('movies', 'Vanish Movie')).toBe(1);
    expect(await showNames()).toContain('Vanish Show');
    expect(await hashRows('tv', 'Vanish Show')).toBeGreaterThanOrEqual(3);
  });
});

describe('SI-P0 failed ≠ absent — tick 2 with one departed title and one throwing title per library', () => {
  beforeAll(async () => {
    // Departures.
    await fs.rm(join(MOVIES, 'Departing Movie'), { recursive: true, force: true });
    await fs.rm(join(TV, 'Departing Show'), { recursive: true, force: true });
    // Failures: calculateDirectoryHash → fs.stat(dangling) → ENOENT.
    await plantDanglingLink(join(MOVIES, 'Boom Movie'));
    await plantDanglingLink(join(TV, 'Boom Show'));
    // New content elsewhere in the library, to prove other titles are still
    // processed in the same pass.
    await writeFiles(join(TV, 'Good Show', 'Season 1'), ['Good Show - S01E02.mp4']);
    await writeFiles(join(MOVIES, 'New Movie'), ['New.mp4']);
  });

  it('scanMovies resolves despite a throwing directory (Promise.all no longer rejects)', async () => {
    await scanMoviesOnce();
  });

  it('scanTVShows resolves despite a throwing show', async () => {
    await scanTVOnce();
  });

  it('the departed movie is removed WITH its cascade (row, hash, cooldown)', async () => {
    expect(await movieNames()).not.toContain('Departing Movie');
    expect(await hashRows('movies', 'Departing Movie')).toBe(0);
    expect(await cooldownRows('Departing Movie')).toBe(0);
  });

  it('the throwing movie is RETAINED — failed ≠ absent — with its hash and cooldown rows intact', async () => {
    expect(await movieNames()).toContain('Boom Movie');
    expect(await hashRows('movies', 'Boom Movie')).toBe(1);
    expect(await cooldownRows('Boom Movie')).toBe(1);
  });

  it('other movies are unaffected and a new movie is still discovered in the same pass', async () => {
    expect(await movieNames()).toEqual(expect.arrayContaining(['Good Movie', 'New Movie', 'Vanish Movie']));
    expect(await hashRows('movies', 'New Movie')).toBe(1);
  });

  it('the departed show is removed WITH its cascade (row, hashes, cooldown)', async () => {
    expect(await showNames()).not.toContain('Departing Show');
    expect(await hashRows('tv', 'Departing Show')).toBe(0);
    expect(await cooldownRows('Departing Show')).toBe(0);
  });

  it('the throwing show is RETAINED with its hash and cooldown rows intact', async () => {
    expect(await showNames()).toContain('Boom Show');
    expect(await hashRows('tv', 'Boom Show')).toBeGreaterThanOrEqual(3);
    expect(await cooldownRows('Boom Show')).toBe(1);
  });

  it('other shows are still processed when one show throws (new episode discovered)', async () => {
    const good = (await getTVShows()).find((s) => s.name === 'Good Show');
    expect(good).toBeDefined();
    expect(Object.keys(good.seasons['Season 1'].episodes).sort()).toEqual(['S01E01', 'S01E02']);
  });
});

describe('SI-P0 failed ≠ absent — recovery and genuine departure', () => {
  it('once the failure clears, the retained titles are processed normally', async () => {
    await fs.unlink(join(MOVIES, 'Boom Movie', 'dangling'));
    await fs.unlink(join(TV, 'Boom Show', 'dangling'));
    // Change the folder so the directory hash moves and the title is reprocessed.
    await writeFiles(join(MOVIES, 'Boom Movie'), ['Boom.en.srt']);
    await writeFiles(join(TV, 'Boom Show', 'Season 1'), ['Boom Show - S01E02.mp4']);

    await scanMoviesOnce();
    await scanTVOnce();

    const boomMovie = (await getMovies()).find((m) => m.name === 'Boom Movie');
    expect(boomMovie?.urls?.subtitles).toBeDefined();
    const boomShow = (await getTVShows()).find((s) => s.name === 'Boom Show');
    expect(Object.keys(boomShow.seasons['Season 1'].episodes).sort()).toEqual(['S01E01', 'S01E02']);
  });

  it('a title whose folder is genuinely gone is removed on the next tick', async () => {
    await fs.rm(join(MOVIES, 'Boom Movie'), { recursive: true, force: true });
    await fs.rm(join(TV, 'Boom Show'), { recursive: true, force: true });

    await scanMoviesOnce();
    await scanTVOnce();

    expect(await movieNames()).toEqual(['Good Movie', 'New Movie', 'Vanish Movie']);
    expect(await showNames()).toEqual(['Good Show', 'Vanish Show']);
    expect(await hashRows('movies', 'Boom Movie')).toBe(0);
    expect(await hashRows('tv', 'Boom Show')).toBe(0);
  });
});

describe('SI-P0 failed ≠ absent — a failing removal cascade is isolated and keeps its retry anchor', () => {
  // Two departures per library; one of them has a trigger that aborts the
  // DELETE of its title row. Title rows are deleted LAST in the cascade, so the
  // dependent rows go first and the surviving row is what re-enters the removal
  // set next tick.
  beforeAll(async () => {
    await writeFiles(join(MOVIES, 'Plain Gone Movie'), ['PlainGone.mp4']);
    await writeFiles(join(MOVIES, 'Cascade Fail Movie'), ['CascadeFail.mp4']);
    await writeFiles(join(TV, 'Plain Gone Show', 'Season 1'), ['Plain Gone Show - S01E01.mp4']);
    await writeFiles(join(TV, 'Cascade Fail Show', 'Season 1'), ['Cascade Fail Show - S01E01.mp4']);
    await scanMoviesOnce();
    await scanTVOnce();
    expect(await movieNames()).toEqual(expect.arrayContaining(['Plain Gone Movie', 'Cascade Fail Movie']));
    expect(await showNames()).toEqual(expect.arrayContaining(['Plain Gone Show', 'Cascade Fail Show']));

    for (const d of ['Plain Gone Movie', 'Cascade Fail Movie']) await fs.rm(join(MOVIES, d), { recursive: true, force: true });
    for (const d of ['Plain Gone Show', 'Cascade Fail Show']) await fs.rm(join(TV, d), { recursive: true, force: true });

    await db.exec(`CREATE TRIGGER si_p0_fail_movie BEFORE DELETE ON movies
      WHEN OLD.name = 'Cascade Fail Movie' BEGIN SELECT RAISE(ABORT, 'injected cascade failure'); END;`);
    await db.exec(`CREATE TRIGGER si_p0_fail_show BEFORE DELETE ON tv_shows
      WHEN OLD.name = 'Cascade Fail Show' BEGIN SELECT RAISE(ABORT, 'injected cascade failure'); END;`);
  });
  afterAll(async () => {
    await db.exec('DROP TRIGGER IF EXISTS si_p0_fail_movie');
    await db.exec('DROP TRIGGER IF EXISTS si_p0_fail_show');
  });

  it('the scan resolves and the other departed titles are still fully removed', async () => {
    await scanMoviesOnce();
    await scanTVOnce();
    expect(await movieNames()).not.toContain('Plain Gone Movie');
    expect(await hashRows('movies', 'Plain Gone Movie')).toBe(0);
    expect(await cooldownRows('Plain Gone Movie')).toBe(0);
    expect(await showNames()).not.toContain('Plain Gone Show');
    expect(await hashRows('tv', 'Plain Gone Show')).toBe(0);
  });

  it('the failing title keeps its row (retry anchor) while its dependent rows are already gone', async () => {
    expect(await movieNames()).toContain('Cascade Fail Movie');
    expect(await hashRows('movies', 'Cascade Fail Movie')).toBe(0);
    expect(await cooldownRows('Cascade Fail Movie')).toBe(0);
    expect(await showNames()).toContain('Cascade Fail Show');
    expect(await hashRows('tv', 'Cascade Fail Show')).toBe(0);
  });

  it('once the failure clears, the next tick removes it', async () => {
    await db.exec('DROP TRIGGER IF EXISTS si_p0_fail_movie');
    await db.exec('DROP TRIGGER IF EXISTS si_p0_fail_show');
    await scanMoviesOnce();
    await scanTVOnce();
    expect(await movieNames()).not.toContain('Cascade Fail Movie');
    expect(await showNames()).not.toContain('Cascade Fail Show');
  });
});
