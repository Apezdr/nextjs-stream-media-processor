/**
 * OpenTelemetry tracing for video processing operations
 *
 * This module provides specialized tracing functions for video transcoding,
 * clip generation, and FFmpeg operations with relevant attributes.
 */

import { getTracer, withSpan } from '../lib/tracer.mjs';
import { getMeter, createHistogram } from '../lib/metrics.mjs';

// Create video-specific tracer and metrics
const tracer = getTracer('video-processor');
const meter = getMeter('video-processor');

// Metrics for video processing
const videoTranscodeDuration = createHistogram(meter, 'video.transcode.duration', {
  description: 'Video transcoding duration',
  unit: 'ms'
});

const videoClipGenerationDuration = createHistogram(meter, 'video.clip.generation.duration', {
  description: 'Video clip generation duration',
  unit: 'ms'
});

const videoProcessingErrors = createHistogram(meter, 'video.processing.errors', {
  description: 'Video processing error count',
  unit: '1'
});

/**
 * Creates a span for FFmpeg execution with appropriate attributes
 * 
 * @param {Object} options FFmpeg execution options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withFFmpegSpan(options, fn) {
  const attributes = {
    'video.operation': options.operation || 'execute_ffmpeg',
    'video.input_path': sanitizePath(options.inputPath || 'unknown'),
    'video.output_path': sanitizePath(options.outputPath || 'unknown'),
    'video.codec': options.codec || 'unknown',
    'video.format': options.format || 'unknown',
  };
  
  // Add additional attributes if available
  if (options.startTime) attributes['video.start_time'] = options.startTime;
  if (options.duration) attributes['video.duration'] = options.duration;
  if (options.resolution) attributes['video.resolution'] = options.resolution;
  if (options.bitrate) attributes['video.bitrate'] = options.bitrate;
  if (options.hardwareAcceleration) attributes['video.hardware_acceleration'] = options.hardwareAcceleration;
  
  const startTime = Date.now();
  try {
    const result = await withSpan(tracer, `video.${options.operation || 'ffmpeg'}`, fn, attributes);
    
    // Record metrics
    const duration = Date.now() - startTime;
    if (options.operation === 'transcode') {
      videoTranscodeDuration.record(duration, {
        'video.codec': options.codec || 'unknown',
        'video.hardware_acceleration': options.hardwareAcceleration || 'none'
      });
    } else if (options.operation === 'clip') {
      videoClipGenerationDuration.record(duration, {
        'video.codec': options.codec || 'unknown'
      });
    }
    
    return result;
  } catch (error) {
    // Record error metrics
    videoProcessingErrors.record(1, {
      'video.operation': options.operation || 'execute_ffmpeg',
      'error.type': error.name || 'Error'
    });
    throw error;
  }
}

/**
 * Creates a span for video probe operations
 * 
 * @param {string} videoPath Path to the video file
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withProbeSpan(videoPath, fn) {
  return withSpan(tracer, 'video.probe', fn, {
    'video.path': sanitizePath(videoPath),
    'video.operation': 'probe'
  });
}

/**
 * Creates a span for video request handling
 * 
 * @param {Object} options Video request options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withVideoRequestSpan(options, fn) {
  const attributes = {
    'video.type': options.type || 'unknown',
    'video.id': options.id || 'unknown',
    'video.path': sanitizePath(options.path || 'unknown'),
    'video.format': options.format || 'unknown',
    'http.range': options.range || 'none'
  };
  
  if (options.start) attributes['video.start_time'] = options.start;
  if (options.end) attributes['video.end_time'] = options.end;
  
  return withSpan(tracer, 'video.request', fn, attributes);
}

/**
 * Creates a span for video clip generation
 * 
 * @param {Object} options Clip generation options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withClipGenerationSpan(options, fn) {
  const attributes = {
    'video.operation': 'clip',
    'video.input_path': sanitizePath(options.inputPath || 'unknown'),
    'video.output_path': sanitizePath(options.outputPath || 'unknown'),
    'video.start_time': options.startTime || 0,
    'video.duration': options.duration || 0,
    'video.codec': options.codec || 'unknown'
  };
  
  const startTime = Date.now();
  try {
    const result = await withSpan(tracer, 'video.clip.generate', fn, attributes);
    
    // Record metrics
    const duration = Date.now() - startTime;
    videoClipGenerationDuration.record(duration, {
      'video.codec': options.codec || 'unknown',
      'video.duration': options.duration || 0
    });
    
    return result;
  } catch (error) {
    // Record error metrics
    videoProcessingErrors.record(1, {
      'video.operation': 'clip',
      'error.type': error.name || 'Error'
    });
    throw error;
  }
}

/**
 * Creates a span for full video transcoding
 * 
 * @param {Object} options Transcoding options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withTranscodeSpan(options, fn) {
  const attributes = {
    'video.operation': 'transcode',
    'video.input_path': sanitizePath(options.inputPath || 'unknown'),
    'video.output_path': sanitizePath(options.outputPath || 'unknown'),
    'video.codec': options.codec || 'unknown',
    'video.hardware_acceleration': options.hardwareAcceleration || 'none'
  };
  
  const startTime = Date.now();
  try {
    const result = await withSpan(tracer, 'video.transcode', fn, attributes);
    
    // Record metrics
    const duration = Date.now() - startTime;
    videoTranscodeDuration.record(duration, {
      'video.codec': options.codec || 'unknown',
      'video.hardware_acceleration': options.hardwareAcceleration || 'none'
    });
    
    return result;
  } catch (error) {
    // Record error metrics
    videoProcessingErrors.record(1, {
      'video.operation': 'transcode',
      'error.type': error.name || 'Error'
    });
    throw error;
  }
}

/**
 * Sanitize file paths for telemetry (remove sensitive user paths)
 * 
 * @param {string} path File path to sanitize
 * @returns {string} Sanitized path
 */
function sanitizePath(path) {
  if (!path) return 'unknown';
  
  // Remove user home directory paths
  return path
    .replace(/^\/home\/[^\/]+/, '/home/USER')
    .replace(/^C:\\Users\\[^\\]+/, 'C:\\Users\\USER')
    .replace(/^\/Users\/[^\/]+/, '/Users/USER');
}