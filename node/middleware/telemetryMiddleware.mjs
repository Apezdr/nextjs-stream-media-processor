/**
 * OpenTelemetry middleware for Express
 * 
 * Adds custom attributes to auto-instrumented Express spans and collects metrics
 */

import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { getMeter, createHistogram } from '../lib/metrics.mjs';
import { isOpenTelemetryEnabled } from '../lib/telemetry.mjs';
import { createCategoryLogger } from '../lib/logger.mjs';

const logger = createCategoryLogger('telemetry');
const meter = getMeter('express-middleware');

// Create metrics
const httpRequestDurationHistogram = createHistogram(meter, 'http.server.request.duration', {
  description: 'HTTP server request duration',
  unit: 'ms'
});

const httpResponseSizeHistogram = createHistogram(meter, 'http.server.response.size', {
  description: 'HTTP server response size',
  unit: 'bytes'
});

/**
 * Express middleware that enhances the current active span with additional attributes
 */
export function telemetryMiddleware() {
  return (req, res, next) => {
    // Skip if OpenTelemetry is not enabled
    if (!isOpenTelemetryEnabled) {
      return next();
    }

    const startTime = Date.now();
    const requestUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    
    // Get current active span (created by auto-instrumentation)
    const span = trace.getSpan(context.active());
    
    if (span) {
      // Add custom attributes to the current span
      span.setAttributes({
        'http.request_id': req.id || crypto.randomUUID(),
        'http.route': req.route?.path || 'unknown',
        'http.client_ip': req.ip,
        'http.user_agent': req.get('user-agent') || 'unknown',
        'http.referer': req.get('referer') || 'unknown',
        'http.full_url': requestUrl,
        'http.content_length': parseInt(req.get('content-length') || '0', 10),
        'http.content_type': req.get('content-type') || 'unknown',
        'http.accept': req.get('accept') || 'unknown',
        'http.session_id': req.sessionID || 'unknown',
        'service.method': `${req.method} ${req.path}`
      });
      
      // Add user context if available
      if (req.user) {
        span.setAttribute('user.id', req.user.id || 'anonymous');
      }
    }
    
    // Capture response size and duration
    const originalEnd = res.end;
    
    res.end = function(...args) {
      const responseTime = Date.now() - startTime;
      const contentLength = parseInt(res.get('content-length') || '0', 10);
      
      // Record metrics
      httpRequestDurationHistogram.record(responseTime, {
        'http.method': req.method,
        'http.status_code': res.statusCode.toString(),
        'http.route': req.route?.path || req.path,
      });
      
      httpResponseSizeHistogram.record(contentLength, {
        'http.method': req.method,
        'http.status_code': res.statusCode.toString(),
        'http?.route': req.route?.path || req.path,
      });
      
      // Update span with response info (only if span is still recording)
      if (span && span.isRecording()) {
        span.setAttributes({
          'http.response_time_ms': responseTime,
          'http.response_size': contentLength,
          'http.status_class': Math.floor(res.statusCode / 100) * 100
        });
        
        // Mark error spans
        if (res.statusCode >= 400) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${res.statusCode} returned`
          });
          
          // For server errors, add more context
          if (res.statusCode >= 500) {
            span.setAttribute('error', true);
            span.setAttribute('error.type', 'ServerError');
          }
        } else {
          span.setStatus({
            code: SpanStatusCode.OK
          });
        }
      }
      
      // Call original end method
      return originalEnd.apply(this, args);
    };
    
    // Continue with request handling
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

    // Get current active span
    const span = trace.getSpan(context.active());
    
    if (span) {
      // Record the exception in the span
      span.recordException(err);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err.message || 'Unknown error'
      });
      span.setAttributes({
        'error': true,
        'error.type': err.name || 'Error',
        'error.message': err.message || 'Unknown error',
        'error.stack': err.stack || 'No stack trace'
      });
      
      logger.error('Request error captured in telemetry', { 
        error: err.message, 
        path: req.path,
        method: req.method
      });
    }
    
    // Continue with error handling
    next(err);
  };
}