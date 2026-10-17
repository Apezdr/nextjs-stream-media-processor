/**
 * The order a show's seasons are stored in never depends on which season task
 * finished first.
 *
 * scanTVShows processes a show's season folders concurrently (pLimit(3)) and
 * collects them in the order they finish. Folders without a number
 * ("Specials") and "Season 0" share the sort key, so before the name
 * tie-break their order followed the finish order: the stored seasons JSON
 * changed on every reprocess, and with it the show's row, tv_shows'
 * generation and the /media/tv ETag (lib/mediaPayloadCache.mjs). A show the
 * scanner reprocesses every tick (missing art, as in this fixture) would then
 * rebuild the TV body every tick.
 *
 * Real scanner, real SQLite; the ffprobe/mediainfo boundary is mocked, with a
 * per-folder delay that decides which season finishes first.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const tmpRoot = join(tmpdir(), `tv-season-order-${randomUUID()}`);
const MEDIA = join(tmpRoot, 'media');
const DB_DIR = join(tmpRoot, 'db');
process.env.MEDIA_DB_DIRECTORY = DB_DIR;

const SHOW = 'Order Show';

// Milliseconds getInfo waits per season folder, and the order the folders'
// probes finished in.
let delayByFolder = {};
let finished = [];

jest.unstable_mockModule('../../infoManager.mjs', () => ({
  CURRENT_VERSION: 1.0011,
  getInfo: jest.fn(async (filePath) => {
    const folder = filePath.split(/[\\/]/).slice(-2)[0];
    await new Promise((resolve) => setTimeout(resolve, delayByFolder[folder] ?? 0));
    finished.push(folder);
    return {
      uuid: `uuid-${folder}`,
      length: 2700000,
      dimensions: '1920x1080',
      hdr: null,
      mediaQuality: { isHDR: false, format: 'HEVC', bitDepth: 10 },
      additionalMetadata: { duration: 2700000, size: { kb: 1, mb: 1, gb: 1 }, audio: [], video: [] },
    };
  }),
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
  getAutoCaptionsConfigCached: jest.fn(async () => ({ enabled: false, languages: ['en'] })),
}));
jest.unstable_mockModule('../../lib/metadataGenerator.mjs', () => ({
  isFrozenReason: jest.fn(() => false),
  refreshMissingEpisodes: jest.fn(async () => 0),
  MetadataGenerator: class {},
}));

const { scanTVShows, sortSeasons } = await import('../../components/media-scanner/domain/tv-scanner.mjs');
const sqliteDb = await import('../../sqliteDatabase.mjs');
const { langMap } = await import('../../utils/languageMap.mjs');

let db;

async function writeFiles(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  for (const f of files) await fs.writeFile(join(dir, f), 'x'.repeat(64));
}

async function scanWith(delays) {
  delayByFolder = delays;
  finished = [];
  const summary = await scanTVShows(db, join(MEDIA, 'tv'), '/media', MEDIA, langMap, false, async () => {});
  expect(summary.error).toBeNull();
  const order = [...finished];
  const row = await db.get('SELECT seasons FROM tv_shows WHERE name = ?', [SHOW]);
  return { order, seasons: row.seasons };
}

beforeAll(async () => {
  await writeFiles(join(MEDIA, 'tv', SHOW, 'Specials'), [`${SHOW} - S00E01.mkv`]);
  await writeFiles(join(MEDIA, 'tv', SHOW, 'Season 0'), [`${SHOW} - S00E02.mkv`]);
  await writeFiles(join(MEDIA, 'tv', SHOW, 'Season 1'), [`${SHOW} - S01E01.mkv`]);
  await fs.mkdir(DB_DIR, { recursive: true });
  db = await sqliteDb.initializeDatabase();

  await db.exec('CREATE TEMP TABLE IF NOT EXISTS tv_write_log (op TEXT, name TEXT)');
  for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
    const row = op === 'DELETE' ? 'OLD' : 'NEW';
    await db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS log_tv_${op.toLowerCase()} AFTER ${op} ON main.tv_shows ` +
        `BEGIN INSERT INTO tv_write_log VALUES ('${op.toLowerCase()}', ${row}.name); END`
    );
  }
});

afterAll(async () => {
  await sqliteDb.closeAllDatabaseConnections();
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows may still hold the sqlite file; the temp dir is the OS's to reclaim.
  }
});

describe('sortSeasons', () => {
  const entries = [
    ['Season 2', { n: 2 }],
    ['Specials', { n: 's' }],
    ['Season 1', { n: 1 }],
    ['Season 0', { n: 0 }],
    ['Extras', { n: 'e' }],
    ['Season 01', { n: '01' }],
  ];

  it('orders by season number, then by folder name, whatever order the seasons came in', () => {
    const forward = sortSeasons(Object.fromEntries(entries));
    const backward = sortSeasons(Object.fromEntries([...entries].reverse()));
    expect(Object.keys(forward)).toEqual(['Extras', 'Season 0', 'Specials', 'Season 01', 'Season 1', 'Season 2']);
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });
});

describe('scanTVShows', () => {
  it('stores the same seasons whichever unnumbered season finishes first', async () => {
    // Specials finishes before Season 0.
    const first = await scanWith({ 'Season 0': 60, 'Season 1': 0, Specials: 0 });
    expect(first.order.indexOf('Specials')).toBeLessThan(first.order.indexOf('Season 0'));
    expect(Object.keys(JSON.parse(first.seasons))).toEqual(['Season 0', 'Specials', 'Season 1']);

    // The show has no artwork, so the scanner reprocesses it on every pass and
    // reaches the upsert. Now Season 0 finishes first.
    await db.run('DELETE FROM tv_write_log');
    const generation = sqliteDb.getMediaTableGeneration('tv_shows');
    const second = await scanWith({ 'Season 0': 0, 'Season 1': 0, Specials: 60 });
    expect(second.order.indexOf('Season 0')).toBeLessThan(second.order.indexOf('Specials'));

    expect(second.seasons).toBe(first.seasons);
    expect(await db.all('SELECT op, name FROM tv_write_log')).toEqual([]);
    expect(sqliteDb.getMediaTableGeneration('tv_shows')).toBe(generation);
  });
});
