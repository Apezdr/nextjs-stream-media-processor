// lib/requestBodyParsers.mjs
//
// Which parser reads a request's JSON body, and when. app.mjs mounts
// createGlobalJsonParser() ahead of every route, and each media entries route
// with mountMediaEntriesRoute(). app.mjs cannot be loaded in a test, so the
// wiring lives here, where tests/unit/lib/request-body-parsers.test.mjs mounts
// it the same way.
//
// The global parser reads JSON bodies up to 30 MB (subtitle uploads need the
// room) on every path but these:
//
//   - /api/discord/events needs the raw, unparsed body (via its own
//     express.raw() middleware) to verify the Discord webhook signature.
//     Parsing it here first would make that raw parser a no-op and force a
//     lossy JSON.stringify() re-serialization fallback before verification.
//   - The media entries routes parse their own body after auth, with their own
//     limit (lib/mediaManifest.mjs). Routing ignores case and a trailing
//     slash, so this check does as well: no path Express routes to them is
//     parsed here.
//
// So an entries request is authenticated before a byte of its body is read,
// and a client without credentials cannot make the server buffer and parse a
// body.

import express from 'express';
import { createEntriesBodyParser, createEntriesHandler } from './mediaManifest.mjs';

/** The global JSON parser's body limit. */
export const GLOBAL_JSON_BODY_LIMIT = '30mb';

/** The kinds with an entries route. */
const MEDIA_ENTRIES_KINDS = ['tv', 'movies'];

const mediaEntriesPath = (kind) => `/media/${kind}/entries`;

const OWN_JSON_PARSER_PATHS = new Set(MEDIA_ENTRIES_KINDS.map(mediaEntriesPath));

/**
 * The JSON body parser for every route but those above. Mount it before the
 * routes.
 *
 * @returns {import('express').RequestHandler}
 */
export function createGlobalJsonParser() {
  const parseJson = express.json({ limit: GLOBAL_JSON_BODY_LIMIT });
  return function globalJsonParser(req, res, next) {
    if (req.path === '/api/discord/events') return next();
    if (OWN_JSON_PARSER_PATHS.has(req.path.toLowerCase().replace(/\/+$/, ''))) return next();
    return parseJson(req, res, next);
  };
}

/**
 * Mount POST /media/<kind>/entries: auth first, then the entries' own body
 * parser (ENTRIES_REQUEST_BODY_LIMIT), then the handler.
 *
 * @param {import('express').Express} app
 * @param {Object} options
 * @param {'tv'|'movies'} options.kind
 * @param {import('express').RequestHandler} options.authenticate
 * @param {import('./mediaPayloadCache.mjs').MediaPayloadCache} options.cache - Of the same kind
 * @param {Object} options.logger
 * @param {string} options.errorLabel - Log prefix for a failed build or stream
 */
export function mountMediaEntriesRoute(app, { kind, authenticate, cache, logger, errorLabel }) {
  if (!MEDIA_ENTRIES_KINDS.includes(kind)) {
    throw new Error(`no media entries route for kind ${JSON.stringify(kind)}`);
  }
  if (cache?.kind !== kind) {
    throw new Error(`the ${kind} entries route needs the ${kind} cache, not ${JSON.stringify(cache?.kind)}`);
  }
  if (typeof authenticate !== 'function') {
    throw new Error(`the ${kind} entries route needs an auth middleware`);
  }
  app.post(
    mediaEntriesPath(kind),
    authenticate,
    createEntriesBodyParser(),
    createEntriesHandler(cache, { logger, errorLabel })
  );
}
