/**
 * The single-writer rule for movies and tv_shows.
 *
 * Every statement that writes either table sits in one of the writer functions
 * of sqliteDatabase.mjs, and each of those goes through writeMediaTable, which
 * bumps the table's generation when a row changed. The cached /media/tv and
 * /media/movies bodies (lib/mediaPayloadCache.mjs) are dropped only when that
 * generation moves, so a write made anywhere else would go unseen until their
 * 10-minute backstop.
 *
 * This scans the processor's code — node/ without node_modules and tests, and
 * scripts/ — for INSERT, UPDATE, REPLACE and DELETE statements on either
 * table, and on any interpolated table (`${table}`), which could be either.
 * A new writer belongs in sqliteDatabase.mjs, behind writeMediaTable, and in
 * WRITERS below.
 */

import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO_DIR = join(NODE_DIR, '..');
const SCAN_ROOTS = [NODE_DIR, join(REPO_DIR, 'scripts')];
const SKIP_DIRS = new Set(['node_modules', 'tests', 'logs', 'db']);
const CODE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.py']);

// The functions allowed to write movies and tv_shows, by file.
const WRITERS = {
  'node/sqliteDatabase.mjs': ['deleteMovie', 'deleteTVShow', 'insertOrUpdateTVShow', 'insertOrUpdateMovie'],
};

// A write statement on movies, tv_shows or an interpolated table name.
const WRITE_STATEMENT =
  /\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:main\.)?["'`[]?(movies\b|tv_shows\b|\$\{[^}]*\})/gi;

function codeFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...codeFiles(path));
    } else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

/** The name of the last function declared before `index`, or null. */
function enclosingFunction(source, index) {
  let name = null;
  for (const match of source.slice(0, index).matchAll(/\bfunction\s+(\w+)\s*\(/g)) name = match[1];
  return name;
}

/** Every write statement on the two tables in the processor's code. */
function findWrites() {
  const writes = [];
  for (const path of SCAN_ROOTS.flatMap(codeFiles)) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(WRITE_STATEMENT)) {
      writes.push({
        file: relative(REPO_DIR, path).split('\\').join('/'),
        line: source.slice(0, match.index).split('\n').length,
        statement: `${match[1].replace(/\s+/g, ' ').toUpperCase()} ${match[2]}`,
        inFunction: enclosingFunction(source, match.index),
      });
    }
  }
  return writes;
}

/** A function's source, from its declaration to the next top-level declaration. */
function functionSource(source, name) {
  const start = source.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:export\s+)?(?:async\s+)?(?:function|const|let|class)\s/);
  return source.slice(start, end < 0 ? undefined : start + 1 + end);
}

describe('the single writer of movies and tv_shows', () => {
  const writes = findWrites();

  it('has no write statement on either table outside the writer functions', () => {
    const outside = writes.filter((write) => !WRITERS[write.file]?.includes(write.inFunction));
    expect(outside).toEqual([]);
  });

  it('finds the writers\' own statements, so the scan is looking in the right place', () => {
    expect(writes.map((write) => `${write.inFunction}: ${write.statement}`).sort()).toEqual([
      'deleteMovie: DELETE FROM movies',
      'deleteTVShow: DELETE FROM tv_shows',
      'insertOrUpdateMovie: INSERT INTO movies',
      'insertOrUpdateTVShow: INSERT INTO tv_shows',
    ]);
  });

  it('has every writer go through writeMediaTable', () => {
    for (const [file, names] of Object.entries(WRITERS)) {
      const source = readFileSync(join(REPO_DIR, file), 'utf8');
      for (const name of names) {
        const body = functionSource(source, name);
        expect({ name, found: Boolean(body) }).toEqual({ name, found: true });
        expect({ name, writesThroughWriteMediaTable: /\bwriteMediaTable\(/.test(body) }).toEqual({
          name,
          writesThroughWriteMediaTable: true,
        });
      }
    }
  });

  it('recognizes the statement forms it is looking for, and nothing else', () => {
    const caught = (sql) => [...sql.matchAll(WRITE_STATEMENT)].length > 0;
    for (const sql of [
      'UPDATE movies SET hdr = ?',
      'update tv_shows set seasons = ?',
      'UPDATE OR IGNORE movies SET hdr = ?',
      'INSERT INTO movies (name) VALUES (?)',
      'INSERT OR REPLACE INTO tv_shows (name) VALUES (?)',
      'REPLACE INTO "movies" (name) VALUES (?)',
      'DELETE FROM main.tv_shows WHERE name = ?',
      'INSERT INTO `movies` (name) VALUES (?)',
      'UPDATE ${table} SET hdr = ?',
      'DELETE FROM ${tableName} WHERE name = ?',
    ]) {
      expect({ sql, caught: caught(sql) }).toEqual({ sql, caught: true });
    }
    for (const sql of [
      'ON CONFLICT(name) DO UPDATE SET hdr = excluded.hdr',
      'SELECT * FROM movies ORDER BY name',
      'SELECT EXISTS(SELECT 1 FROM ${tableName} LIMIT 1)',
      'ALTER TABLE tv_shows ADD COLUMN media_id TEXT',
      'DELETE FROM movies_archive WHERE name = ?',
      'UPDATE blurhash_hashes SET hash = ?',
      'INSERT INTO metadata_hashes (title) VALUES (?)',
    ]) {
      expect({ sql, caught: caught(sql) }).toEqual({ sql, caught: false });
    }
  });
});
