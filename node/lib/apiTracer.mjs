/**
 * OpenTelemetry tracing for API calls and image processing
 *
 * This module provides specialized tracing functions for TMDB API calls,
 * image downloads, and image processing operations with relevant attributes.
 */

import { getTracer, withSpan } from './tracer.mjs';
import { getMeter, createHistogram, createCounter } from './metrics.mjs';

// Create API-specific tracer and metrics
const tracer = getTracer('api-client');
const meter = getMeter('api-client');

// Metrics for API operations
const apiRequestDuration = createHistogram(meter, 'api.request.duration', {
  description: 'API request duration',
  unit: 'ms'
});

const apiRequestCounter = createCounter(meter, 'api.request.count', {
  description: 'API request count',
  unit: '1'
});

const apiCacheCounter = createCounter(meter, 'api.cache.count', {
  description: 'API cache hit/miss count',
  unit: '1'
});

const apiErrorCounter = createCounter(meter, 'api.request.errors', {
  description: 'API request error count',
  unit: '1'
});

const imageProcessingDuration = createHistogram(meter, 'image.processing.duration', {
  description: 'Image processing duration',
  unit: 'ms'
});

// Counter for image download outcomes. Each time the image downloader
// reaches a terminal decision for a given (mediaName, imageType) pair, it
// records exactly one event here so the ratio of fresh downloads to disk
// cache hits and failures is queryable per media type.
const imageOutcomeCounter = createCounter(meter, 'image.download.outcome', {
  description: 'TMDB image download outcomes by image type (downloaded / cache-hit / cache-hit-fresh / no-url / failed)',
  unit: '1'
});

/**
 * Record a single image download decision.
 *
 * @param {Object} options
 * @param {string} options.imageType - 'poster' | 'backdrop' | 'logo' | 'season-poster' | 'episode-thumbnail'
 * @param {string} options.outcome - 'downloaded' | 'cache-hit' | 'cache-hit-fresh' | 'no-url' | 'failed'
 * @param {string} [options.mediaType] - 'tv' | 'movie' (optional, low cardinality)
 */
export function recordImageOutcome({ imageType, outcome, mediaType }) {
  if (!imageType || !outcome) return;
  const attrs = {
    'image.type': imageType,
    'image.outcome': outcome,
  };
  if (mediaType) attrs['media.type'] = mediaType;
  imageOutcomeCounter.add(1, attrs);
}

/**
 * Best-effort byte size for an axios response body. Returns 0 instead of
 * throwing for streams, Buffers, or objects with circular references.
 */
function computeResponseSize(data) {
  if (data == null) return 0;
  if (typeof data === 'string') return data.length;
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  // Streams (Readable) and other piping objects have a .pipe method.
  if (typeof data.pipe === 'function') return 0;
  try {
    return JSON.stringify(data).length;
  } catch {
    return 0;
  }
}

