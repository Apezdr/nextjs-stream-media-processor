/**
 * OpenTelemetry metrics utility
 * 
 * Helper functions for creating and managing metrics across the application
 */

import { metrics } from '@opentelemetry/api';
import { isOpenTelemetryEnabled } from './telemetry.mjs';

// Get a meter instance for the given module name
export function getMeter(moduleName) {
  if (!isOpenTelemetryEnabled) {
    return createNoopMeter();
  }
  
  return metrics.getMeter(moduleName);
}

// Create a counter metric
export function createCounter(meter, name, options = {}) {
  if (!isOpenTelemetryEnabled) {
    return createNoopCounter();
  }
  
  const counter = meter.createCounter(name, {
    description: options.description || `Counter for ${name}`,
    unit: options.unit || '1',
  });
  
  return counter;
}

// Create a histogram metric
export function createHistogram(meter, name, options = {}) {
  if (!isOpenTelemetryEnabled) {
    return createNoopHistogram();
  }
  
  return meter.createHistogram(name, {
    description: options.description || `Histogram for ${name}`,
    unit: options.unit || 'ms',
  });
}

// Create an observable gauge metric
export function createObservableGauge(meter, name, options = {}, callback) {
  if (!isOpenTelemetryEnabled) {
    return createNoopGauge();
  }
  
  const gauge = meter.createObservableGauge(name, {
    description: options.description || `Gauge for ${name}`,
    unit: options.unit || '1',
  });
  
  if (callback) {
    gauge.addCallback(callback);
  }
  
  return gauge;
}

// Record HTTP request duration
export function recordHttpRequestDuration(histogram, startTime, attributes = {}) {
  if (!isOpenTelemetryEnabled) {
    return;
  }
  
  const duration = Date.now() - startTime;
  histogram.record(duration, attributes);
}

// Create a no-op meter for when OpenTelemetry is disabled
function createNoopMeter() {
  return {
    createCounter: () => createNoopCounter(),
    createHistogram: () => createNoopHistogram(),
    createObservableGauge: () => createNoopGauge(),
  };
}

// Create a no-op counter
function createNoopCounter() {
  return {
    add: () => {},
  };
}

// Create a no-op histogram
function createNoopHistogram() {
  return {
    record: () => {},
  };
}

// Create a no-op gauge
function createNoopGauge() {
  return {
    addCallback: () => {},
  };
}