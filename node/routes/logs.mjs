/**
 * GET /api/logs: the processor's own log, for the admin Logs page.
 *
 * Admin only (a webhook ID or an admin session): the log names titles, paths
 * and internal URLs. It used to answer anyone, browser CORS aside. The page
 * reaches it through the frontend's /api/authenticated/admin/logs proxy, never
 * from the browser, so it sets no CORS headers.
 *
 * Query, all optional:
 *   limit     1-2000, default 500
 *   category  one category, exactly
 *   level     the least severe level kept (`warn` = errors and warnings)
 *   q         case-insensitive text in the category, message or fields
 *   before    a cursor from `older`: the page before it
 *   after     a cursor from `newer`: everything since (the live view)
 * Answers { entries, older, newer, reset, truncated, scannedFrom, categories };
 * lib/logReader.mjs says what each means.
 */

import express from 'express';
import { authenticateWebhookOrUser } from '../middleware/auth.mjs';
import { createCategoryLogger, getCategories, LOG_DIRECTORY } from '../lib/logger.mjs';
import { createLogFilter, LOG_LEVELS, parseCursor, readLogs } from '../lib/logReader.mjs';

const logger = createCategoryLogger('logs-route');

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const MAX_TEXT_LENGTH = 200;
// About 24 MB of log at the transport's 4 MB cap; an older-going read that
// needs more is cut short with an `older` cursor to carry on from.
const MAX_FILES_PER_READ = 6;

class QueryError extends Error {}

function readQuery(query) {
  const text = (name) => {
    const value = query[name];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') throw new QueryError(`${name} must be given once, as text`);
    if (value.length > MAX_TEXT_LENGTH) throw new QueryError(`${name} is longer than ${MAX_TEXT_LENGTH} characters`);
    return value;
  };
  const cursor = (name) => {
    const value = text(name);
    if (value === undefined) return null;
    const parsed = parseCursor(value);
    if (!parsed) throw new QueryError(`${name} is not a log cursor`);
    return parsed;
  };

  const limitText = text('limit');
  const limit = limitText === undefined ? DEFAULT_LIMIT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new QueryError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }

  const level = text('level');
  if (level !== undefined && !LOG_LEVELS.includes(level)) {
    throw new QueryError(`level must be one of ${LOG_LEVELS.join(', ')}`);
  }

  const before = cursor('before');
  const after = cursor('after');
  if (before && after) throw new QueryError('before and after cannot be used together');

  const q = text('q')?.trim();
  return {
    limit,
    before,
    after,
    filter: createLogFilter({ category: text('category'), level, q: q || undefined }),
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.logDirectory] where the log files are (tests point it elsewhere)
 */
export function setupLogsRoutes({ logDirectory = LOG_DIRECTORY } = {}) {
  const router = express.Router();

  router.get('/logs', authenticateWebhookOrUser, async (req, res) => {
    let query;
    try {
      query = readQuery(req.query);
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      return res.status(400).json({ error: error.message });
    }

    try {
      const result = await readLogs(logDirectory, { ...query, maxFiles: MAX_FILES_PER_READ });
      res.set('Cache-Control', 'no-store');
      res.json({ ...result, categories: getCategories().sort() });
    } catch (error) {
      logger.error('Reading the log files failed', error);
      res.status(500).json({ error: 'Failed to read the log files' });
    }
  });

  return router;
}
