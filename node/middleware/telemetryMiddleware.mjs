/**
 * OpenTelemetry middleware for Express
 *
 * The HTTP instrumentation records each request itself: method, status, client
 * address and user agent on the span, and the standard
 * http.server.request.duration metric (seconds). These fill the two things it
 * can't see: which route matched, and a handler's error.
 */

import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';
import { isOpenTelemetryEnabled } from '../lib/telemetry.mjs';
import { createCategoryLogger } from '../lib/logger.mjs';

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
 * Express error handler middleware that records exceptions in the current span
 */
export function telemetryErrorMiddleware() {
  return (err, req, res, next) => {
    // Skip if OpenTelemetry is not enabled
    if (!isOpenTelemetryEnabled) {
      return next(err);
    }

    const span = trace.getSpan(context.active());

    if (span) {
      // The exception event carries the message and stack; error.type is the
      // standard attribute for what went wrong
      span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err.message || 'Unknown error',
      });
      span.setAttribute('error.type', err.name || 'Error');

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