/**
 * Create a span for API requests
 *
 * @param {Object} options API request options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withApiRequestSpan(options, fn) {
  const attributes = {
    'http.method': options.method || 'GET',
    'http.url': options.url || 'unknown',
    'api.service': options.service || 'unknown',
    'api.endpoint': options.endpoint || 'unknown',
    'api.params': JSON.stringify(options.params || {})
  };
  
  // Add additional attributes if available
  if (options.cacheKey) attributes['api.cache_key'] = options.cacheKey;
  
  const startTime = Date.now();
  
  try {
    // Execute API request
    const result = await withSpan(tracer, `api.${options.service || 'unknown'}.request`, async () => {
      return await fn();
    }, attributes);
    
    // Record response metrics
    const duration = Date.now() - startTime;
    const statusCode = result?.status || 200;

    // Add response attributes. `api.response_size` must guard against
    // non-JSON-serializable bodies — when axios is called with
    // `responseType: 'stream'` (image downloads) or `'arraybuffer'`
    // (blurhash source fetch), `result.data` is a Readable stream or Buffer
    // with circular references (TLSSocket → HTTPParser → socket), and
    // calling JSON.stringify on it throws "Converting circular structure to
    // JSON". That throw used to escape this wrapper and fail every image
    // download via the retry loop.
    attributes['http.status_code'] = statusCode;
    attributes['api.response_size'] = computeResponseSize(result?.data);
    
    // Record success metrics
    apiRequestDuration.record(duration, {
      'api.service': options.service || 'unknown',
      'api.endpoint': options.endpoint || 'unknown',
      'http.status_code': statusCode
    });
    
    apiRequestCounter.add(1, {
      'api.service': options.service || 'unknown',
      'api.endpoint': options.endpoint || 'unknown',
      'http.status_code': statusCode
    });
    
    return result;
  } catch (error) {
    // Record error status code if available
    if (error.response?.status) {
      attributes['http.status_code'] = error.response.status;
    }
    
    // Record error metrics
    apiErrorCounter.add(1, {
      'api.service': options.service || 'unknown',
      'api.endpoint': options.endpoint || 'unknown',
      'error.type': error.name || 'Error',
      'http.status_code': error.response?.status || 0
    });
    
    throw error;
  }
}

/**
 * Create a span for API cache operations
 * 
 * @param {Object} options Cache operation options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withApiCacheSpan(options, fn) {
  const attributes = {
    'api.service': options.service || 'unknown',
    'api.cache_key': options.cacheKey || 'unknown',
    'api.operation': options.operation || 'GET',
    'api.cache_ttl': options.ttl || 0
  };
  
  try {
    // Execute cache operation
    const result = await withSpan(tracer, `api.${options.service || 'unknown'}.cache.${options.operation?.toLowerCase() || 'get'}`, async () => {
      return await fn();
    }, attributes);
    
    if ((options.operation || 'GET').toUpperCase() === 'SET') {
      // Writes report their own success attribute (T-6). Deriving
      // api.cache_hit from a write's return value polluted every read-side
      // hit-ratio dashboard with false (void writers) or fake-true entries.
      // `false` is the only explicit failure signal (setTmdbCache returns
      // true/false); void writers signal failure by throwing, which the
      // catch below records instead.
      const writeSuccess = result !== false;
      attributes['api.cache_write_success'] = writeSuccess;
      apiCacheCounter.add(1, {
        'api.service': options.service || 'unknown',
        'api.operation': options.operation || 'SET',
        'api.cache_write_success': writeSuccess.toString()
      });
      return result;
    }

    // Record cache hit/miss
    const cacheHit = result !== null && result !== undefined;
    attributes['api.cache_hit'] = cacheHit;

    // Record metrics
    apiCacheCounter.add(1, {
      'api.service': options.service || 'unknown',
      'api.operation': options.operation || 'GET',
      'api.cache_hit': cacheHit.toString()
    });

    return result;
  } catch (error) {
    // Record error metrics
    apiErrorCounter.add(1, {
      'api.service': options.service || 'unknown',
      'api.operation': options.operation || 'GET',
      'error.type': error.name || 'Error'
    });
    
    throw error;
  }
}

/**
 * Create a span for image processing operations
 * 
 * @param {Object} options Image processing options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withImageProcessingSpan(options, fn) {
  const attributes = {
    'image.operation': options.operation || 'process',
    'image.type': options.type || 'unknown',
    'image.format': options.format || 'unknown',
    'image.source': sanitizeUrl(options.url || 'unknown')
  };
  
  // Add additional attributes if available
  if (options.width) attributes['image.width'] = options.width;
  if (options.height) attributes['image.height'] = options.height;
  
  const startTime = Date.now();
  
  try {
    // Execute image processing operation
    const result = await withSpan(tracer, `image.${options.operation || 'process'}`, async () => {
      return await fn();
    }, attributes);
    
    // Record success metrics
    const duration = Date.now() - startTime;
    imageProcessingDuration.record(duration, {
      'image.operation': options.operation || 'process',
      'image.type': options.type || 'unknown'
    });
    
    return result;
  } catch (error) {
    // Record error metrics
    apiErrorCounter.add(1, {
      'image.operation': options.operation || 'process',
      'image.type': options.type || 'unknown',
      'error.type': error.name || 'Error'
    });
    
    throw error;
  }
}

/**
 * Create a span for Blurhash generation operations
 * 
 * @param {Object} options Blurhash options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withBlurhashSpan(options, fn) {
  const attributes = {
    'image.operation': 'blurhash',
    'image.type': options.type || 'unknown',
    'blurhash.components_x': options.componentsX || 4,
    'blurhash.components_y': options.componentsY || 3
  };
  
  if (options.url) attributes['image.source'] = sanitizeUrl(options.url);
  
  const startTime = Date.now();
  
  try {
    // Execute blurhash operation
    const result = await withSpan(tracer, 'image.blurhash.generate', async () => {
      return await fn();
    }, attributes);
    
    // Record success metrics
    const duration = Date.now() - startTime;
    imageProcessingDuration.record(duration, {
      'image.operation': 'blurhash',
      'image.type': options.type || 'unknown'
    });
    
    return result;
  } catch (error) {
    // Record error metrics
    apiErrorCounter.add(1, {
      'image.operation': 'blurhash',
      'image.type': options.type || 'unknown',
      'error.type': error.name || 'Error'
    });
    
    throw error;
  }
}

/**
 * Sanitize URLs for telemetry
 * 
 * @param {string} url URL to sanitize
 * @returns {string} Sanitized URL with sensitive parts removed
 */
function sanitizeUrl(url) {
  if (!url) return 'unknown';
  
  // Remove API keys and tokens
  return url.replace(/([?&](api_key|token|key|auth|access_token))=[^&]+/gi, '$1=[REDACTED]');
}