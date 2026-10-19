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
 *
 * Each file also gets a small index, kept in memory: line counts per minute,
 * category and level, and its first and last timestamps. It answers the
 * page's counts (facets) and lets a time range skip whole files. A rotated
 * file is indexed once; the live file is indexed on from where the last call
 * stopped.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { areaOf, isLogArea } from './logAreas.mjs';

const gunzipAsync = promisify(gunzip);

const LOG_FILE_NAME = /^application-(\d{4}-\d{2}-\d{2})\.log(?:\.(\d+))?(\.gz)?$/;
const CURSOR = /^(\d{4}-\d{2}-\d{2})\.(\d+):(\d+)$/;
const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// A record as winston writes it: keys sorted, so a category comes first and
// its level right after, and the top-level timestamp is followed by nothing
// but the trace fields. Such a line yields its category, level and time
// without a JSON.parse; any other line is parsed.
const PLAIN_RECORD =
  /^\{"category":"([^"\\]*)","level":"([a-z]+)",.*"timestamp":"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})"(?:,"trace_flags":\d+,"trace_id":"[0-9a-f]*")?\}$/;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
// About two days of busy logging; older files are still read, just not counted.
const MAX_INDEXED_FILES = 48;

/** Winston's npm levels, most severe first. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];

function compareFiles(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.index - b.index;
}

const fileKey = ({ date, index }) => `${date}.${index}`;

export function formatCursor(file, offset) {
  return `${fileKey(file)}:${offset}`;
}

/** @returns {{ date: string, index: number, offset: number } | null} null when `value` is not a cursor */
export function parseCursor(value) {
  const match = CURSOR.exec(value);
  if (!match) return null;
  return { date: match[1], index: Number(match[2]), offset: Number(match[3]) };
}

const pad = (number) => String(number).padStart(2, '0');

