/**
 * Library scans in the admin process list (lib/scanProgress.mjs).
 *
 * The reporter is tested with a recording writer and a fake clock. The last
 * block runs the default writer against a real process_queue, via the
 * MEDIA_DB_DIRECTORY seam, to check the upsert and the active filter.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
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

// The sqlite import chain reaches lib/mongo.mjs, which constructs a real
// MongoClient at import time and requires MONGODB_URI.
jest.unstable_mockModule('../../../lib/mongo.mjs', () => ({
  mongoClient: {
    db: () => {
      throw new Error('Mongo is not available in scan-progress tests');
    },
  },
}));

const tmpDir = join(tmpdir(), `scan-progress-test-${randomUUID()}`);
process.env.MEDIA_DB_DIRECTORY = tmpDir;

const { createLibraryScanProgress, formatDuration, LIBRARY_SCAN_PROCESS_TYPE } = await import(
  '../../../lib/scanProgress.mjs'
);
const processTracking = await import('../../../sqlite/processTracking.mjs');
const sqliteDb = await import('../../../sqliteDatabase.mjs');

beforeAll(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
});

afterAll(async () => {
  await sqliteDb.closeAllDatabaseConnections();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function recorder() {
  const rows = [];
  const write = async (fileKey, row) => {
    rows.push({ fileKey, ...row });
  };
  return { rows, write };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('createLibraryScanProgress', () => {
  it('writes the first title at once, then at most one write per interval', async () => {
    const { rows, write } = recorder();
    const c = clock();
    const progress = createLibraryScanProgress('movies', { write, now: c.now, intervalMs: 2000 });

    progress.onProgress({ position: 1, total: 3, name: 'Alien' });
    c.advance(500);
    progress.onProgress({ position: 2, total: 3, name: 'Brazil' });
    c.advance(2000);
    progress.onProgress({ position: 3, total: 3, name: 'Casablanca' });
    await progress.complete({ titles: 3, reprocessed: 1 });

    expect(rows).toEqual([
      { fileKey: 'library_scan_movies', totalSteps: 3, currentStep: 0, status: 'in-progress', message: 'Alien (1 of 3 movies)' },
      { fileKey: 'library_scan_movies', totalSteps: 3, currentStep: 2, status: 'in-progress', message: 'Casablanca (3 of 3 movies)' },
      { fileKey: 'library_scan_movies', totalSteps: 3, currentStep: 3, status: 'completed', message: '3 movies, 1 reprocessed, 3s' },
    ]);
  });

  it('never lets a slow progress write land after the final one', async () => {
    const landed = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const write = async (fileKey, row) => {
      if (row.status === 'in-progress') await gate;
      landed.push(row.status);
    };
    const progress = createLibraryScanProgress('tv', { write });

    progress.onProgress({ position: 1, total: 1, name: 'Futurama' });
    const done = progress.complete({ titles: 1, reprocessed: 0, error: null });
    release();
    await done;

    expect(landed).toEqual(['in-progress', 'completed']);
  });

  it('records a TV pass that stopped on an error as an error', async () => {
    const { rows, write } = recorder();
    const progress = createLibraryScanProgress('tv', { write });

    progress.onProgress({ position: 65, total: 230, name: 'Futurama' });
    await progress.complete({ titles: 230, reprocessed: 64, error: new Error('database is locked') });

    expect(rows.at(-1)).toEqual({
      fileKey: 'library_scan_tv',
      totalSteps: 230,
      currentStep: 64,
      status: 'error',
      message: 'Stopped at Futurama (65 of 230 shows): database is locked',
    });
  });

  it('records a scan that threw before its first title', async () => {
    const { rows, write } = recorder();
    const progress = createLibraryScanProgress('movies', { write });

    await progress.fail(new Error('ENOENT: no such file or directory'));

    expect(rows).toEqual([{
      fileKey: 'library_scan_movies',
      totalSteps: 0,
      currentStep: 0,
      status: 'error',
      message: 'Failed at the start: ENOENT: no such file or directory',
    }]);
  });

  it('keeps a failed write away from the scan', async () => {
    const write = jest.fn(async () => {
      throw new Error('SQLITE_BUSY');
    });
    const progress = createLibraryScanProgress('movies', { write, intervalMs: 0 });

    expect(() => progress.onProgress({ position: 1, total: 2, name: 'Alien' })).not.toThrow();
    progress.onProgress({ position: 2, total: 2, name: 'Brazil' });
    await expect(progress.complete({ titles: 2, reprocessed: 0 })).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('formats durations for the summary', () => {
    expect(formatDuration(400)).toBe('0s');
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(134_000)).toBe('2m 14s');
    expect(formatDuration(4_320_000)).toBe('1h 12m');
  });
});

describe('library scan rows in process_queue', () => {
  it('reuses one row per library, and only running or queued rows are active', async () => {
    const db = await processTracking.getProcessTrackingDb();
    const keyed = async () =>
      db.all(`SELECT * FROM process_queue WHERE file_key = 'library_scan_movies'`);
    const activeKeys = async () =>
      (await processTracking.getActiveProcesses(db)).map((row) => row.file_key);

    const first = createLibraryScanProgress('movies');
    first.onProgress({ position: 1, total: 2, name: 'Alien' });
    // The scanner doesn't await progress writes, so wait for this one to land.
    for (let tries = 0; tries < 100 && !(await activeKeys()).includes('library_scan_movies'); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await activeKeys()).toContain('library_scan_movies');
    await first.complete({ titles: 2, reprocessed: 0 });

    const [done] = await keyed();
    expect(done).toMatchObject({
      process_type: LIBRARY_SCAN_PROCESS_TYPE,
      status: 'completed',
      current_step: 2,
      total_steps: 2,
    });
    expect(done.message).toMatch(/^2 movies, 0 reprocessed, \d+s$/);
    expect(await activeKeys()).not.toContain('library_scan_movies');

    // The next tick overwrites the same row.
    const second = createLibraryScanProgress('movies');
    second.onProgress({ position: 1, total: 2, name: 'Alien' });
    await second.complete({ titles: 2, reprocessed: 2 });
    const rows = await keyed();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(done.id);

    // A restart leaves 'interrupted' behind; that is history, not activity.
    await processTracking.createOrUpdateProcessQueue(db, 'movie_x_spritesheet', 'spritesheet', 3, 1, 'interrupted', '');
    await processTracking.createOrUpdateProcessQueue(db, 'movie_y_caption', 'caption', 1, 0, 'queued', '');
    const active = await activeKeys();
    expect(active).toContain('movie_y_caption');
    expect(active).not.toContain('movie_x_spritesheet');
  });
});
