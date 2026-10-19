/**
 * Expiring migrations: one-off legacy cleanups are removed at the next minor
 * version (owner decision, 2026-10-19), and this test enforces it.
 *
 * THE CONVENTION. Code that exists only to clean up state an older version
 * left behind (a table to drop, a column to backfill) carries, in its JSDoc,
 *
 *   @removeAtVersion <version> <one sentence: what removing it means>
 *
 * for example `@removeAtVersion 1.1.0 Retired-table cleanup for databases
 * from before P2; delete this function and its call when the version reaches
 * 1.1.0.` The version is the repo's next minor version when the code lands
 * (`version` in node/package.json, compared numerically segment by segment, so
 * 1.0.1 < 1.1.0). Permanent mechanisms are never marked.
 *
 * WHEN THIS FAILS. node/package.json has reached a marker's version: the
 * cleanup has had its release, so delete the marked code and its call (and
 * its tests), as the marker's sentence says. Do not move the marker forward to
 * make the test pass. A malformed marker (no version, or one that does not
 * parse) fails too: fix the marker. The tag is only for markers; do not write
 * it in prose in the source.
 *
 * The scan covers every .mjs and .js under node/ outside node_modules and
 * tests (tests/helpers/removeAtVersion.mjs holds the functions, tested below).
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  parseVersion,
  compareVersions,
  findMarkers,
  checkMarkers,
  processorSources,
} from '../helpers/removeAtVersion.mjs';

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGE_VERSION = JSON.parse(readFileSync(join(NODE_DIR, 'package.json'), 'utf8')).version;

describe('expiring migrations (the live check)', () => {
  const markers = findMarkers(processorSources(NODE_DIR));

  it('finds the markers in the processor code (a scan that read nothing would pass)', () => {
    expect(markers.map((m) => m.file)).toContain('sqliteDatabase.mjs');
  });

  it('has no marker whose version node/package.json has reached, and no malformed one', () => {
    expect(parseVersion(PACKAGE_VERSION)).not.toBeNull();
    expect(checkMarkers(markers, PACKAGE_VERSION)).toEqual({ overdue: [], malformed: [] });
  });
});

describe('the @removeAtVersion functions', () => {
  it('parses versions with leading zeros and refuses anything else', () => {
    expect(parseVersion('1.0.1')).toEqual([1, 0, 1]);
    expect(parseVersion('2026.09.01')).toEqual([2026, 9, 1]);
    for (const text of ['', '1.', '.1', '1..0', 'v1.1.0', '1.1.0-beta', '1.1.x', undefined, null]) {
      expect({ text, parsed: parseVersion(text) }).toEqual({ text, parsed: null });
    }
  });

  it('compares numerically segment by segment, a missing segment as 0', () => {
    expect(compareVersions('1.0.1', '1.1.0')).toBeLessThan(0);
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0);
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2026.09.01', '2026.10.0')).toBeLessThan(0);
    expect(compareVersions('2026.10.01', '2026.10.0')).toBeGreaterThan(0);
    expect(() => compareVersions('1.0', 'next')).toThrow(/next/);
  });

  const source = [
    'const a = 1;',
    '/**',
    ' * Drops a table.',
    ' *',
    ' * @removeAtVersion 1.1.0 Retired-table cleanup; delete this function and',
    ' * its call when the version reaches 1.1.0.',
    ' * @param {Object} db',
    ' */',
    'export function cleanup(db) {}',
    '// @removeAtVersion 2.0 One-line marker.',
    '/** @removeAtVersion soon Not a version. */',
  ].join('\n');
  const markers = findMarkers([{ file: 'lib/example.mjs', source }]);

  it('finds each marker with its line, version and whole sentence', () => {
    expect(markers).toEqual([
      {
        file: 'lib/example.mjs',
        line: 5,
        version: '1.1.0',
        raw: '1.1.0',
        sentence: 'Retired-table cleanup; delete this function and its call when the version reaches 1.1.0.',
      },
      { file: 'lib/example.mjs', line: 10, version: '2.0', raw: '2.0', sentence: 'One-line marker.' },
      { file: 'lib/example.mjs', line: 11, version: null, raw: 'soon', sentence: 'Not a version.' },
    ]);
  });

  it('fails a version at or above a marker, passes one below it, and always fails a malformed marker', () => {
    const valid = markers.filter((m) => m.version);
    expect(checkMarkers(valid, '1.0.1')).toEqual({ overdue: [], malformed: [] });
    expect(checkMarkers(valid, '1.1.0').overdue).toEqual([
      'lib/example.mjs:5 1.1.0 Retired-table cleanup; delete this function and its call when the version reaches 1.1.0.',
    ]);
    expect(checkMarkers(valid, '2.0.0').overdue).toHaveLength(2);
    expect(checkMarkers(markers, '0.1').malformed).toEqual(['lib/example.mjs:11 "soon" is not a version: Not a version.']);
    const bare = findMarkers([{ file: 'x.mjs', source: ' * @removeAtVersion' }]);
    expect(checkMarkers(bare, '0.1').malformed).toEqual(['x.mjs:1 "" is not a version:']);
  });
});
