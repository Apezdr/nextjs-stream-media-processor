/**
 * MediaPayloadCache.get() is called from the HTTP list, manifest and entries
 * handlers only, read off the source.
 *
 * A build runs loadRows, which may scan an empty table as a MEDIA_SCAN task
 * (lib/libraryScanTask.mjs). A request waits for the scan group and that is
 * fine. A task holding the group that called get() while a request's build was
 * in flight would join that build, which waits for a scan queued behind the
 * task: neither would ever finish. So no task may reach get(). This pins every
 * path to it:
 *
 *   - the only `.get()` calls with no argument in the processor's code are the
 *     two in the list handler (createMediaListHandler's) and currentGeneration;
 *   - currentGeneration is called only by the manifest and entries handlers
 *     (createManifestHandler's and createEntriesHandler's);
 *   - the three handler factories are called only where a route is mounted:
 *     createMediaListHandler and createManifestHandler inside app.get(...) in
 *     app.mjs, createEntriesHandler inside mountMediaEntriesRoute, which only
 *     app.mjs calls;
 *   - only app.mjs builds a MediaPayloadCache.
 *
 * Comment lines are not code, so they are left out of the scan.
 */

import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIPPED_DIRS = new Set(['node_modules', 'tests', 'coverage']);

/** The source with comment lines blanked, as in app-request-body-wiring.test.mjs. */
function codeOf(source) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  return source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** Every .mjs and .js file of the processor's own code, relative to node/, with its code. */
function sourceFiles(dir = NODE_DIR, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, files);
    else if (/\.m?js$/.test(entry.name)) {
      files.push({ file: relative(NODE_DIR, path).split(sep).join('/'), code: codeOf(readFileSync(path, 'utf8')) });
    }
  }
  return files;
}

/** The name of the last function declared before `index`: the one a call sits in. */
function enclosingFunction(code, index) {
  const declared = [...code.slice(0, index).matchAll(/\bfunction\s+(\w+)\s*\(/g)];
  return declared.length ? declared[declared.length - 1][1] : null;
}

/** Each call of `pattern` in the code, as `file:function`. */
function callSites(files, pattern) {
  const sites = [];
  for (const { file, code } of files) {
    for (const match of code.matchAll(pattern)) sites.push(`${file}:${enclosingFunction(code, match.index)}`);
  }
  return sites.sort();
}

const FILES = sourceFiles();

describe('MediaPayloadCache.get() callers', () => {
  it('scans the processor code (a scan that read nothing would pass)', () => {
    const names = FILES.map((f) => f.file);
    expect(names).toEqual(expect.arrayContaining(['app.mjs', 'lib/mediaPayloadCache.mjs', 'lib/mediaManifest.mjs']));
    expect(names.some((name) => name.startsWith('node_modules/') || name.startsWith('tests/'))).toBe(false);
  });

  it('has two get() calls, in the list handler and in the manifest and entries handlers\' reader', () => {
    expect(callSites(FILES, /\.get\(\s*\)/g)).toEqual([
      'lib/mediaManifest.mjs:currentGeneration',
      // The handler createMediaListHandler returns.
      'lib/mediaPayloadCache.mjs:mediaListHandler',
    ]);
  });

  it('reads currentGeneration from the manifest and entries handlers only', () => {
    expect(callSites(FILES, /(?<!function\s)\bcurrentGeneration\s*\(/g)).toEqual([
      // The handlers createEntriesHandler and createManifestHandler return.
      'lib/mediaManifest.mjs:mediaEntriesHandler',
      'lib/mediaManifest.mjs:mediaManifestHandler',
    ]);
  });

  it('calls the handler factories only where routes are mounted', () => {
    const calls = (name) => callSites(FILES, new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`, 'g'));
    const files = (name) => calls(name).map((site) => site.split(':')[0]);
    expect(files('createMediaListHandler')).toEqual(['app.mjs', 'app.mjs']);
    expect(files('createManifestHandler')).toEqual(['app.mjs', 'app.mjs']);
    expect(calls('createEntriesHandler')).toEqual(['lib/requestBodyParsers.mjs:mountMediaEntriesRoute']);
    expect(files('mountMediaEntriesRoute')).toEqual(['app.mjs', 'app.mjs']);

    // In app.mjs those four calls are each the handler argument of an
    // app.get(...) for a list or manifest path, and the two entries mounts
    // are top-level statements.
    const app = FILES.find((f) => f.file === 'app.mjs').code;
    const mounted = /\bapp\.get\(\s*["'`]\/media\/(?:tv|movies)(?:\/manifest)?["'`]\s*,\s*authenticateWebhookOrUser\s*,\s*create(?:MediaList|Manifest)Handler\(/g;
    expect(app.match(mounted)).toHaveLength(4);
    expect(app.match(/^mountMediaEntriesRoute\(app, \{$/gm)).toHaveLength(2);
  });

  it('builds a MediaPayloadCache in app.mjs only', () => {
    expect(callSites(FILES, /\bnew\s+MediaPayloadCache\s*\(/g).map((site) => site.split(':')[0])).toEqual(['app.mjs', 'app.mjs']);
  });
});
