/**
 * Reads the processor's own log files for the admin Logs page (GET /api/logs,
 * routes/logs.mjs).
 *
 * The rotating transport in lib/logger.mjs writes one JSON record per line to
 * application-<YYYY-MM-DD>.log. When that file reaches its size cap the
 * transport starts application-<date>.log.1, then .2 and so on, and gzips each
 * file it leaves (….log.gz, ….log.1.gz). So a file's place in the log is its
 * date and its index (none = 0), and one file can be on disk plain, gzipped,
 * or briefly both; the plain copy wins. The reader this replaced kept only
 * names ending in ".log", which after the first rotation of the day matched
 * nothing but error.log and exceptions.log, so the page showed an empty log.
 *
 * A position in the log is a cursor `<date>.<index>:<byte offset>`. Older
 * pages walk back with `before` (the entries strictly before the cursor); the
 * live view walks forward with `after` (every entry from the cursor on). Only
 * newline-terminated lines are read, so a line the logger is still writing is
 * left for the next `after` read instead of being parsed half-written.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { gunzip } from 'zlib';
import { promisify } from 'util';

const gunzipAsync = promisify(gunzip);

const LOG_FILE_NAME = /^application-(\d{4}-\d{2}-\d{2})\.log(?:\.(\d+))?(\.gz)?$/;
const CURSOR = /^(\d{4}-\d{2}-\d{2})\.(\d+):(\d+)$/;
const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** Winston's npm levels, most severe first. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];

function compareFiles(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.index - b.index;
}

export function formatCursor({ date, index }, offset) {
  return `${date}.${index}:${offset}`;
}

/** @returns {{ date: string, index: number, offset: number } | null} null when `value` is not a cursor */
export function parseCursor(value) {
  const match = CURSOR.exec(value);
  if (!match) return null;
  return { date: match[1], index: Number(match[2]), offset: Number(match[3]) };
}

/**
 * The application log files in `dir`, oldest first, one per position. Each
 * has its plain path, its gzipped path, or both (the other is null).
 */
export async function listLogFiles(dir) {
  const byPosition = new Map();
  for (const name of await fs.readdir(dir)) {
    const match = LOG_FILE_NAME.exec(name);
    if (!match) continue;
    const date = match[1];
    const index = match[2] ? Number(match[2]) : 0;
    const key = `${date}.${index}`;
    const file = byPosition.get(key) ?? { date, index, plain: null, gz: null };
    file[match[3] ? 'gz' : 'plain'] = path.join(dir, name);
    byPosition.set(key, file);
  }
  return [...byPosition.values()].sort(compareFiles);
}

/**
 * The file's bytes from `start` on, and its full length. The transport
 * deletes the plain copy once the gzipped one is written, so a plain copy
 * that vanishes between listing and reading falls back to the gzip. A file
 * gone in both forms (aged out) reads as empty.
 */
