/**
 * OpenTelemetry middleware for Express
 *
 * The HTTP instrumentation records each request itself: method, status, client
 * address and user agent on the span, and the standard
 * http.server.request.duration metric (seconds). These fill the two things it
 * can't see: which route matched, and a handler's error.
 */

import { context, SpanStatusCode } from '@opentelemetry/api';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';
import { isOpenTelemetryEnabled } from '../lib/telemetry.mjs';
import { createCategoryLogger } from '../lib/logger.mjs';
import { requestSpan } from '../lib/requestCaller.mjs';

const logger = createCategoryLogger('telemetry');

/**
 * Hands the matched route to the HTTP instrumentation, which then names the
 * server span `GET /api/tmdb/comprehensive/:type` and puts http.route on it and
 * on http.server.request.duration. instrumentation-express would do this, but
 * it patches the `express` module, which this ESM app imports where its require
 * hook can't see; instrumentation-router (Express 5 loads `router` with
 * require) names its own spans and passes nothing on. The route is known once a
 * handler matched, so it's read as the response ends, before the HTTP
 * instrumentation finishes the span. An unmatched request (a 404) keeps the
 * method alone. Mount it first, on the app, so it sees every route.
 */
export function httpRouteMiddleware() {
  return (req, res, next) => {
    if (!isOpenTelemetryEnabled) return next();

    const rpcMetadata = getRPCMetadata(context.active());
    if (rpcMetadata?.type === RPCType.HTTP) {
      const end = res.end;
      res.end = function (...args) {
        if (req.route?.path) rpcMetadata.route = req.baseUrl + req.route.path;
        return end.apply(this, args);
      };
    }
    next();
  };
}

/**
 * Express error handler middleware that records exceptions on the request's
 * HTTP server span. The active span here is instrumentation-router's own span
 * for this error handler, which ends at next(err) and has no http.route.
 */
export function telemetryErrorMiddleware() {
  return (err, req, res, next) => {
    // Skip if OpenTelemetry is not enabled
    if (!isOpenTelemetryEnabled) {
      return next(err);
    }

    const span = requestSpan();

    if (span) {
      // The exception event carries the message, type and stack
      span.recordException(err);
      // The status the final handler (app.mjs) will send. A server span is an
      // error only for a 5xx: a 4xx (a malformed route parameter, a body too
      // large) is the client's, and HTTP semconv leaves it unset. On a 5xx the
      // HTTP instrumentation sets error.type to the status code itself.
      const status = Number.isInteger(err?.status) && err.status >= 100 && err.status <= 999 ? err.status : 500;
      if (status >= 500) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err.message || 'Unknown error',
        });
      }

      logger.error('Request error captured in telemetry', {
        error: err.message,
        path: req.path,
        method: req.method,
      });
    }

    // Continue with error handling
    next(err);
  };
}
