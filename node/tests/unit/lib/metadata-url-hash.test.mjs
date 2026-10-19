/**
 * The metadata URL's `?hash=` (lib/metadataUrlHash.mjs): the sha256 of the
 * row's stored metadata.json content, 64 hex digits like the directory hash it
 * replaces; the directory hash only for a row that stores no content, logged
 * once per title. tests/integration/media-payload.test.mjs checks it on the
 * wire through the real scanners.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const warn = jest.fn();
jest.unstable_mockModule('../../../lib/logger.mjs', () => ({
  createCategoryLogger: () => ({ warn, info: jest.fn(), debug: jest.fn(), error: jest.fn() }),
}));

const { metadataUrlHash } = await import('../../../lib/metadataUrlHash.mjs');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const DIR_HASH = 'd'.repeat(64);

describe('metadataUrlHash', () => {
  it('is the sha256 of the stored content, whatever the directory hash', () => {
    const metadata = JSON.stringify({ id: 1, title: 'x' });
    const hash = metadataUrlHash('movies', { name: 'A', metadata, directory_hash: DIR_HASH });
    expect(hash).toBe(sha256(metadata));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(metadataUrlHash('movies', { name: 'A', metadata, directory_hash: 'e'.repeat(64) })).toBe(hash);
    // The stat marker for an unparseable file is content too.
    const marker = JSON.stringify({ _stat: { mtimeMs: 1, size: 2 } });
    expect(metadataUrlHash('tv_shows', { name: 'S', metadata: marker, directory_hash: DIR_HASH })).toBe(sha256(marker));
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the directory hash for a row with no stored content, and says so once per title', () => {
    expect(metadataUrlHash('movies', { name: 'Old', metadata: null, directory_hash: DIR_HASH })).toBe(DIR_HASH);
    expect(metadataUrlHash('movies', { name: 'Old', metadata: '', directory_hash: DIR_HASH })).toBe(DIR_HASH);
    expect(metadataUrlHash('tv_shows', { name: 'Old', metadata: null, directory_hash: DIR_HASH })).toBe(DIR_HASH);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('movies row "Old"');
    expect(warn.mock.calls[1][0]).toContain('tv_shows row "Old"');
    expect(metadataUrlHash('movies', { name: 'None', metadata: null, directory_hash: null })).toBeNull();
  });
});

describe('the row readers in sqliteDatabase.mjs', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sqliteDatabase.mjs'), 'utf8');

  it('all build the metadata URL through withMetadataHash, and none from the directory hash', () => {
    expect(source.match(/withMetadataHash\(urls\.metadata, 'movies', movie\)/g)).toHaveLength(3);
    expect(source.match(/withMetadataHash\(show\.metadata_path, 'tv_shows', show\)/g)).toHaveLength(3);
    expect(source).not.toMatch(/buildImageUrl\([^)]*directory_hash/);
  });
});
