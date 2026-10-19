/**
 * The routes P2 and P3 removed stay removed, read off the source.
 *
 * Every one of them had no caller in the frontend, the TV app or the
 * transcoder, and no request in prod for 30 days (the per-season hash route:
 * none in 7 days, the previous frontend release before that). app.mjs cannot
 * be loaded in a test (see app-request-body-wiring.test.mjs), so this scans
 * each file's registrations instead: `app.<method>('<path>'` and
 * `router.<method>('<path>'`, comment lines left out.
 *
 * Each file also lists the routes that must still be there, which keeps the
 * scan honest (a pattern that matched nothing would pass the absence checks).
 * The kept ones include the routes P2 was told to keep (POST /media/scan, the
 * metadata-hash list) and the one it kept because it still has a caller in
 * this repo: the Discord bot's ServerApiClient calls /api/tasks (its /tasks
 * command). P3 removed POST /api/trigger-system-status: its one caller,
 * ServerApiClient.triggerStatusCheck(), ran only from getSystemStatus(true),
 * which nothing called with true.
 */

import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The source with comment lines blanked (as in app-request-body-wiring.test.mjs). */
function codeOf(source) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  return source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
}

const REGISTRATION = /\b(?:app|router)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(["'`])([^"'`]+)\2/g;

/** Every `METHOD path` a file registers. */
function registeredRoutes(file) {
  const code = codeOf(readFileSync(join(NODE_DIR, file), 'utf8'));
  return [...code.matchAll(REGISTRATION)].map((match) => `${match[1].toUpperCase()} ${match[3]}`);
}

const FILES = {
  'app.mjs': {
    removed: [
      'GET /processes/:fileKey',
      'GET /chapters/movie/:movieName',
      'GET /chapters/tv/:showName',
      'GET /chapters/tv/:showName/:season/:episode',
      'GET /rescan/tmdb',
    ],
    kept: ['GET /processes', 'POST /media/scan', 'GET /media/tv', 'GET /media/movies', 'GET /api/logs'],
  },
  'routes/metadataHashes.mjs': {
    removed: [
      'GET /metadata-hashes/:mediaType/:title',
      'GET /metadata-hashes/:mediaType/:title/:seasonNumber',
    ],
    kept: ['GET /metadata-hashes/:mediaType'],
  },
  'routes/systemStatus.mjs': {
    removed: ['GET /health', 'POST /trigger-system-status'],
    kept: ['GET /system-status', 'GET /tasks'],
  },
  'routes/admin.mjs': {
    removed: [
      'POST /metadata/show',
      'POST /metadata/movie',
      'POST /metadata/bulk',
      'GET /metadata/test',
      'GET /session-cache/stats',
      'POST /session-cache/clear',
    ],
    kept: ['POST /subtitles/save', 'GET /metadata/config', 'PUT /metadata/config'],
  },
  'routes/tmdb.mjs': {
    removed: [
      'GET /cast/:type',
      'GET /structured-cast/:type',
      'GET /videos/:type',
      'GET /rating/:type',
      'GET /episode',
      'GET /search/collection',
      'GET /collection/images',
      'GET /status',
      'GET /cache/stats',
      'DELETE /cache',
      'DELETE /cache/expired',
      'POST /cache/refresh',
    ],
    kept: [
      'GET /search/:type',
      'GET /comprehensive/:type',
      'GET /details/:type',
      'GET /images/:type',
      'GET /episode/images',
      'GET /collection',
      'GET /health',
    ],
  },
};

describe('routes removed in P2 and P3', () => {
  describe.each(Object.entries(FILES))('%s', (file, { removed, kept }) => {
    const routes = registeredRoutes(file);

    it('registers none of the removed routes', () => {
      expect(routes.filter((route) => removed.includes(route))).toEqual([]);
    });

    it('still registers the routes it keeps', () => {
      expect(kept.filter((route) => !routes.includes(route))).toEqual([]);
    });
  });

  it('the Discord bot no longer calls the trigger route, and the unused discord index is gone', () => {
    const client = codeOf(readFileSync(join(NODE_DIR, 'integrations', 'discord', 'utils', 'serverApi.mjs'), 'utf8'));
    expect(/trigger-system-status|triggerStatusCheck/.test(client)).toBe(false);
    expect(existsSync(join(NODE_DIR, 'integrations', 'discord', 'index.mjs'))).toBe(false);
  });

  it('the blurhash-hash modules are gone and nothing mounts them', () => {
    expect(existsSync(join(NODE_DIR, 'routes', 'blurhash.mjs'))).toBe(false);
    expect(existsSync(join(NODE_DIR, 'sqlite', 'blurhashHashes.mjs'))).toBe(false);
    for (const file of ['app.mjs', 'routes/index.mjs']) {
      const code = codeOf(readFileSync(join(NODE_DIR, file), 'utf8'));
      expect({ file, imports: /blurhashHashes\.mjs|\.\/blurhash\.mjs|setupBlurhashRoutes/.test(code) }).toEqual({
        file,
        imports: false,
      });
    }
  });
});
