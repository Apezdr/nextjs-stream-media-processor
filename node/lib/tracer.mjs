/**
 * OpenTelemetry tracer utility
 * 
 * Helper functions for creating and managing spans across the application
 * This provides a consistent API for instrumentation
 */

import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { isOpenTelemetryEnabled } from './telemetry.mjs';

// Get a tracer instance for the given module name
export function getTracer(moduleName) {
  // If OpenTelemetry is disabled, return a no-op tracer
  if (!isOpenTelemetryEnabled) {
    return createNoopTracer();
  }
  
  // Return a real tracer
  return trace.getTracer(moduleName);
}

// Helper to create spans with common patterns
export function createSpan(tracer, name, options = {}) {
  return tracer.startSpan(name, options);
}

// Helper to wrap async functions with span creation
export async function withSpan(tracer, name, fn, attributes = {}) {
  const span = tracer.startSpan(name, { attributes });
  
  try {
    const result = await fn();
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus({ 
      code: SpanStatusCode.ERROR, 
      message: error.message 
    });
    throw error;
  } finally {
    span.end();
  }
}

// Helper to wrap database operations with spans
export async function withDbSpan(tracer, operationName, fn, params = {}) {
  const span = tracer.startSpan(`db.operation.${operationName}`, {
    attributes: {
      'db.operation': operationName,
      ...params
    }
  });
  
  try {
    const result = await fn();
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus({ 
      code: SpanStatusCode.ERROR, 
      message: error.message 
    });
    throw error;
  } finally {
    span.end();
  }
}

// Helper to wrap HTTP client operations with spans
export async function withHttpSpan(tracer, name, fn, urlOrOptions) {
  const attributes = typeof urlOrOptions === 'string' 
    ? { 'http.url': urlOrOptions } 
    : { 
        'http.url': urlOrOptions.url,
        'http.method': urlOrOptions.method || 'GET',
        ...urlOrOptions.attributes
      };
  
  const span = tracer.startSpan(name, { attributes });
  
  try {
    const response = await fn();
    
    // Add response attributes
    span.setAttribute('http.status_code', response.status || 200);
    if (response.statusText) {
      span.setAttribute('http.status_text', response.statusText);
    }
    
    span.setStatus({ code: SpanStatusCode.OK });
    return response;
  } catch (error) {
    span.recordException(error);
    
    // Try to extract status code from error if available
    if (error.response && error.response.status) {
      span.setAttribute('http.status_code', error.response.status);
    }
    
    span.setStatus({ 
      code: SpanStatusCode.ERROR, 
      message: error.message 
    });
    throw error;
  } finally {
    span.end();
  }
}

// Create context for async operations
export function captureContext() {
  return context.active();
}

// Restore context for async operations
export function withContext(ctx, fn) {
  return context.with(ctx, fn);
}

// Create a no-op tracer for when OpenTelemetry is disabled
function createNoopTracer() {
  const noopSpan = {
    setAttribute: () => {},
    setAttributes: () => {},
    addEvent: () => {},
    setStatus: () => {},
    updateName: () => {},
    end: () => {},
    isRecording: () => false,
    recordException: () => {}
  };
  
  return {
    startSpan: () => noopSpan,
    startActiveSpan: (name, options, fn) => {
      if (typeof options === 'function') {
        fn = options;
      }
      try {
        return fn(noopSpan);
      } catch (e) {
        throw e;
      }
    }
  };
}