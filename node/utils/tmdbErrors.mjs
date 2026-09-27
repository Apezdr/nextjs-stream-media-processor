/**
 * TMDB error types and the one place that turns them into an HTTP answer.
 *
 * Kept apart from utils/tmdb.mjs so routes/tmdb.mjs can map errors without
 * importing the TMDB client — the route tests mock that module wholesale.
 */

/** Machine-readable `code` values sent beside `error` in a failed response. */
export const TMDB_ERROR_CODES = Object.freeze({
  NOT_FOUND: "TMDB_NOT_FOUND",
  RATE_LIMITED: "TMDB_RATE_LIMITED",
  UNAVAILABLE: "TMDB_UNAVAILABLE",
});

/**
 * A TMDB name search legitimately returned zero results — the title has no
 * match, as opposed to a network/HTTP/rate-limit failure (those are
 * TmdbRequestErrors). Lets MetadataGenerator classify the failure in its return
 * contract (`reason: 'no-match'` vs `'transient-error'`). Note the scanners
 * currently apply the same 24h cooldown to both reasons — the type exists so
 * the two cases stop being indistinguishable at the contract/log layer, not
 * because they are paced differently today.
 */
export class TmdbNoMatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "TmdbNoMatchError";
    this.code = "no-match";
    this.status = 404;
  }
}

/**
 * A TMDB HTTP call that failed for good: a non-retryable status, retries run
 * out, or a remembered 404. `status` is TMDB's own status, or null when no
 * response arrived (timeout, DNS, refused connection).
 */
export class TmdbRequestError extends Error {
  constructor(message, { endpoint, status = null, retryAfter = null, cached = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "TmdbRequestError";
    this.endpoint = endpoint;
    this.status = status;
    // Seconds TMDB asked us to wait (its Retry-After), on a 429 only.
    this.retryAfter = retryAfter;
    // True when the 404 came from the not-found cache, not from TMDB.
    this.cached = cached;
  }
}

/** The caller's parameters are missing or invalid; TMDB was never asked. */
export class TmdbInvalidRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "TmdbInvalidRequestError";
    this.status = 400;
  }
}

/**
 * Decide the HTTP answer for an error thrown by the TMDB client, so callers
 * can tell a title TMDB doesn't have (give up) from an outage (retry):
 *
 *   TMDB 404, or a name search with no match   → 404  TMDB_NOT_FOUND
 *   invalid parameters (ours, or TMDB 400/422) → 400  no code
 *   TMDB 429 after our retries                 → 429  TMDB_RATE_LIMITED + Retry-After
 *   any other TMDB failure: 5xx, timeout,      → 502  TMDB_UNAVAILABLE
 *     network, or 401/403 (our key)
 *   anything else — a bug in this server       → 500  no code
 *
 * @returns {{ status: number, code?: string, retryAfter?: number }}
 */
export function classifyTmdbError(error) {
  if (error instanceof TmdbInvalidRequestError) {
    return { status: 400 };
  }
  if (error instanceof TmdbNoMatchError) {
    return { status: 404, code: TMDB_ERROR_CODES.NOT_FOUND };
  }
  if (error instanceof TmdbRequestError) {
    switch (error.status) {
      case 404:
        return { status: 404, code: TMDB_ERROR_CODES.NOT_FOUND };
      case 429:
        return { status: 429, code: TMDB_ERROR_CODES.RATE_LIMITED, retryAfter: error.retryAfter ?? 1 };
      case 400:
      case 422:
        return { status: 400 };
      default:
        return { status: 502, code: TMDB_ERROR_CODES.UNAVAILABLE };
    }
  }
  return { status: 500 };
}
