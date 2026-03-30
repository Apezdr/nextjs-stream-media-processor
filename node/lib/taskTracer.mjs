/**
 * OpenTelemetry tracing for task queue operations
 *
 * This module provides specialized tracing functions for the task manager
 * with context propagation across asynchronous task execution.
 */

import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { getTracer, captureContext, withContext } from './tracer.mjs';
import { getMeter, createHistogram, createCounter, createObservableGauge } from './metrics.mjs';
import { isOpenTelemetryEnabled } from './telemetry.mjs';

// Create task-specific tracer and metrics
const tracer = getTracer('task-manager');
const meter = getMeter('task-manager');

// Metrics for task operations
const taskDurationHistogram = createHistogram(meter, 'task.duration', {
  description: 'Task execution duration',
  unit: 'ms'
});

const taskCounter = createCounter(meter, 'task.count', {
  description: 'Task count by type and status',
  unit: '1'
});

const taskErrorCounter = createCounter(meter, 'task.errors', {
  description: 'Task error count by type',
  unit: '1'
});

// Create observable metrics for task queue depth
const taskQueueGauge = meter.createObservableGauge('task.queue_depth', {
  description: 'Task queue depth by type',
  unit: '1'
});

// Utility for human-readable task type names
const taskTypeNames = new Map();

/**
 * Register task types for better metric and span labeling
 * 
 * @param {Object} taskTypes - Enum object of task types
 */
export function registerTaskTypes(taskTypes) {
  Object.entries(taskTypes).forEach(([name, value]) => {
    taskTypeNames.set(value, name);
  });
}

/**
 * Register task queue metrics for observability
 * 
 * @param {Function} getQueueDepths - Function that returns current queue depths by type 
 */
export function registerTaskQueueMetrics(getQueueDepths) {
  if (!isOpenTelemetryEnabled) return;
  
  taskQueueGauge.addCallback((observableResult) => {
    const queueDepths = getQueueDepths();
    
    for (const [type, depth] of Object.entries(queueDepths)) {
      const typeName = taskTypeNames.get(Number(type)) || `type-${type}`;
      
      observableResult.observe(depth, {
        'task.type': typeName,
        'task.priority': type
      });
    }
  });
}

/**
 * Create a span for task enqueuing operations
 * 
 * @param {Object} options Task options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withTaskEnqueueSpan(options, fn) {
  if (!isOpenTelemetryEnabled) return fn();
  
  const typeName = taskTypeNames.get(options.type) || `type-${options.type}`;
  
  const attributes = {
    'task.type': typeName,
    'task.name': options.name || 'unknown',
    'task.priority': options.type,
    'task.immediate': options.immediate ? true : false,
    'task.queue_depth': options.queueDepth || 0
  };
  
  try {
    // Create a span for the enqueue operation
    const span = tracer.startSpan(`task.enqueue.${typeName}`, { attributes });
    
    // Increment the task counter
    taskCounter.add(1, {
      'task.type': typeName,
      'task.operation': 'enqueue'
    });
    
    try {
      // Execute the task enqueue operation
      const result = await fn();
      
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      
      return result;
    } catch (error) {
      // Record the error and end the span
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message
      });
      span.end();
      
      throw error;
    }
  } catch (error) {
    // If tracing itself fails, just run the operation
    return fn();
  }
}

/**
 * Create a span for task execution
 * 
 * @param {Object} options Task options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withTaskExecuteSpan(options, fn) {
  if (!isOpenTelemetryEnabled) return fn();
  
  const typeName = taskTypeNames.get(options.type) || `type-${options.type}`;
  
  const attributes = {
    'task.type': typeName,
    'task.name': options.name || 'unknown', 
    'task.priority': options.type,
    'task.id': options.id || 'unknown',
    'task.state': 'running'
  };
  
  // Capture timing information
  const startTime = Date.now();
  
  try {
    // Create a span for the execute operation
    const span = tracer.startSpan(`task.execute.${typeName}`, { attributes });
    
    // Increment the task counter
    taskCounter.add(1, {
      'task.type': typeName,
      'task.operation': 'execute'
    });
    
    try {
      // Save current context to propagate across async function
      const activeContext = context.active();
      
      // Execute the task with context propagation
      const result = await withContext(activeContext, async () => {
        return await fn();
      });
      
      // Record the successful execution
      const duration = Date.now() - startTime;
      span.setAttribute('task.duration_ms', duration);
      span.setAttribute('task.state', 'completed');
      span.setStatus({ code: SpanStatusCode.OK });
      
      // Record task duration metric
      taskDurationHistogram.record(duration, {
        'task.type': typeName,
        'task.success': 'true'
      });
      
      // Increment completed counter
      taskCounter.add(1, {
        'task.type': typeName,
        'task.operation': 'complete',
        'task.success': 'true'
      });
      
      span.end();
      return result;
    } catch (error) {
      // Record the error and end the span
      const duration = Date.now() - startTime;
      span.setAttribute('task.duration_ms', duration);
      span.setAttribute('task.state', 'failed');
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message
      });
      
      // Record error metrics
      taskErrorCounter.add(1, {
        'task.type': typeName,
        'error.type': error.name || 'Error'
      });
      
      // Record task duration for failed tasks
      taskDurationHistogram.record(duration, {
        'task.type': typeName,
        'task.success': 'false'
      });
      
      // Increment failed counter
      taskCounter.add(1, {
        'task.type': typeName,
        'task.operation': 'complete',
        'task.success': 'false'
      });
      
      span.end();
      throw error;
    }
  } catch (error) {
    // If tracing itself fails, just run the operation
    return fn();
  }
}