/** A time as the logger writes it: local, `YYYY-MM-DD HH:mm:ss`, which sorts as text. */
export function toLocalStamp(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function isoOf(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stampToIso(stamp) {
  const match = stamp && LOCAL_TIMESTAMP.exec(stamp);
  if (!match) return null;
  // Local time with no offset, read back in this process's zone (the one that wrote it).
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

/**
 * A line as the page shows it, and its local timestamp. A line that is not a
 * JSON record is kept as a raw entry (no time, level or category).
 */
function parseRecord(text, id) {
  let record = null;
  try {
    record = JSON.parse(text);
  } catch {
    // shown raw below
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { entry: { id, time: null, level: null, category: null, message: text, meta: null }, stamp: null };
  }
  const { timestamp, level, category, message, ...meta } = record;
  const stamp = typeof timestamp === 'string' && LOCAL_TIMESTAMP.test(timestamp) ? timestamp : null;
  return {
    entry: {
      id,
      time: stamp ? stampToIso(stamp) : typeof timestamp === 'string' ? isoOf(timestamp) : null,
      level: typeof level === 'string' ? level : null,
      category: typeof category === 'string' ? category : null,
      message: typeof message === 'string' ? message : JSON.stringify(message ?? ''),
      meta: Object.keys(meta).length > 0 ? meta : null,
    },
    stamp,
  };
}

export function parseLine(text, id) {
  return parseRecord(text, id).entry;
}

/** Category, level and local timestamp of a line, read without a full parse when it can be. */
function lineFields(text) {
  const plain = PLAIN_RECORD.exec(text);
  if (plain) return { category: plain[1], level: plain[2], stamp: plain[3], entry: null };
  const { entry, stamp } = parseRecord(text, null);
  return { category: entry.category, level: entry.level, stamp, entry };
}

/**
 * @param {object} [filters]
 * @param {string[]} [filters.only] show only these: `area:<id>` tokens or category names
 * @param {string[]} [filters.hide] show everything but these (same tokens); not with `only`
 * @param {string} [filters.level] the least severe level kept: `warn` keeps error and warn
 * @param {string} [filters.q] case-insensitive text in the category, message or fields
 * @param {number} [filters.from] epoch ms, inclusive
 * @param {number} [filters.to] epoch ms, inclusive
 */
export function createLogFilter({ only = [], hide = [], level, q, from, to } = {}) {
  if (only.length > 0 && hide.length > 0) throw new Error('only and hide cannot be used together');
  const maxRank = level ? LOG_LEVELS.indexOf(level) : -1;
  if (level && maxRank === -1) throw new Error(`Unknown log level: ${level}`);

  const readTokens = (tokens) => {
    const areas = new Set();
    const categories = new Set();
    for (const token of tokens) {
      if (token.startsWith('area:')) {
        const id = token.slice('area:'.length);
        if (!isLogArea(id)) throw new Error(`Unknown log area: ${id}`);
        areas.add(id);
      } else {
        categories.add(token);
      }
    }
    return { areas, categories };
  };
  const shown = only.length > 0 ? readTokens(only) : null;
  const hidden = hide.length > 0 ? readTokens(hide) : null;
  const needle = q ? q.toLowerCase() : null;
  const fromStamp = from === undefined ? null : toLocalStamp(from);
  const toStamp = to === undefined ? null : toLocalStamp(to);

  const categoryAllowed = (category) => {
    const name = category ?? '';
    const area = areaOf(category);
    if (shown) return shown.categories.has(name) || shown.areas.has(area);
    if (hidden) return !hidden.categories.has(name) && !hidden.areas.has(area);
    return true;
  };
  const levelAllowed = (lineLevel) => {
    if (!level) return true;
    const rank = LOG_LEVELS.indexOf(lineLevel);
    return rank !== -1 && rank <= maxRank;
  };

  return {
    fromStamp,
    toStamp,
    categoryAllowed,
    levelAllowed,
    textMatches(entry) {
      if (!needle) return true;
      const haystack = `${entry.category ?? ''} ${entry.message} ${entry.meta ? JSON.stringify(entry.meta) : ''}`;
      return haystack.toLowerCase().includes(needle);
    },
    /** Whether a minute (`YYYY-MM-DD HH:mm`, local) overlaps the time range. */
    minuteInRange: (minute) =>
      (fromStamp === null || minute >= fromStamp.slice(0, 16)) && (toStamp === null || minute <= toStamp.slice(0, 16)),
  };
}

const BEFORE_RANGE = Symbol('before the time range');
const DROP = Symbol('filtered out');

/** The entry a line becomes under `filter`, DROP, or BEFORE_RANGE when it is older than `from`. */
function judge(line, file, filter) {
  const fields = lineFields(line.text);
  const { stamp } = fields;
  if (filter.fromStamp !== null && (stamp === null || stamp < filter.fromStamp)) {
    return stamp === null ? DROP : BEFORE_RANGE;
  }
  if (filter.toStamp !== null && (stamp === null || stamp > filter.toStamp)) return DROP;
  if (!filter.categoryAllowed(fields.category) || !filter.levelAllowed(fields.level)) return DROP;
  const id = formatCursor(file, line.offset);
  const entry = fields.entry ? { ...fields.entry, id } : parseLine(line.text, id);
  return filter.textMatches(entry) ? entry : DROP;
}

// dir → (file key → { indexedTo, complete, first, last, counts })
const indexes = new Map();

/**
 * Brings the index of the newest MAX_INDEXED_FILES files up to date and
 * returns it, keyed by file key. A file shorter than what was indexed was
 * replaced, and is indexed again.
 */
async function updateIndex(dir, files) {
  let byKey = indexes.get(dir);
  if (!byKey) {
    byKey = new Map();
    indexes.set(dir, byKey);
  }
  const indexed = files.slice(-MAX_INDEXED_FILES);
  const keep = new Set(indexed.map(fileKey));
  for (const key of byKey.keys()) if (!keep.has(key)) byKey.delete(key);

  for (const [position, file] of indexed.entries()) {
    const key = fileKey(file);
    let entry = byKey.get(key);
    if (entry?.complete) continue;
    entry ??= { indexedTo: 0, complete: false, first: null, last: null, counts: new Map() };

    let { bytes, size } = await readFrom(file, entry.indexedTo);
    if (size < entry.indexedTo) {
      entry = { indexedTo: 0, complete: false, first: null, last: null, counts: new Map() };
      ({ bytes, size } = await readFrom(file, 0));
    }
    const { lines, end } = splitLines(bytes, entry.indexedTo);
    for (const line of lines) {
      const { category, level, stamp } = lineFields(line.text);
      if (stamp === null) continue;
      entry.first ??= stamp;
      entry.last = stamp;
      const bucket = `${stamp.slice(0, 16)}\t${category ?? ''}\t${level ?? ''}`;
      entry.counts.set(bucket, (entry.counts.get(bucket) ?? 0) + 1);
    }
    entry.indexedTo = end;
    entry.complete = position < indexed.length - 1 && end >= size;
    byKey.set(key, entry);
  }
  return byKey;
}

/**
 * Line counts within the time range: per category (under the level filter),
 * per level (under the category filter), and the total under both. The text
 * search is not applied; minutes at the edges of the range count whole.
 */
function countFacets(index, filter) {
  const categories = new Map();
  const levels = {};
  let total = 0;
  for (const entry of index.values()) {
    for (const [bucket, count] of entry.counts) {
      const [minute, category, level] = bucket.split('\t');
      if (!filter.minuteInRange(minute)) continue;
      const categoryOk = filter.categoryAllowed(category || null);
      const levelOk = filter.levelAllowed(level || null);
      if (levelOk) categories.set(category, (categories.get(category) ?? 0) + count);
      if (categoryOk && level) levels[level] = (levels[level] ?? 0) + count;
      if (categoryOk && levelOk) total += count;
    }
  }
  return {
    total,
    levels,
    categories: [...categories]
      .map(([name, count]) => ({ name: name || null, area: areaOf(name || null), count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** What the log covers: its oldest and newest indexed lines. */
function spanOf(index) {
  const entries = [...index.values()].filter((entry) => entry.first !== null);
  if (entries.length === 0) return { from: null, to: null };
  const first = entries.reduce((oldest, entry) => (entry.first < oldest ? entry.first : oldest), entries[0].first);
  const last = entries.reduce((newest, entry) => (entry.last > newest ? entry.last : newest), entries[0].last);
  return { from: stampToIso(first), to: stampToIso(last) };
}

/**
 * A page of entries ending just before `before`, or the newest page when
 * `before` is null. Reads at most `maxFiles` files (files the index puts
 * wholly outside the time range are skipped, not read); a page cut short by
 * that has an `older` cursor at the start of the oldest file it read.
 */
async function readBackward(files, index, before, { limit, filter, maxFiles }) {
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
    const known = index.get(fileKey(file));
    const isNewest = before === null && i === files.length - 1;
    // The live view continues from the end of the newest file, whatever the range.
    if (isNewest) newer = formatCursor(file, known?.indexedTo ?? 0);
    if (filter.fromStamp !== null && known?.last && known.last < filter.fromStamp) break; // it and older: before the range
    if (filter.toStamp !== null && known?.first && known.first > filter.toStamp) continue; // wholly after the range

    if (scanned === maxFiles) {
      // Everything before the start of the last file read (a skipped file in between holds nothing in range).
      older = formatCursor(files[i + 1], 0);
      break;
    }
    scanned += 1;

    const isCursorFile = before !== null && compareFiles(file, before) === 0;
    const { bytes } = await readFrom(file, 0);
    const { lines, end } = splitLines(isCursorFile ? bytes.subarray(0, before.offset) : bytes, 0);
    if (isNewest) newer = formatCursor(file, end);
    scannedFrom = lines.length > 0 ? stampToIso(lineFields(lines[0].text).stamp) ?? scannedFrom : scannedFrom;

    for (let j = lines.length - 1; j >= 0; j -= 1) {
      const line = lines[j];
      const verdict = judge(line, file, filter);
      if (verdict === BEFORE_RANGE) {
        scannedFrom = stampToIso(filter.fromStamp);
        break scan;
      }
      if (verdict === DROP) continue;
      collected.push(verdict);
      if (collected.length === limit) {
        const atVeryStart = i === 0 && line.offset === 0;
        older = atVeryStart ? null : formatCursor(file, line.offset);
        scannedFrom = verdict.time ?? scannedFrom;
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
      const verdict = judge(line, file, filter);
      if (verdict !== DROP && verdict !== BEFORE_RANGE) entries.push(verdict);
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
 *   facets: { total: number, levels: object, categories: { name, area, count }[] },
 *   span: { from: string | null, to: string | null },   ISO times of the oldest and newest indexed lines
 * }>}
 */
export async function readLogs(dir, { limit, filter, before = null, after = null, maxFiles }) {
  const files = await listLogFiles(dir);
  const index = await updateIndex(dir, files);
  const extras = { facets: countFacets(index, filter), span: spanOf(index) };

  if (after) {
    const forward = await readForward(files, after, { limit, filter, maxFiles });
    if (forward) return { ...forward, ...extras };
    return { ...(await readBackward(files, index, null, { limit, filter, maxFiles })), reset: true, ...extras };
  }
  return { ...(await readBackward(files, index, before, { limit, filter, maxFiles })), ...extras };
}
