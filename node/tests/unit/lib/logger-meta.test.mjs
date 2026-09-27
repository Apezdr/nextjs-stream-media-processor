/**
 * normalizeLogMeta (lib/logger.mjs): the category logger's second argument
 * becomes readable record fields. Spreading it raw dropped an Error's message
 * and stack (non-enumerable) and split a string into one field per character.
 */

import { describe, it, expect } from '@jest/globals';
import { normalizeLogMeta } from '../../../lib/logger.mjs';

describe('normalizeLogMeta', () => {
  it('turns an Error into its message, stack and status', () => {
    const err = Object.assign(new Error('TMDB API request failed: Request failed with status code 404'), {
      status: 404,
    });

    expect(normalizeLogMeta(err)).toEqual({
      error: 'TMDB API request failed: Request failed with status code 404',
      stack: err.stack,
      status: 404,
    });
  });

  it('reads an axios-style response status and omits a missing one', () => {
    const axiosErr = Object.assign(new Error('boom'), { response: { status: 503 } });
    expect(normalizeLogMeta(axiosErr).status).toBe(503);

    expect(normalizeLogMeta(new Error('plain'))).not.toHaveProperty('status');
  });

  it('keeps a string whole under `detail`', () => {
    expect(normalizeLogMeta('Request failed with status code 404')).toEqual({
      detail: 'Request failed with status code 404',
    });
  });

  it('passes an object through unchanged and treats a missing meta as empty', () => {
    const meta = { endpoint: '/tv/275188', status: 404 };
    expect(normalizeLogMeta(meta)).toBe(meta);
    expect(normalizeLogMeta(undefined)).toEqual({});
    expect(normalizeLogMeta(null)).toEqual({});
  });
});
