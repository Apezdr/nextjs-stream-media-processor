/**
 * Where app.mjs runs a library scan, read off its source.
 *
 * app.mjs cannot be loaded in a test, so the two scans that are not the scan
 * tick's live in lib/libraryScanTask.mjs, and
 * tests/unit/lib/library-scan-task.test.mjs checks they wait for the scan
 * group. This checks app.mjs reaches the scanners only through them and the
 * tick:
 *
 *   - POST /media/scan is createMediaScanHandler, mounted once;
 *   - each payload loader scans an empty table through scanIfTableEmpty, and
 *     nothing else asks whether a table is empty;
 *   - generateListMovies and generateListTV are called from those wirings and
 *     from the scan tick's MOVIE_SCAN and TV_SCAN tasks, and nowhere else.
 *
 * Comment lines are not code, so they are left out of the scan.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_SOURCE = readFileSync(join(NODE_DIR, 'app.mjs'), 'utf8');

/** The source with comment lines blanked, as in app-request-body-wiring.test.mjs. */
function codeOf(source) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  return source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** The trimmed code lines that match `pattern`. */
function linesMatching(code, pattern) {
  return code.split('\n').map((line) => line.trim()).filter((line) => pattern.test(line));
}

const CODE = codeOf(APP_SOURCE);

describe('app.mjs library scans', () => {
  it('mounts POST /media/scan once, as createMediaScanHandler', () => {
    expect(linesMatching(CODE, /\b(?:app|router)\s*\.\s*\w+\s*\(\s*["'`]\/media\/scan["'`]/i)).toEqual([
      'app.post("/media/scan", authenticateWebhookOrUser, createMediaScanHandler({',
    ]);
  });

  it('scans an empty table only through scanIfTableEmpty, once per payload loader', () => {
    expect(linesMatching(CODE, /\bscanIfTableEmpty\s*\(/)).toHaveLength(2);
    expect(linesMatching(CODE, /\bisDatabaseEmpty\s*\(/)).toEqual([
      'isEmpty: () => isDatabaseEmpty("tv_shows"),',
      'isEmpty: () => isDatabaseEmpty("movies"),',
    ]);
  });

  it('calls the scanners from those wirings and the scan tick only', () => {
    expect(linesMatching(CODE, /\bgenerateList(?:Movies|TV)\s*\(/)).toEqual([
      'async function generateListTV(db, dirPath) {',
      'scan: () => generateListTV(db, `${BASE_PATH}/tv`),',
      'scan: () => generateListMovies(db, `${BASE_PATH}/movies`),',
      'async function generateListMovies(db, dirPath) {',
      'scanMovies: (db) => generateListMovies(db, `${BASE_PATH}/movies`),',
      'const summary = await generateListMovies(movieDb, `${BASE_PATH}/movies`);',
      'const summary = await generateListTV(tvDb, `${BASE_PATH}/tv`);',
    ]);
    // The tick's two calls sit in its MOVIE_SCAN and TV_SCAN tasks.
    const tick = CODE.slice(CODE.indexOf('async function runGenerateList()'), CODE.indexOf('async function autoSync()'));
    expect(tick).toMatch(/enqueueTask\(TaskType\.MEDIA_SCAN,/);
    expect(tick).toMatch(/enqueueTask\(TaskType\.MOVIE_SCAN,[\s\S]*generateListMovies\(movieDb/);
    expect(tick).toMatch(/enqueueTask\(TaskType\.TV_SCAN,[\s\S]*generateListTV\(tvDb/);
  });
});
