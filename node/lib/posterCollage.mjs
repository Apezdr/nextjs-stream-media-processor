// lib/posterCollage.mjs
//
// The poster collage job: `poster_collage.jpg` at the library root, the
// site's background and share image, rebuilt by scripts/generate_poster_collage.py
// on the processor's start and every 30 minutes (app.mjs).
//
// Two things decide whether, and from what, it is rebuilt:
//
//   1. POSTER_COLLAGE_ENABLED. On unless set to false (or 0, off, no). Off,
//      the job does nothing at all: the existing poster_collage.jpg is left
//      exactly as it is, never deleted or rewritten. Read on every run, as the
//      other switches are.
//
//   2. The library's credits file, `<library root>/credits.json` (the frontend's
//      CREDITS_SIDECAR.md, "Library scope"). The collage is a derived work, and
//      its credits name what it is made of, so when that file credits the
//      collage, the collage is made of exactly what it names:
//
//        - no credits.json at the root: every poster, as before;
//        - a credits.json whose asset with `path: "poster_collage.jpg"` names
//          its inputs (`derivedFrom[].libraryPath`), each of them a file: those
//          inputs and nothing else, so a title added to the library never
//          slips into a collage its credits do not cover;
//        - a credits.json that cannot be read or parsed, that has no collage
//          asset, whose collage asset names no input, or that names an input
//          that is missing or not a safe library path: no rebuild this run,
//          and the existing collage is kept. It never falls back to every
//          poster, which is how uncredited art would get in.
//
// This reads one field of one asset of the credits file and nothing else: the
// file's validation is the frontend's. The scanner stays schema-blind; this is
// the collage job, which has to know what it may be made of.
//
// The script keeps the order in which it finds the posters on disk and drops
// the ones not named, so when the named inputs are the posters it would have
// used anyway, the collage comes out byte for byte the same.

import { promises as fsPromises } from 'fs';
import { join, resolve, sep } from 'path';

/** The collage's file name at the library root. */
export const POSTER_COLLAGE_FILE = 'poster_collage.jpg';

/** The environment variable the script reads its inputs from (a JSON array of library paths). */
export const POSTER_COLLAGE_INPUTS_ENV = 'POSTER_COLLAGE_INPUTS';

const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

/**
 * Whether the collage job runs. On unless POSTER_COLLAGE_ENABLED is false (or
 * 0, off, no), so a deployment that never sets it behaves as before.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isPosterCollageEnabled(env = process.env) {
  const value = env.POSTER_COLLAGE_ENABLED;
  if (value === undefined || value === null) return true;
  return !OFF_VALUES.has(String(value).trim().toLowerCase());
}

/**
 * A library-relative path that stays inside the library: under movies/ or tv/,
 * forward slashes, no empty, '.' or '..' segment, nothing absolute.
 */
function isSafeLibraryPath(path) {
  if (typeof path !== 'string' || path === '') return false;
  if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  if (!/^(movies|tv)\//.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * What the collage may be made of, according to the library's credits file.
 *
 * @param {string} basePath - The library root (BASE_PATH)
 * @param {{ fs?: typeof fsPromises }} [deps]
 * @returns {Promise<
 *   { mode: 'all' } |
 *   { mode: 'declared', inputs: string[] } |
 *   { mode: 'skip', reason: string }
 * >} `inputs` are library-relative paths, in the order the credits name them
 */
export async function collageInputs(basePath, { fs = fsPromises } = {}) {
  const skip = (reason) => ({ mode: 'skip', reason });

  let text;
  try {
    text = await fs.readFile(join(basePath, 'credits.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { mode: 'all' };
    return skip(`the library's credits.json could not be read (${error?.code ?? error?.message ?? error})`);
  }

  let document;
  try {
    document = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    return skip(`the library's credits.json is not JSON (${error.message})`);
  }

  const assets = Array.isArray(document?.assets) ? document.assets : null;
  const collage = assets?.filter((asset) => asset && typeof asset === 'object' && asset.path === POSTER_COLLAGE_FILE) ?? [];
  if (collage.length === 0) {
    return skip(`the library's credits.json has no asset for ${POSTER_COLLAGE_FILE}`);
  }

  const inputs = [];
  for (const asset of collage) {
    for (const input of Array.isArray(asset.derivedFrom) ? asset.derivedFrom : []) {
      const path = input?.libraryPath;
      if (!isSafeLibraryPath(path)) {
        return skip(`the collage's credits name an input that is not a library path: ${JSON.stringify(path ?? null)}`);
      }
      if (!inputs.includes(path)) inputs.push(path);
    }
  }
  if (inputs.length === 0) {
    return skip(`the collage's credits name no inputs (derivedFrom)`);
  }

  const root = resolve(basePath);
  for (const path of inputs) {
    const full = resolve(root, ...path.split('/'));
    if (full !== root && !full.startsWith(root + sep)) {
      return skip(`the collage's credits name an input outside the library: ${path}`);
    }
    let stats;
    try {
      stats = await fs.stat(full);
    } catch (error) {
      return skip(`an input the collage's credits name is missing or unreadable: ${path} (${error?.code ?? error?.message ?? error})`);
    }
    if (!stats.isFile()) return skip(`an input the collage's credits name is not a file: ${path}`);
  }

  return { mode: 'declared', inputs };
}

/**
 * Run the collage job once: the switch, then the inputs, then the script.
 * Both of app.mjs's triggers (the start-up run and the schedule) come here.
 *
 * @param {Object} opts
 * @param {string} opts.basePath - The library root (BASE_PATH)
 * @param {string} opts.scriptPath - scripts/generate_poster_collage.py
 * @param {Function} opts.runPython - lib/processRunner.mjs runPython
 * @param {Object} opts.logger - The collage job's logger
 * @param {NodeJS.ProcessEnv} [opts.env] - The environment the script gets (and the switch is read from)
 * @param {Object} [opts.runOptions] - Passed on to runPython (logFile, debug)
 * @param {{ fs?: typeof fsPromises }} [opts.deps]
 * @returns {Promise<'disabled'|'skipped'|'built'>}
 */
export async function runPosterCollage({ basePath, scriptPath, runPython, logger, env = process.env, runOptions = {}, deps = {} }) {
  if (!isPosterCollageEnabled(env)) {
    logger.debug?.(`Poster collage is turned off (POSTER_COLLAGE_ENABLED=${env.POSTER_COLLAGE_ENABLED}); ${POSTER_COLLAGE_FILE} is left as it is`);
    return 'disabled';
  }

  const selection = await collageInputs(basePath, deps);
  if (selection.mode === 'skip') {
    logger.error(`Poster collage not rebuilt: ${selection.reason}. The existing ${POSTER_COLLAGE_FILE} is kept.`);
    return 'skipped';
  }

  // Only the credits' inputs reach the script, and only when they decide; an
  // inherited value never does.
  const scriptEnv = { ...env };
  delete scriptEnv[POSTER_COLLAGE_INPUTS_ENV];
  if (selection.mode === 'declared') scriptEnv[POSTER_COLLAGE_INPUTS_ENV] = JSON.stringify(selection.inputs);
  logger.info(
    `Running generate_poster_collage.py: ${selection.mode === 'declared' ? `the ${selection.inputs.length} input(s) the library credits name` : 'every poster'}${runOptions.debug ? ' (debug)' : ''}`
  );

  await runPython({
    scriptPath,
    args: [],
    label: 'GeneratePosterCollage',
    logger,
    ...runOptions,
    env: scriptEnv,
  });
  return 'built';
}
