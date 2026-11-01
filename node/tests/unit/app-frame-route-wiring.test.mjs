/**
 * The /frame routes, read off app.mjs's source (app.mjs cannot be loaded in a
 * test; ffmpeg/frame.mjs and tests/unit/ffmpeg/frame.test.mjs hold the logic).
 *
 * The URL's timestamp once went into a shell command, and a title decoded from
 * the URL into the cache path unchecked. This pins the route's order: the
 * timestamp is validated before anything uses it, the frame path goes through
 * safeJoin, and the frame comes from ffmpeg/frame.mjs.
 *
 * Comment lines are not code, so they are left out of the scan.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_SOURCE = readFileSync(join(NODE_DIR, 'app.mjs'), 'utf8');

/** The source with comment lines blanked, as in app-scan-wiring.test.mjs. */
function codeOf(source) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  return source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
}

const CODE = codeOf(APP_SOURCE);
const HANDLER = CODE.slice(
  CODE.indexOf('async function handleFrameRequest('),
  CODE.indexOf('\n}\n', CODE.indexOf('async function handleFrameRequest('))
);

describe('app.mjs /frame routes', () => {
  it('generates frames with ffmpeg/frame.mjs, not a shell command', () => {
    expect(CODE).toMatch(/import \{[^}]*\bgenerateFrame\b[^}]*\} from "\.\/ffmpeg\/frame\.mjs";/);
    expect(CODE).not.toMatch(/\bexec\s*\(/);
  });

  it('refuses a timestamp that is not H:MM:SS before anything uses it', () => {
    const check = HANDLER.indexOf('parseFrameTimestamp(timestamp) === null');
    expect(check).toBeGreaterThan(0);
    for (const use of ['sanitizeTimestamp', 'frameFileName =', 'generateFrame(']) {
      expect(HANDLER.indexOf(use)).toBeGreaterThan(check);
    }
  });

  it('keeps the frame path inside the frame cache', () => {
    expect(HANDLER).toContain('const framePath = safeJoin(framesCacheDir, frameFileName);');
    expect(HANDLER.indexOf('safeJoin(framesCacheDir')).toBeLessThan(HANDLER.indexOf('fileExists(framePath)'));
  });

  it('answers a time past the end with a 404, not an error', () => {
    expect(HANDLER).toMatch(/error instanceof FrameOutOfRangeError[\s\S]*?status\(404\)/);
  });
});
