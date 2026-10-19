/**
 * Every log category belongs to an area of the admin Logs page
 * (lib/logAreas.mjs). A new createCategoryLogger() name that isn't added
 * there would land in "Other", so this reads the names off the source.
 */

import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LOG_AREAS, areaOf, isLogArea, listLogAreas } from '../../../lib/logAreas.mjs';

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKIP = new Set(['node_modules', 'tests', 'logs', 'db', 'cache', 'coverage']);

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return SKIP.has(name) ? [] : sourceFiles(full);
    return /\.(mjs|js)$/.test(name) ? [full] : [];
  });
}

const CALL = /create(Category|Python)Logger\(\s*(["'`])([^"'`$]+)\2\s*\)/g;

function categoriesInSource() {
  const names = new Set();
  for (const file of sourceFiles(NODE_DIR)) {
    for (const [, kind, , name] of readFileSync(file, 'utf8').matchAll(CALL)) {
      names.add(kind === 'Python' ? `python:${name}` : name);
    }
  }
  return [...names].sort();
}

describe('log areas', () => {
  it('give every category in the source an area', () => {
    const names = categoriesInSource();
    expect(names.length).toBeGreaterThan(50);
    expect(names.filter((name) => areaOf(name) === 'other')).toEqual([]);
  });

  it('list each category once', () => {
    const all = LOG_AREAS.flatMap((area) => area.categories);
    expect(all.filter((name, index) => all.indexOf(name) !== index)).toEqual([]);
  });

  it('place prefixed sub-categories with their family and unknown ones in Other', () => {
    expect(areaOf('discordBot:someNewCommand')).toBe('discord');
    expect(areaOf('not-a-category')).toBe('other');
    expect(areaOf(null)).toBe('other');
  });

  it('know their own ids, with Other last', () => {
    expect(listLogAreas().at(-1)).toEqual({ id: 'other', label: 'Other' });
    expect(isLogArea('scan')).toBe(true);
    expect(isLogArea('nope')).toBe(false);
  });
});