async function readFrom(file, start) {
  if (file.plain) {
    try {
      const handle = await fs.open(file.plain, 'r');
      try {
        const { size } = await handle.stat();
        const buffer = Buffer.alloc(Math.max(0, size - start));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        return { bytes: buffer.subarray(0, bytesRead), size };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (file.gz) {
    try {
      const content = await gunzipAsync(await fs.readFile(file.gz));
      return { bytes: content.subarray(start), size: content.length };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { bytes: Buffer.alloc(0), size: 0 };
}

/**
 * The newline-terminated lines of `bytes`, which begin at byte `base` of
 * their file, and the offset just past the last of them.
 */
function splitLines(bytes, base) {
  const lines = [];
  let start = 0;
  for (let newline = bytes.indexOf(NEWLINE); newline !== -1; newline = bytes.indexOf(NEWLINE, start)) {
    const textEnd = newline > start && bytes[newline - 1] === CARRIAGE_RETURN ? newline - 1 : newline;
    if (textEnd > start) lines.push({ offset: base + start, text: bytes.toString('utf8', start, textEnd) });
    start = newline + 1;
  }
  return { lines, end: base + start };
}

function toIsoTime(timestamp) {
  if (typeof timestamp !== 'string') return null;
  // The logger writes local time with no offset; this process runs in the
  // zone that wrote it, so the Date constructor reads it back as written.
  const local = LOCAL_TIMESTAMP.exec(timestamp);
  const date = local
    ? new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5]), Number(local[6]))
    : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * One log line as the page shows it. A line that is not a JSON record is
 * kept as a raw entry (no time, level or category) rather than dropped.
 */
export function parseLine(text, id) {
  let record = null;
  try {
    record = JSON.parse(text);
  } catch {
    // shown raw below
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { id, time: null, level: null, category: null, message: text, meta: null };
  }
  const { timestamp, level, category, message, ...meta } = record;
  return {
    id,
    time: toIsoTime(timestamp),
    level: typeof level === 'string' ? level : null,
    category: typeof category === 'string' ? category : null,
    message: typeof message === 'string' ? message : JSON.stringify(message ?? ''),
    meta: Object.keys(meta).length > 0 ? meta : null,
  };
}

/**
 * @param {object} [filters]
 * @param {string} [filters.category] exact category
 * @param {string} [filters.level] the least severe level kept: `warn` keeps error and warn
 * @param {string} [filters.q] case-insensitive text in the category, message or fields
 */
export function createLogFilter({ category, level, q } = {}) {
  const maxRank = level ? LOG_LEVELS.indexOf(level) : -1;
  if (level && maxRank === -1) throw new Error(`Unknown log level: ${level}`);
  const needle = q ? q.toLowerCase() : null;
  // Winston writes compact JSON, so a record of this category or level holds
  // this text.
  const categoryField = category ? `"category":${JSON.stringify(category)}` : null;
  const levelFields = level ? LOG_LEVELS.slice(0, maxRank + 1).map((name) => `"level":"${name}"`) : null;
  return {
    /** A cheap test on the raw line, so most lines a filter rules out are never parsed. */
    mayMatch: (text) =>
      (categoryField === null || text.includes(categoryField)) &&
      (levelFields === null || levelFields.some((field) => text.includes(field))),
    matches(entry) {
      if (category && entry.category !== category) return false;
      if (level) {
        const rank = LOG_LEVELS.indexOf(entry.level);
        if (rank === -1 || rank > maxRank) return false;
      }
      if (needle) {
        const haystack = `${entry.category ?? ''} ${entry.message} ${entry.meta ? JSON.stringify(entry.meta) : ''}`;
        if (!haystack.toLowerCase().includes(needle)) return false;
      }
      return true;
    },
  };
}

function firstLineTime(bytes) {
  const newline = bytes.indexOf(NEWLINE);
  if (newline === -1) return null;
  return parseLine(bytes.toString('utf8', 0, newline).trimEnd(), null).time;
}

/**
 * A page of entries ending just before `before`, or the newest page when
 * `before` is null. Reads at most `maxFiles` files; a page cut short by that
 * has an `older` cursor at the start of the oldest file it read.
 */
async function readBackward(files, before, { limit, filter, maxFiles }) {
  const collected = []; // newest first
  let older = null;
  let newer = null;
  let scannedFrom = null;
  let scanned = 0;

  let i = files.length - 1;
  if (before) {
    while (i >= 0 && compareFiles(files[i], before) > 0) i -= 1;
  }

  scan: for (; i >= 0; i -= 1) {
    const file = files[i];
    if (scanned === maxFiles) {
      older = formatCursor(files[i + 1], 0);
      break;
    }
    scanned += 1;

    const { bytes } = await readFrom(file, 0);
    const isCursorFile = before !== null && compareFiles(file, before) === 0;
    const { lines, end } = splitLines(isCursorFile ? bytes.subarray(0, before.offset) : bytes, 0);
    if (before === null && i === files.length - 1) newer = formatCursor(file, end);
    scannedFrom = firstLineTime(bytes) ?? scannedFrom;

    for (let j = lines.length - 1; j >= 0; j -= 1) {
      const line = lines[j];
      if (!filter.mayMatch(line.text)) continue;
      const entry = parseLine(line.text, formatCursor(file, line.offset));
      if (!filter.matches(entry)) continue;
      collected.push(entry);
      if (collected.length === limit) {
        const atVeryStart = i === 0 && line.offset === 0;
        older = atVeryStart ? null : formatCursor(file, line.offset);
        scannedFrom = entry.time ?? scannedFrom;
        break scan;
      }
    }
  }

  return { entries: collected.reverse(), older, newer, reset: false, truncated: false, scannedFrom };
}

/**
 * Every entry from `after` on, or null when the cursor no longer points into
 * this log: its file is gone (a new container starts a new log) or shorter
 * than the cursor, or the reader is more than `maxFiles` files behind.
 * More than `limit` matches keeps the newest `limit` and sets `truncated`.
 */
async function readForward(files, after, { limit, filter, maxFiles }) {
  const startIndex = files.findIndex((file) => compareFiles(file, after) === 0);
  if (startIndex === -1 || files.length - startIndex > maxFiles) return null;

  const entries = [];
  let newer = formatCursor(after, after.offset);
  for (let i = startIndex; i < files.length; i += 1) {
    const file = files[i];
    const start = i === startIndex ? after.offset : 0;
    const { bytes, size } = await readFrom(file, start);
    if (i === startIndex && size < after.offset) return null;

    const { lines, end } = splitLines(bytes, start);
    for (const line of lines) {
      if (!filter.mayMatch(line.text)) continue;
      const entry = parseLine(line.text, formatCursor(file, line.offset));
      if (filter.matches(entry)) entries.push(entry);
    }
    newer = formatCursor(file, end);
  }

  const truncated = entries.length > limit;
  if (truncated) entries.splice(0, entries.length - limit);
  return { entries, older: null, newer, reset: false, truncated, scannedFrom: null };
}

/**
 * @param {string} dir the log directory
 * @param {object} options
 * @param {number} options.limit the most entries to return
 * @param {ReturnType<typeof createLogFilter>} options.filter
 * @param {{ date: string, index: number, offset: number } | null} [options.before] page of entries before this cursor
 * @param {{ date: string, index: number, offset: number } | null} [options.after] every entry from this cursor on
 * @param {number} options.maxFiles the most files one call reads
 * @returns {Promise<{
 *   entries: object[],            oldest first
 *   older: string | null,         `before` cursor for the page before this one; null when there is none
 *   newer: string | null,         `after` cursor for what comes next; null for an older page
 *   reset: boolean,               the `after` cursor was stale, so this is the newest page instead
 *   truncated: boolean,           an `after` read matched more than `limit`; the oldest were left out
 *   scannedFrom: string | null,   ISO time back to which an older-going read looked
 * }>}
 */
export async function readLogs(dir, { limit, filter, before = null, after = null, maxFiles }) {
  const files = await listLogFiles(dir);
  if (after) {
    const forward = await readForward(files, after, { limit, filter, maxFiles });
    if (forward) return forward;
    return { ...(await readBackward(files, null, { limit, filter, maxFiles })), reset: true };
  }
  return readBackward(files, before, { limit, filter, maxFiles });
}
