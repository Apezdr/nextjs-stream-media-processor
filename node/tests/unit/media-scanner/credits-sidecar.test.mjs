/**
 * The credits sidecar locator (components/media-scanner/domain/credits-sidecar.mjs):
 * the four values a title publishes for one file, from a real file on disk.
 *
 * The file is never parsed, so content that is not JSON at all is still
 * published with its url and hash. Absence comes from the listing the caller
 * passes, never from the disk.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';

const warn = jest.fn();
jest.unstable_mockModule('../../../lib/logger.mjs', () => ({
  createCategoryLogger: () => ({ warn, info: () => {}, debug: () => {}, error: () => {} }),
}));

const {
  locateCreditsSidecar,
  locateLibraryCreditsSidecar,
  creditsNeedsReread,
  showCreditsNeedReread,
  episodeCreditsFileName,
  CREDITS_FILE_NAME,
  CREDITS_SIDECAR_MAX_BYTES,
} = await import('../../../components/media-scanner/domain/credits-sidecar.mjs');

const URL = '/media/movies/Some%20Movie/credits.json';
const REL = 'movies/Some Movie/credits.json';
let dir;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function locate(listing = [CREDITS_FILE_NAME], fileName = CREDITS_FILE_NAME) {
  return locateCreditsSidecar({ listing, dir, fileName, url: URL, libraryRelativePath: REL });
}

beforeAll(async () => {
  dir = join(tmpdir(), `credits-sidecar-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  warn.mockClear();
  await fs.rm(join(dir, CREDITS_FILE_NAME), { recursive: true, force: true });
});

describe('locateCreditsSidecar', () => {
  it('caps the read at 256 KiB', () => {
    expect(CREDITS_SIDECAR_MAX_BYTES).toBe(262144);
  });

  it('answers absent from the listing alone, without touching the disk', async () => {
    const missingDir = join(dir, 'no-such-folder');
    const value = await locateCreditsSidecar({
      listing: new Set(['metadata.json', 'movie.mkv']),
      dir: missingDir,
      fileName: CREDITS_FILE_NAME,
      url: URL,
      libraryRelativePath: REL,
    });
    expect(value).toEqual({ absent: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers absent when the file is on disk but not in the listing it was given', async () => {
    await fs.writeFile(join(dir, CREDITS_FILE_NAME), '{"schemaVersion":1}');
    expect(await locate([])).toEqual({ absent: true });
  });

  it('publishes url and hash, the SHA-256 of the bytes, without parsing them', async () => {
    const bytes = Buffer.from('this is { not json at all\né');
    await fs.writeFile(join(dir, CREDITS_FILE_NAME), bytes);

    const value = await locate(new Set([CREDITS_FILE_NAME]));
    expect(value).toEqual({ url: `${URL}?hash=${sha256(bytes)}`, hash: sha256(bytes) });
    expect(value.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('takes the listing as an array as well as a Set', async () => {
    await fs.writeFile(join(dir, CREDITS_FILE_NAME), '{}');
    expect(await locate([CREDITS_FILE_NAME])).toEqual({ url: `${URL}?hash=${sha256('{}')}`, hash: sha256('{}') });
  });

  it('reads a file of exactly 256 KiB', async () => {
    const bytes = Buffer.alloc(CREDITS_SIDECAR_MAX_BYTES, 0x61);
    await fs.writeFile(join(dir, CREDITS_FILE_NAME), bytes);
    expect((await locate()).hash).toBe(sha256(bytes));
  });

  it('answers too-large one byte past 256 KiB, and warns with the library path', async () => {
    await fs.writeFile(join(dir, CREDITS_FILE_NAME), Buffer.alloc(CREDITS_SIDECAR_MAX_BYTES + 1, 0x61));
    expect(await locate()).toEqual({ error: 'too-large' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(REL);
  });

  it('answers empty for a 0-byte file', async () => {
    await fs.writeFile(join(dir, CREDITS_FILE_NAME), '');
    expect(await locate()).toEqual({ error: 'empty' });
    expect(warn.mock.calls[0][0]).toContain(REL);
  });

  it('answers not-a-file for a directory of that name', async () => {
    await fs.mkdir(join(dir, CREDITS_FILE_NAME));
    expect(await locate()).toEqual({ error: 'not-a-file' });
    expect(warn.mock.calls[0][0]).toContain(REL);
  });

  it('answers unreadable, not absent, for a listed file gone since the listing', async () => {
    expect(await locate()).toEqual({ error: 'unreadable' });
    expect(warn.mock.calls[0][1].error).toBe('ENOENT');
  });

  it('names an episode file after the episode number as its metadata file is named', () => {
    expect(episodeCreditsFileName('01')).toBe('01_credits.json');
    expect(episodeCreditsFileName('7')).toBe('7_credits.json');
  });
});

describe('locateLibraryCreditsSidecar', () => {
  // A library root of its own: it lists it itself, and holds a movies folder
  // as a mounted library does.
  let root;
  const locateRoot = (at = root) => locateLibraryCreditsSidecar({ root: at, prefixPath: '/media' });

  beforeAll(async () => {
    root = join(dir, 'library');
    await fs.mkdir(join(root, 'movies'), { recursive: true });
  });

  beforeEach(async () => {
    await fs.rm(join(root, CREDITS_FILE_NAME), { recursive: true, force: true });
  });

  it('publishes url and hash for <root>/credits.json, the URL at the prefix root', async () => {
    const bytes = Buffer.from('{"schemaVersion":1,"assets":[{"path":"poster_collage.jpg"}]}');
    await fs.writeFile(join(root, CREDITS_FILE_NAME), bytes);
    expect(await locateRoot()).toEqual({ url: `/media/credits.json?hash=${sha256(bytes)}`, hash: sha256(bytes) });
  });

  it('answers absent for a root with only movies/ and no credits.json', async () => {
    expect(await fs.readdir(root)).toEqual(['movies']);
    expect(await locateRoot()).toEqual({ absent: true });
  });

  it('answers unreadable, never absent, for an empty root: an unmounted share', async () => {
    const empty = join(dir, 'empty-mount-point');
    await fs.mkdir(empty, { recursive: true });
    expect(await locateRoot(empty)).toEqual({ error: 'unreadable' });
    expect(warn.mock.calls[0][0]).toContain(CREDITS_FILE_NAME);
  });

  it('answers unreadable for a root with a credits.json but neither movies nor tv', async () => {
    const stray = join(dir, 'stray-root');
    await fs.mkdir(stray, { recursive: true });
    await fs.writeFile(join(stray, CREDITS_FILE_NAME), '{}');
    expect(await locateRoot(stray)).toEqual({ error: 'unreadable' });
  });

  it('answers unreadable, never absent, when the root cannot be listed', async () => {
    expect(await locateRoot(join(dir, 'no-such-root'))).toEqual({ error: 'unreadable' });
    expect(warn.mock.calls[0][0]).toContain(CREDITS_FILE_NAME);
  });

  it('answers not-a-file for a directory named credits.json at the root', async () => {
    await fs.mkdir(join(root, CREDITS_FILE_NAME));
    expect(await locateRoot()).toEqual({ error: 'not-a-file' });
  });
});

describe('creditsNeedsReread', () => {
  it('is true for unreadable, stored as column text or parsed', () => {
    expect(creditsNeedsReread({ error: 'unreadable' })).toBe(true);
    expect(creditsNeedsReread('{"error":"unreadable"}')).toBe(true);
  });

  it('is false for not-a-file, too-large and empty: the fix for each moves the directory hash', () => {
    for (const reason of ['not-a-file', 'too-large', 'empty']) {
      expect(creditsNeedsReread({ error: reason })).toBe(false);
      expect(creditsNeedsReread(JSON.stringify({ error: reason }))).toBe(false);
    }
  });

  it('is false for a read file, a confirmed absence, a missing value and junk', () => {
    expect(creditsNeedsReread({ url: '/x?hash=ab', hash: 'ab' })).toBe(false);
    expect(creditsNeedsReread('{"url":"/x?hash=ab","hash":"ab"}')).toBe(false);
    expect(creditsNeedsReread({ absent: true })).toBe(false);
    expect(creditsNeedsReread('{"absent":true}')).toBe(false);
    expect(creditsNeedsReread(null)).toBe(false);
    expect(creditsNeedsReread(undefined)).toBe(false);
    expect(creditsNeedsReread('not json')).toBe(false);
  });
});

describe('showCreditsNeedReread', () => {
  const read = { url: '/x?hash=ab', hash: 'ab' };
  const seasons = (episodeCredits) => ({
    'Season 1': { episodes: { S01E01: { credits: read }, S01E02: { credits: episodeCredits } } },
    Specials: { episodes: {} },
  });

  it('is true when the show or any one episode is unreadable', () => {
    expect(showCreditsNeedReread({ error: 'unreadable' }, seasons({ absent: true }))).toBe(true);
    expect(showCreditsNeedReread({ absent: true }, seasons({ error: 'unreadable' }))).toBe(true);
  });

  it('is false when nothing is, too-large and empty included, and for a show without seasons', () => {
    expect(showCreditsNeedReread(read, seasons({ absent: true }))).toBe(false);
    expect(showCreditsNeedReread({ error: 'too-large' }, seasons({ error: 'empty' }))).toBe(false);
    expect(showCreditsNeedReread({ error: 'not-a-file' }, seasons({ error: 'not-a-file' }))).toBe(false);
    expect(showCreditsNeedReread({ absent: true }, null)).toBe(false);
    expect(showCreditsNeedReread({ absent: true }, { 'Season 1': { episodes: { S01E01: {} } } })).toBe(false);
  });
});
