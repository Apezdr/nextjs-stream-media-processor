/**
 * OpenTelemetry tracing for worker pool operations
 *
 * This module provides specialized tracing functions for worker pool operations
 * with context propagation across worker threads.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import { getTracer, withSpan, captureContext, withContext } from './tracer.mjs';
import { getMeter, createHistogram, createCounter } from './metrics.mjs';

// Create worker-specific tracer and metrics
const tracer = getTracer('worker-pool');
const meter = getMeter('worker-pool');

// Metrics for worker pool operations
const workerTaskDuration = createHistogram(meter, 'worker.task.duration', {
  description: 'Worker task execution duration',
  unit: 'ms'
});

const workerTaskCounter = createCounter(meter, 'worker.task.count', {
  description: 'Worker task count',
  unit: '1'
});

const workerErrorCounter = createCounter(meter, 'worker.task.errors', {
  description: 'Worker task error count',
  unit: '1'
});

/**
 * Creates a span for worker task execution with appropriate attributes
 * 
 * @param {Object} options Worker task options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withWorkerSpan(options, fn) {
  const attributes = {
    'worker.type': options.type || 'generic',
    'worker.operation': options.operation || 'execute',
    'worker.pool_name': options.poolName || 'unknown',
    'worker.thread_id': options.threadId || 'unknown',
  };
  
  // Add additional attributes if available
  if (options.queueSize !== undefined) attributes['worker.queue_size'] = options.queueSize;
  if (options.utilization !== undefined) attributes['worker.pool_utilization'] = options.utilization;
  if (options.taskId) attributes['worker.task_id'] = options.taskId;
  
  // Create parent context for propagation to worker
  const parentContext = captureContext();
  const startTime = Date.now();
  
  try {
    // Add "queued" attribute initially
    attributes['worker.state'] = 'queued';
    
    // Execute the worker task within a span
    const result = await withSpan(tracer, 'worker.task', async (span) => {
      // Update the span with initial attributes
      span.setAttributes(attributes);
      
      // Execute the actual worker task
      const taskResult = await fn();
      
      // Update the span with "completed" state
      span.setAttribute('worker.state', 'completed');
      
      // Record metrics
      workerTaskCounter.add(1, {
        'worker.type': options.type || 'generic',
        'worker.operation': options.operation || 'execute',
        'worker.success': 'true'
      });
      
      return taskResult;
    }, attributes);
    
    // Record duration metric
    const duration = Date.now() - startTime;
    workerTaskDuration.record(duration, {
      'worker.type': options.type || 'generic',
      'worker.operation': options.operation || 'execute'
    });
    
    return result;
  } catch (error) {
    // Record error metrics
    workerErrorCounter.add(1, {
      'worker.type': options.type || 'generic',
      'worker.operation': options.operation || 'execute',
      'error.type': error.name || 'Error'
    });
    
    // Record failed task duration
    const duration = Date.now() - startTime;
    workerTaskDuration.record(duration, {
      'worker.type': options.type || 'generic',
      'worker.operation': options.operation || 'execute',
      'worker.success': 'false'
    });
    
    throw error;
  }
}

/**
 * Creates a span for worker pool initialization
 *
 * @param {Object} options Worker pool options
 * @param {Function} fn Function to execute within the span
 * @returns {any} Result of the function execution (synchronous for pool init)
 */
export function withPoolInitSpan(options, fn) {
  const attributes = {
    'worker.pool_name': options.name || 'unknown',
    'worker.min_threads': options.minThreads || 0,
    'worker.max_threads': options.maxThreads || 0,
    'worker.filename': options.filename || 'unknown'
  };
  
  // For synchronous initialization, we need to handle this without async/await
  const span = tracer.startSpan('worker.pool.initialize', { attributes });
  
  try {
    const result = fn();
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();
    throw error;
  }
}

/**
 * Creates a span for worker pool shutdown
 * 
 * @param {Object} options Worker pool options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withPoolShutdownSpan(options, fn) {
  const attributes = {
    'worker.pool_name': options.name || 'unknown',
    'worker.active_threads': options.activeThreads || 0,
    'worker.completed_tasks': options.completedTasks || 0
  };
  
  return withSpan(tracer, 'worker.pool.shutdown', fn, attributes);
}

/**
 * Creates a serializable context carrier for propagating 
 * trace context across worker boundaries
 * 
 * @returns {Object} Context carrier object that can be passed to worker
 */
export function createContextCarrier() {
  const parentContext = captureContext();
  
  // In a real implementation, we would extract the traceparent and tracestate
  // from the context and create a serializable carrier.
  // This is a simplified version that just captures the current timestamp.
  return {
    timestamp: Date.now(),
    // In a more complete implementation, we would include:
    // traceparent: '00-traceid-spanid-flags',
    // tracestate: 'vendor=value'
  };
}

/**
 * Restore context from a context carrier in the worker thread
 * 
 * @param {Object} carrier Context carrier received from the parent thread
 * @param {Function} fn Function to execute within the restored context
 * @returns {Promise<any>} Result of the function execution
 */
export async function withRestoredContext(carrier, fn) {
  // In a real implementation, we would extract the traceparent and tracestate
  // from the carrier and create a new context.
  // This is a simplified version that just logs the timestamp.
  console.log(`Worker received context from parent thread (timestamp: ${carrier?.timestamp || 'none'})`);
  
  // Execute the function (in a real implementation, we would wrap this
  // in a context.with() call with the restored context)
  return fn();
}

/**
 * Export worker metrics for direct observability
 * 
 * @param {Object} pool Piscina worker pool
 * @returns {Function} Function to register metrics with meter
 */
export function registerWorkerPoolMetrics(pool, poolName = 'blurhash') {
  return (observableResult) => {
    // Record queue depth
    observableResult.observe(pool.queueSize, {
      'worker.pool_name': poolName,
      'metric.name': 'queue_size'
    });
    
    // Record thread count
    observableResult.observe(pool.threads?.length || 0, {
      'worker.pool_name': poolName,
      'metric.name': 'active_threads'
    });
    
    // Record utilization
    observableResult.observe(pool.utilization || 0, {
      'worker.pool_name': poolName,
      'metric.name': 'utilization'
    });
  };
}