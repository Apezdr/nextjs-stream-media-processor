/**
 * How app.mjs wires request bodies, read off its source.
 *
 * app.mjs cannot be loaded in a test, so the wiring lives in
 * lib/requestBodyParsers.mjs, and tests/unit/lib/request-body-parsers.test.mjs
 * checks it mounted as app.mjs mounts it. This checks that app.mjs does mount
 * it that way, and nothing around it:
 *
 *   - nothing reads a body ahead of app.use(createGlobalJsonParser()): no
 *     express.json/urlencoded/raw/text or bodyParser call before it, but a
 *     Discord events route's express.raw(). A parser there would read the
 *     entries bodies before auth, and the Discord body before its signature;
 *   - the media entries routes are mounted only through
 *     mountMediaEntriesRoute (auth, then their own parser), once per kind,
 *     never by an inline app.post() on their path.
 *
 * Comment lines are not code, so they are left out of the scan.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_SOURCE = readFileSync(join(NODE_DIR, 'app.mjs'), 'utf8');

const GLOBAL_PARSER_MOUNT = 'app.use(createGlobalJsonParser())';

// A call that reads a request body.
const BODY_PARSER_CALL = /\bexpress\s*\.\s*(?:json|urlencoded|raw|text)\s*\(|\bbodyParser(?:\s*\.\s*\w+)?\s*\(/g;

// A route or middleware registered with an entries path written inline (any
// case, as Express routes it).
const INLINE_ENTRIES_ROUTE =
  /\b(?:app|router)\s*\.\s*(?:post|all|use|put|patch|get|route)\s*\(\s*["'`]\/media\/(?:tv|movies)\/entries/gi;

// mountMediaEntriesRoute(app, { kind: '<kind>', ...
const ENTRIES_MOUNT = /\bmountMediaEntriesRoute\s*\(\s*app\s*,\s*\{\s*kind\s*:\s*["'](\w+)["']/g;

/**
 * The source with comment lines blanked: `//` lines and blocks opened at the
 * start of a line. Offsets and line numbers stay as they were.
 */
function codeOf(source) {
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  return source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
}

function lineAt(code, index) {
  const start = code.lastIndexOf('\n', index - 1) + 1;
  const end = code.indexOf('\n', index);
  return {
    line: code.slice(0, index).split('\n').length,
    text: code.slice(start, end < 0 ? undefined : end).trim(),
  };
}

/** Body-parser calls ahead of the global parser's mount, but the Discord raw route's. */
function bodyParsersAhead(source) {
  const code = codeOf(source);
  const mount = code.indexOf(GLOBAL_PARSER_MOUNT);
  if (mount < 0) return [{ line: 0, text: `${GLOBAL_PARSER_MOUNT} not found` }];
  return [...code.matchAll(BODY_PARSER_CALL)]
    .filter((match) => match.index < mount)
    .map((match) => ({ ...lineAt(code, match.index), call: match[0] }))
    .filter(({ call, text }) => !(/^express\s*\.\s*raw/.test(call) && text.includes('/discord/events')))
    .map(({ line, text }) => ({ line, text }));
}

/** Routes registered on an entries path written inline. */
function inlineEntriesRoutes(source) {
  const code = codeOf(source);
  return [...code.matchAll(INLINE_ENTRIES_ROUTE)].map((match) => lineAt(code, match.index));
}

/** The kinds mountMediaEntriesRoute is called with, in order. */
function entriesMounts(source) {
  return [...codeOf(source).matchAll(ENTRIES_MOUNT)].map((match) => match[1]);
}

describe('app.mjs request-body wiring', () => {
  it('mounts the global JSON parser once', () => {
    expect(codeOf(APP_SOURCE).split(GLOBAL_PARSER_MOUNT)).toHaveLength(2);
  });

  it('reads no body ahead of the global JSON parser, but on a Discord events route', () => {
    expect(bodyParsersAhead(APP_SOURCE)).toEqual([]);
  });

  it('mounts both entries routes through mountMediaEntriesRoute only', () => {
    expect(inlineEntriesRoutes(APP_SOURCE)).toEqual([]);
    expect(entriesMounts(APP_SOURCE).sort()).toEqual(['movies', 'tv']);
  });

  it('recognizes the forms it is looking for, and nothing else', () => {
    const mount = 'app.use(createGlobalJsonParser());';
    for (const ahead of [
      'app.use(express.json());',
      'app.use(express.urlencoded({ extended: true }));',
      'app.use(express.text());',
      'app.use(express.raw({ type: "*/*" }));',
      'app.post("/upload", express . json({ limit: "1mb" }), handler);',
      'app.use(bodyParser.json());',
      'app.use(bodyParser());',
    ]) {
      const flagged = bodyParsersAhead(`app.use(cors());\n${ahead}\n${mount}\n`);
      expect({ ahead, flagged }).toEqual({ ahead, flagged: [{ line: 2, text: ahead }] });
    }
    for (const fine of [
      'app.post("/api/discord/events", express.raw({ type: "application/json" }), handler);',
      '// app.use(express.json()) would read the entries bodies before auth',
      '/**\n * express.json() is mounted below.\n */',
      'import bodyParser from "body-parser";',
    ]) {
      expect({ fine, flagged: bodyParsersAhead(`${fine}\n${mount}\n`) }).toEqual({ fine, flagged: [] });
    }
    // After the global parser, a route may parse its own body.
    expect(bodyParsersAhead(`${mount}\napp.post("/x", express.json(), handler);\n`)).toEqual([]);
    // Without the global parser there is nothing to be ahead of: that is a failure.
    expect(bodyParsersAhead('app.use(express.json());\n')).toEqual([
      { line: 0, text: `${GLOBAL_PARSER_MOUNT} not found` },
    ]);

    for (const inline of [
      'app.post("/media/tv/entries", authenticateWebhookOrUser, handler);',
      "app.post(\n  '/media/movies/entries',\n  handler\n);",
      'app.all(`/MEDIA/TV/ENTRIES/`, handler);',
      'app.use("/media/movies/entries", handler);',
      'router.post("/media/tv/entries", handler);',
    ]) {
      expect({ inline, found: inlineEntriesRoutes(inline).length }).toEqual({ inline, found: 1 });
    }
    for (const fine of [
      'app.post("/media/scan", authenticateWebhookOrUser, handler);',
      'app.get("/media/tv/manifest", authenticateWebhookOrUser, handler);',
      "'/media/movies/entries, /media/tv/entries - POST {titles} or {all}: chosen entries as NDJSON',",
      '// app.post("/media/tv/entries", ...) would skip mountMediaEntriesRoute',
      "mountMediaEntriesRoute(app, { kind: 'tv', authenticate, cache, logger, errorLabel });",
    ]) {
      expect({ fine, found: inlineEntriesRoutes(fine).length }).toEqual({ fine, found: 0 });
    }
  });
});
