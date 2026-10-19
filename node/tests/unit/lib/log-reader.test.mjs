/**
 * lib/logReader.mjs: the admin Logs page's reader over the rotating
 * application log. The reader it replaced kept only names ending in ".log", so
 * once the live file was application-<date>.log.N it served nothing but the
 * (empty) error.log and exceptions.log.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import { gzipSync } from 'zlib';
import os from 'os';
import path from 'path';
import {
  createLogFilter,
  formatCursor,
  listLogFiles,
  parseCursor,
  parseLine,
  readLogs,
} from '../../../lib/logReader.mjs';

let dir;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-reader-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const line = (message, fields = {}) =>
  `${JSON.stringify({ category: 'main', level: 'info', message, timestamp: '2026-10-19 08:00:00', ...fields })}\n`;
const lines = (...messages) => messages.map((message) => line(message)).join('');

const writePlain = (name, content) => fs.writeFile(path.join(dir, name), content);
const writeGz = (name, content) => fs.writeFile(path.join(dir, name), gzipSync(Buffer.from(content)));
const append = (name, content) => fs.appendFile(path.join(dir, name), content);

const read = (options = {}) =>
  readLogs(dir, { limit: 100, filter: createLogFilter(), maxFiles: 10, ...options });
const messages = (result) => result.entries.map((entry) => entry.message);

describe('listLogFiles', () => {
  it('orders the rotated files by date, then by numeric index, and pairs a plain copy with its gzip', async () => {
    for (const name of [
      'application-2026-10-19.log.10',
      'application-2026-10-19.log.2',
      'application-2026-10-19.log.1',
      'application-2026-10-19.log.1.gz',
      'application-2026-10-19.log.gz',
      'application-2026-10-18.log.1.gz',
      'application-2026-10-18.log.gz',
      'python-2026-10-19.log.3',
      'error.log',
      'exceptions.log',
      '.4430a4b41d8e3a245164ad1177f170da18a3dcf9-audit.json',
    ]) {
      await writePlain(name, '');
    }

    const files = await listLogFiles(dir);

    expect(files.map(({ date, index, plain, gz }) => [
      `${date}.${index}`,
      plain && path.basename(plain),
      gz && path.basename(gz),
    ])).toEqual([
      ['2026-10-18.0', null, 'application-2026-10-18.log.gz'],
      ['2026-10-18.1', null, 'application-2026-10-18.log.1.gz'],
      ['2026-10-19.0', null, 'application-2026-10-19.log.gz'],
      ['2026-10-19.1', 'application-2026-10-19.log.1', 'application-2026-10-19.log.1.gz'],
      ['2026-10-19.2', 'application-2026-10-19.log.2', null],
      ['2026-10-19.10', 'application-2026-10-19.log.10', null],
    ]);
  });
});

describe('cursors', () => {
  it('round-trip, and anything else is not a cursor', () => {
    const cursor = formatCursor({ date: '2026-10-19', index: 22 }, 2191845);
    expect(cursor).toBe('2026-10-19.22:2191845');
    expect(parseCursor(cursor)).toEqual({ date: '2026-10-19', index: 22, offset: 2191845 });
    for (const bad of ['', '2026-10-19:5', '2026-10-19.x:5', '../etc/passwd', '2026-10-19.1:5;']) {
      expect(parseCursor(bad)).toBeNull();
    }
  });
});

describe('parseLine', () => {
  it('reads the logger\'s offset-less local time in this process\'s zone and keeps the other fields as meta', () => {
    const entry = parseLine(
      JSON.stringify({ category: 'identity', level: 'warn', message: 'hi', timestamp: '2026-10-19 17:36:18', status: 404 }),
      'id-1'
    );
    expect(entry).toEqual({
      id: 'id-1',
      time: new Date(2026, 9, 19, 17, 36, 18).toISOString(),
      level: 'warn',
      category: 'identity',
      message: 'hi',
      meta: { status: 404 },
    });
  });

  it('keeps a line that is not a JSON record as a raw entry', () => {
    expect(parseLine('Error: something printed raw', 'id-2')).toEqual({
      id: 'id-2', time: null, level: null, category: null, message: 'Error: something printed raw', meta: null,
    });
  });
});

describe('readLogs: older pages', () => {
  beforeEach(async () => {
    await writeGz('application-2026-10-18.log.gz', lines('1', '2', '3'));
    await writeGz('application-2026-10-19.log.1.gz', lines('4', '5', '6'));
    // The live file, with a line the logger is still writing.
    await writePlain('application-2026-10-19.log.2', `${lines('7', '8', '9')}{"category":"main","lev`);
  });

  it('pages back through plain and gzipped files to the start of the log', async () => {
    const first = await read({ limit: 4 });
    expect(messages(first)).toEqual(['6', '7', '8', '9']);
    expect(first.newer).toBe(formatCursor({ date: '2026-10-19', index: 2 }, Buffer.byteLength(lines('7', '8', '9'))));
    expect(first.older).toBe(first.entries[0].id);

    const second = await read({ limit: 4, before: parseCursor(first.older) });
    expect(messages(second)).toEqual(['2', '3', '4', '5']);
    expect(second.newer).toBeNull();

    const third = await read({ limit: 4, before: parseCursor(second.older) });
    expect(messages(third)).toEqual(['1']);
    expect(third.older).toBeNull();
  });

  it('has no older cursor when a full page ends on the first line of the log', async () => {
    const all = await read({ limit: 9 });
    expect(messages(all)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(all.older).toBeNull();
  });

  it('reads no more than maxFiles files, and the older cursor carries on from where it stopped', async () => {
    const filter = createLogFilter({ q: 'only-in-the-oldest' });
    await writeGz('application-2026-10-18.log.gz', `${line('1')}${line('only-in-the-oldest')}`);

    const first = await read({ filter, maxFiles: 2 });
    expect(first.entries).toEqual([]);
    expect(first.older).toBe('2026-10-19.1:0');
    expect(first.scannedFrom).toBe(new Date(2026, 9, 19, 8, 0, 0).toISOString());

    const second = await read({ filter, maxFiles: 2, before: parseCursor(first.older) });
    expect(messages(second)).toEqual(['only-in-the-oldest']);
    expect(second.older).toBeNull();
  });
});

describe('readLogs: the live view', () => {
  const LIVE = 'application-2026-10-19.log.2';

  it('picks up a half-written line once it is finished, then what follows', async () => {
    await writePlain(LIVE, `${lines('7')}${line('8').slice(0, 20)}`);
    const first = await read();
    expect(messages(first)).toEqual(['7']);

    await append(LIVE, `${line('8').slice(20)}${line('9')}`);
    const next = await read({ after: parseCursor(first.newer) });
    expect(messages(next)).toEqual(['8', '9']);
    expect(next.reset).toBe(false);

    const idle = await read({ after: parseCursor(next.newer) });
    expect(idle.entries).toEqual([]);
    expect(idle.newer).toBe(next.newer);
  });

  it('follows the log across a rotation, through the gzip that replaced the plain file', async () => {
    await writePlain(LIVE, lines('7'));
    const first = await read();

    // More lines, then the transport moves on to .3 and gzips .2.
    const rotated = lines('7', '8');
    await fs.rm(path.join(dir, LIVE));
    await writeGz(`${LIVE}.gz`, rotated);
    await writePlain('application-2026-10-19.log.3', lines('9'));

    const next = await read({ after: parseCursor(first.newer) });
    expect(messages(next)).toEqual(['8', '9']);
    expect(next.newer).toBe(formatCursor({ date: '2026-10-19', index: 3 }, Buffer.byteLength(lines('9'))));
  });

  it('starts over from the newest page when the cursor\'s file is gone or shorter than the cursor', async () => {
    await writePlain(LIVE, lines('1', '2'));

    const gone = await read({ after: parseCursor('2026-10-19.22:100') });
    expect(gone.reset).toBe(true);
    expect(messages(gone)).toEqual(['1', '2']);

    const cutShort = await read({ after: parseCursor('2026-10-19.2:999999') });
    expect(cutShort.reset).toBe(true);
    expect(messages(cutShort)).toEqual(['1', '2']);
  });

  it('starts over when it is more than maxFiles files behind', async () => {
    await writePlain('application-2026-10-19.log.1', lines('1'));
    await writePlain(LIVE, lines('2'));
    await writePlain('application-2026-10-19.log.3', lines('3'));

    const behind = await read({ after: parseCursor('2026-10-19.1:0'), maxFiles: 2 });
    expect(behind.reset).toBe(true);
    expect(messages(behind)).toEqual(['2', '3']);
    expect(behind.older).toBe('2026-10-19.2:0');
  });

  it('keeps the newest `limit` entries and says so when more arrived', async () => {
    await writePlain(LIVE, '');
    const first = await read();
    await append(LIVE, lines('1', '2', '3'));

    const next = await read({ after: parseCursor(first.newer), limit: 2 });
    expect(messages(next)).toEqual(['2', '3']);
    expect(next.truncated).toBe(true);
  });
});

describe('readLogs: filters', () => {
  beforeEach(async () => {
    await writePlain(
      'application-2026-10-19.log.2',
      [
        line('scan started', { category: 'main' }),
        line('TMDB said no', { category: 'tmdb', level: 'error', endpoint: '/tv/275188' }),
        line('slow probe', { category: 'ffprobe', level: 'warn' }),
        line('cached', { category: 'tmdb', level: 'info' }),
      ].join('')
    );
  });

  it('keeps one category', async () => {
    expect(messages(await read({ filter: createLogFilter({ category: 'tmdb' }) }))).toEqual(['TMDB said no', 'cached']);
  });

  it('keeps a level and everything more severe', async () => {
    expect(messages(await read({ filter: createLogFilter({ level: 'warn' }) }))).toEqual(['TMDB said no', 'slow probe']);
    expect(messages(await read({ filter: createLogFilter({ level: 'error' }) }))).toEqual(['TMDB said no']);
  });

  it('finds text in the message or the fields, ignoring case', async () => {
    expect(messages(await read({ filter: createLogFilter({ q: '/TV/275188' }) }))).toEqual(['TMDB said no']);
    expect(messages(await read({ filter: createLogFilter({ q: 'PROBE' }) }))).toEqual(['slow probe']);
  });

  it('rejects an unknown level', () => {
    expect(() => createLogFilter({ level: 'loud' })).toThrow('Unknown log level: loud');
  });
});
