/**
 * The `@removeAtVersion` convention, as functions (the guard is
 * tests/unit/expiring-migrations.test.mjs, which documents the rule).
 *
 * A marker is the tag, a version, and a sentence saying what removing the
 * marked code means. The sentence runs on to the following comment lines until
 * a blank comment line, another `@` tag or the end of the comment.
 */

import { readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';

const TAG = '@removeAtVersion';
const VERSION = /^\d+(?:\.\d+)*$/;

/**
 * A version's numeric segments, or null when it is not one: digits separated
 * by dots, leading zeros allowed (2026.09.01 is [2026, 9, 1]).
 *
 * @param {string} text
 * @returns {number[]|null}
 */
export function parseVersion(text) {
  if (typeof text !== 'string' || !VERSION.test(text)) return null;
  return text.split('.').map(Number);
}

/**
 * Compare two versions segment by segment; a missing segment counts as 0, so
 * 1.1 equals 1.1.0.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b, 0 when equal, positive when a > b
 * @throws when either does not parse
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`not a version: ${!left ? a : b}`);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** A comment line's text, without its leading `*`, `//` or `/**`. */
function commentText(line) {
  return line.replace(/^\s*(?:\/\*\*?|\*\/?|\/\/)?\s?/, '').replace(/\*\/\s*$/, '').trim();
}

/**
 * Every marker in the given sources.
 *
 * @param {Array<{file: string, source: string}>} sources
 * @returns {Array<{file: string, line: number, version: string|null, raw: string, sentence: string}>}
 *   `version` is null for a malformed marker (no version, or one that does not
 *   parse); `raw` is the token found after the tag.
 */
export function findMarkers(sources) {
  const markers = [];
  for (const { file, source } of sources) {
    const lines = source.split(/\r?\n/);
    lines.forEach((text, index) => {
      const at = text.indexOf(TAG);
      if (at < 0) return;
      const rest = text.slice(at + TAG.length);
      const match = rest.match(/^\s+(\S+)\s*(.*)$/);
      const raw = match ? match[1] : '';
      const parts = match && match[2] ? [match[2].replace(/\*\/\s*$/, '').trim()] : [];
      if (!/\*\//.test(rest)) {
        for (let next = index + 1; next < lines.length; next++) {
          const line = lines[next];
          const body = commentText(line);
          if (body === '' || body.startsWith('@') || !/^\s*(\*|\/\/)/.test(line)) break;
          parts.push(body);
          if (/\*\//.test(line)) break;
        }
      }
      markers.push({
        file,
        line: index + 1,
        version: parseVersion(raw) ? raw : null,
        raw,
        sentence: parts.filter(Boolean).join(' '),
      });
    });
  }
  return markers;
}

/**
 * What the guard fails on: markers whose version the current one has reached,
 * and malformed markers.
 *
 * @param {ReturnType<typeof findMarkers>} markers
 * @param {string} currentVersion
 * @returns {{overdue: string[], malformed: string[]}} each as `file:line <version> <sentence>`
 */
export function checkMarkers(markers, currentVersion) {
  const overdue = [];
  const malformed = [];
  for (const marker of markers) {
    const where = `${marker.file}:${marker.line}`;
    if (!marker.version) {
      malformed.push(`${where} "${marker.raw}" is not a version: ${marker.sentence}`.trim());
    } else if (compareVersions(currentVersion, marker.version) >= 0) {
      overdue.push(`${where} ${marker.version} ${marker.sentence}`.trim());
    }
  }
  return { overdue, malformed };
}

/**
 * The processor's own source files: every .mjs and .js under `root`, outside
 * node_modules and tests, relative to `root` with forward slashes.
 *
 * @param {string} root - The node/ directory
 * @returns {Array<{file: string, source: string}>}
 */
export function processorSources(root) {
  const skipped = new Set(['node_modules', 'tests', 'coverage']);
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || skipped.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.m?js$/.test(entry.name)) {
        out.push({ file: relative(root, path).split(sep).join('/'), source: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(root);
  return out;
}
