/**
 * listMultiSourceTitles: the movies and episodes with more than one video
 * file, read from the published rows on a real SQLite file (the
 * MEDIA_DB_DIRECTORY seam). The identity service's leftover report reads it.
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
      throw new Error('Mongo is not available in multi-source-titles tests');
    },
  },
}));

const tmpDir = join(tmpdir(), `multi-source-titles-${randomUUID()}`);
process.env.MEDIA_DB_DIRECTORY = tmpDir;

let sqliteDb;
let listMultiSourceTitles;

const source = (filename, extra = {}) => ({
  url: `/media/x/${filename}`, filename, container: filename.split('.').pop(), size: 100,
  dimensions: '1920x1080', hdr: null, isPrimary: false, ...extra,
});

beforeAll(async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  sqliteDb = await import('../../../sqliteDatabase.mjs');
  ({ listMultiSourceTitles } = await import('../../../sqlite/multiSourceTitles.mjs'));
  const db = await sqliteDb.initializeDatabase();

  const movie = (name, urls) => db.run('INSERT INTO movies (name, urls) VALUES (?, ?)', [name, urls]);
  await movie('Nobody', JSON.stringify({
    mp4: '/media/movies/Nobody/Nobody.1080p.mp4',
    sources: [
      source('Nobody.1080p.mp4', { isPrimary: true, size: 4322151904 }),
      source('Nobody.2160p.mkv', { dimensions: '3840x2160', hdr: 'Dolby Vision, HDR10+', size: 45069992695 }),
    ],
  }));
  await movie('Single', JSON.stringify({ sources: [source('Single.mp4', { isPrimary: true })] }));
  await movie('No Sources', JSON.stringify({ mp4: '/media/movies/x.mp4' }));
  await movie('Broken Row', '{not json');

  const show = (name, seasons) => db.run('INSERT INTO tv_shows (name, seasons) VALUES (?, ?)', [name, seasons]);
  await show('Alien - Earth', JSON.stringify({
    'Season 1': {
      episodes: {
        S01E01: { sources: [source('S01E01 WEBDL-1080p.mp4', { isPrimary: true }), source('S01E01 WEBDL-2160p Proper.mp4')] },
        S01E03: { sources: [source('S01E03.mp4', { isPrimary: true })] },
      },
    },
  }));
  await show('Broken Show', 'nope');
});

afterAll(async () => {
  await sqliteDb.closeAllDatabaseConnections();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('listMultiSourceTitles', () => {
  it('returns only the titles with several files, shaped for the leftover report', async () => {
    const titles = await listMultiSourceTitles();

    expect(titles).toEqual([
      {
        mediaType: 'movie', libraryRelativePath: 'movies/Nobody', title: 'Nobody', episode: null,
        sources: [
          { filename: 'Nobody.1080p.mp4', size: 4322151904, dimensions: '1920x1080', hdr: null, isPrimary: true },
          { filename: 'Nobody.2160p.mkv', size: 45069992695, dimensions: '3840x2160', hdr: 'Dolby Vision, HDR10+', isPrimary: false },
        ],
      },
      {
        mediaType: 'tv', libraryRelativePath: 'tv/Alien - Earth', title: 'Alien - Earth', episode: 'S01E01',
        sources: [
          { filename: 'S01E01 WEBDL-1080p.mp4', size: 100, dimensions: '1920x1080', hdr: null, isPrimary: true },
          { filename: 'S01E01 WEBDL-2160p Proper.mp4', size: 100, dimensions: '1920x1080', hdr: null, isPrimary: false },
        ],
      },
    ]);
  });
});
