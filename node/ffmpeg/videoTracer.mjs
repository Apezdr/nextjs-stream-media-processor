/**
 * OpenTelemetry tracing for video clip generation
 *
 * A span and a duration metric around each clip that ffmpeg produces.
 */

import { getTracer, withSpan } from '../lib/tracer.mjs';
import { getMeter, createHistogram } from '../lib/metrics.mjs';

// Create video-specific tracer and metrics
const tracer = getTracer('video-processor');
const meter = getMeter('video-processor');

// Metrics for video processing
const videoClipGenerationDuration = createHistogram(meter, 'video.clip.generation.duration', {
  description: 'Video clip generation duration',
  unit: 'ms'
});

const videoProcessingErrors = createHistogram(meter, 'video.processing.errors', {
  description: 'Video processing error count',
  unit: '1'
});

/**
 * Creates a span for video clip generation
 *
 * @param {Object} options Clip generation options
 * @param {string} options.inputPath Source video
 * @param {string} options.outputPath Cache file the clip ends up in
 * @param {number} options.startTime Clip start in the source, seconds
 * @param {number} options.duration Clip length, seconds
 * @param {string} options.codec What the clip's video is ('h264', 'copy-hevc', ...)
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
