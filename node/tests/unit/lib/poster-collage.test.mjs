/**
 * The poster collage job (lib/posterCollage.mjs): the POSTER_COLLAGE_ENABLED
 * switch, the inputs the library's credits.json names for the collage, and
 * the run that puts them together. Both of app.mjs's triggers (start-up and
 * the schedule) go through runPosterCollage.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  isPosterCollageEnabled,
  collageInputs,
  runPosterCollage,
  POSTER_COLLAGE_INPUTS_ENV,
} from '../../../lib/posterCollage.mjs';

let root;
const file = (rel, content = 'x') => {
  const full = join(root, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};
const credits = (assets) => file('credits.json', JSON.stringify({ schemaVersion: 1, assets, entries: [] }));
const collageAsset = (derivedFrom) => ({ id: 'poster-collage', kind: 'artwork', path: 'poster_collage.jpg', derivedFrom });
const POSTERS = ['movies/Alpha/poster.jpg', 'movies/Bravo/poster.jpg', 'movies/Charlie/poster.jpg'];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'collage-'));
  for (const poster of POSTERS) file(poster);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('isPosterCollageEnabled', () => {
  it.each([[undefined], ['true'], ['TRUE'], ['1'], ['yes'], ['']])('is on for %p', (value) => {
    expect(isPosterCollageEnabled(value === undefined ? {} : { POSTER_COLLAGE_ENABLED: value })).toBe(true);
  });

  it.each([['false'], ['FALSE'], [' false '], ['0'], ['off'], ['no']])('is off for %p', (value) => {
    expect(isPosterCollageEnabled({ POSTER_COLLAGE_ENABLED: value })).toBe(false);
  });
});

describe('collageInputs', () => {
  it('uses every poster when the library has no credits.json', async () => {
    expect(await collageInputs(root)).toEqual({ mode: 'all' });
  });

  it('uses exactly the inputs the credits name for the collage, in their order, once each', async () => {
    credits([
      { id: 'other', kind: 'logo', path: 'logo.png' },
      collageAsset([{ libraryPath: POSTERS[2] }, { libraryPath: POSTERS[0], note: 'n' }, { libraryPath: POSTERS[2] }]),
    ]);
    expect(await collageInputs(root)).toEqual({ mode: 'declared', inputs: [POSTERS[2], POSTERS[0]] });
  });

  it('reads a credits.json with a byte-order mark', async () => {
    file('credits.json', '\uFEFF' + JSON.stringify({ schemaVersion: 1, assets: [collageAsset([{ libraryPath: POSTERS[0] }])], entries: [] }));
    expect(await collageInputs(root)).toEqual({ mode: 'declared', inputs: [POSTERS[0]] });
  });

  it.each([
    ['credits.json is not JSON', () => file('credits.json', '{ nope'), /not JSON/],
    ['it has no collage asset', () => credits([{ id: 'other', kind: 'logo', path: 'logo.png' }]), /no asset for poster_collage\.jpg/],
    ['the collage asset names no input', () => credits([collageAsset([])]), /name no inputs/],
    ['the collage asset has no derivedFrom', () => credits([{ id: 'c', kind: 'artwork', path: 'poster_collage.jpg' }]), /name no inputs/],
    ['an input is missing', () => credits([collageAsset([{ libraryPath: POSTERS[0] }, { libraryPath: 'movies/Gone/poster.jpg' }])]), /missing or unreadable: movies\/Gone\/poster\.jpg/],
    ['an input is a folder', () => credits([collageAsset([{ libraryPath: 'movies/Alpha' }])]), /not a file: movies\/Alpha/],
    ['credits.json is a folder', () => mkdirSync(join(root, 'credits.json')), /could not be read/],
  ])('keeps the existing collage when %s', async (_name, arrange, reason) => {
    arrange();
    const result = await collageInputs(root);
    expect(result.mode).toBe('skip');
    expect(result.reason).toMatch(reason);
  });

  it.each([
    ['../outside.jpg'],
    ['/etc/passwd'],
    ['C:/media/poster.jpg'],
    ['movies\\Alpha\\poster.jpg'],
    ['movies/../../outside.jpg'],
    ['movies/./Alpha/poster.jpg'],
    ['music/cover.jpg'],
    [42],
    [null],
  ])('keeps the existing collage when an input is not a safe library path: %p', async (path) => {
    credits([collageAsset([{ libraryPath: path }])]);
    const result = await collageInputs(root);
    expect(result).toMatchObject({ mode: 'skip' });
    expect(result.reason).toMatch(/not a library path/);
  });
});

describe('runPosterCollage', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const runPython = jest.fn(async () => {});
  const run = (env = {}) =>
    runPosterCollage({ basePath: root, scriptPath: '/scripts/generate_poster_collage.py', runPython, logger, env, runOptions: { debug: false } });

  beforeEach(() => jest.clearAllMocks());

  it('does nothing at all when turned off', async () => {
    credits([collageAsset([{ libraryPath: POSTERS[0] }])]);
    expect(await run({ POSTER_COLLAGE_ENABLED: 'false' })).toBe('disabled');
    expect(runPython).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('runs the script with every poster when the library has no credits, never with an inherited input list', async () => {
    expect(await run({ [POSTER_COLLAGE_INPUTS_ENV]: '["movies/Zulu/poster.jpg"]', KEEP: 'me' })).toBe('built');
    const [{ env, scriptPath, debug }] = runPython.mock.calls[0];
    expect(scriptPath).toBe('/scripts/generate_poster_collage.py');
    expect(env).not.toHaveProperty(POSTER_COLLAGE_INPUTS_ENV);
    expect(env.KEEP).toBe('me');
    expect(debug).toBe(false);
  });

  it('runs the script with the inputs the credits name', async () => {
    credits([collageAsset([{ libraryPath: POSTERS[1] }, { libraryPath: POSTERS[0] }])]);
    expect(await run()).toBe('built');
    expect(JSON.parse(runPython.mock.calls[0][0].env[POSTER_COLLAGE_INPUTS_ENV])).toEqual([POSTERS[1], POSTERS[0]]);
  });

  it('logs why and does not run the script when the credits cannot decide', async () => {
    credits([collageAsset([{ libraryPath: 'movies/Gone/poster.jpg' }])]);
    expect(await run()).toBe('skipped');
    expect(runPython).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/not rebuilt: .*movies\/Gone\/poster\.jpg.*existing poster_collage\.jpg is kept/));
  });

  it('passes a script failure on', async () => {
    runPython.mockRejectedValueOnce(new Error('GeneratePosterCollage: exited with code 2'));
    await expect(run()).rejects.toThrow('exited with code 2');
  });
});

describe('app.mjs', () => {
  const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const code = readFileSync(join(NODE_DIR, 'app.mjs'), 'utf8')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (text) => text.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (text) => text.replace(/[^\n]/g, ' '));

  it('runs the collage only through runPosterCollage, from its start-up run and its schedule', () => {
    const body = code.slice(code.indexOf('async function runGeneratePosterCollage'));
    expect(body.slice(0, body.indexOf('\n}'))).toMatch(/await runPosterCollage\(\{/);
    // The script is named once, and handed only to runPosterCollage
    expect(code.match(/generatePosterCollageScript/g)).toHaveLength(2);
    expect(code).toMatch(/scriptPath: generatePosterCollageScript,/);
    // Both triggers call the one function
    expect(code.match(/(?<!function )runGeneratePosterCollage\(\)/g)).toHaveLength(2);
  });
});
