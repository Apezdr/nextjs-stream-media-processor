# OpenTelemetry Implementation Guide

## Quick Start

This guide provides practical instructions for working with OpenTelemetry instrumentation in the media processing application.

## Configuration

### Environment Variables

Add these to your `.env` file:

```bash
# OpenTelemetry Configuration
OTEL_ENABLED=true
OTEL_SERVICE_NAME=media-processor
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_TRACES_SAMPLER=parentbased_always_on
OTEL_TRACES_SAMPLER_ARG=1.0
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
OTEL_LOG_LEVEL=info
```

### SigNoz Connection

For Docker deployments on the same network as SigNoz:
```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
```

For local development (SigNoz exposed ports):
```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

## Adding Custom Spans

### Basic Pattern

```javascript
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('your-module-name');

export async function yourFunction(param) {
  const span = tracer.startSpan('operation.name', {
    attributes: {
      'param.key': param.value,
      'operation.type': 'example'
    }
  });

  try {
    const result = await doWork(param);
    
    // Add more attributes after operation
    span.setAttribute('result.size', result.size);
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
```

### Nested Spans

```javascript
async function parentOperation() {
  const parentSpan = tracer.startSpan('parent.operation');
  
  try {
    // Child span automatically linked to parent
    const childSpan = tracer.startSpan('child.operation');
    await childWork();
    childSpan.end();
    
    parentSpan.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    parentSpan.recordException(error);
    parentSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    throw error;
  } finally {
    parentSpan.end();
  }
}
```

### Context Propagation (Async Operations)

```javascript
import { context } from '@opentelemetry/api';

async function scheduleTask() {
  const span = tracer.startSpan('task.schedule');
  
  // Capture current context
  const ctx = context.active();
  
  // Pass context to async operation
  setTimeout(() => {
    context.with(ctx, () => {
      const childSpan = tracer.startSpan('task.execute');
      // This span is now linked to the original trace
      performTask();
      childSpan.end();
    });
  }, 1000);
  
  span.end();
}
```

## Span Naming Conventions

Follow these conventions for consistency:

- **Format**: `category.operation` or `category.subcategory.operation`
- **Examples**:
  - `video.transcode`
  - `video.sprite.generate`
  - `db.sqlite.query`
  - `tmdb.api.request`
  - `worker.task.execute`

## Attribute Naming Conventions

Use semantic conventions where possible:

### Standard Attributes
- `http.method`, `http.status_code`, `http.url`
- `db.system`, `db.statement`, `db.operation`
- `net.peer.name`, `net.peer.port`

### Custom Attributes
- Use dot notation: `video.path`, `task.type`, `worker.thread_id`
- Prefer lowercase with underscores for multi-word: `video.duration_ms`
- Include units in name: `_bytes`, `_ms`, `_count`

## Common Instrumentation Patterns

### Video Processing

```javascript
async function transcodeVideo(inputPath, options) {
  const span = tracer.startSpan('video.transcode', {
    attributes: {
      'video.path': inputPath,
      'video.codec': options.codec,
      'video.format': options.format,
      'video.resolution': options.resolution
    }
  });

  try {
    const startTime = Date.now();
    const result = await ffmpegTranscode(inputPath, options);
    const duration = Date.now() - startTime;
    
    span.setAttributes({
      'video.output_size_bytes': result.size,
      'video.transcode_duration_ms': duration,
      'video.success': true
    });
    
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error);
    span.setAttributes({
      'video.success': false,
      'error.type': error.name
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    throw error;
  } finally {
    span.end();
  }
}
```

### Database Operations

```javascript
async function queryDatabase(sql, params) {
  const span = tracer.startSpan('db.sqlite.query', {
    attributes: {
      'db.system': 'sqlite',
      'db.statement': sanitizeQuery(sql),
      'db.operation': getOperationType(sql)
    }
  });

  try {
    const result = await db.all(sql, params);
    span.setAttribute('db.rows_returned', result.length);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    throw error;
  } finally {
    span.end();
  }
}
```

### API Calls

```javascript
async function fetchTmdbMetadata(mediaType, mediaId) {
  const span = tracer.startSpan('tmdb.api.request', {
    attributes: {
      'tmdb.media_type': mediaType,
      'tmdb.media_id': mediaId,
      'http.method': 'GET'
    }
  });

  try {
    const response = await axios.get(url, config);
    
    span.setAttributes({
      'http.status_code': response.status,
      'http.response_size_bytes': JSON.stringify(response.data).length,
      'tmdb.cache_hit': response.headers['x-cache-hit'] === 'true'
    });
    
    span.setStatus({ code: SpanStatusCode.OK });
    return response.data;
  } catch (error) {
    span.recordException(error);
    span.setAttributes({
      'http.status_code': error.response?.status,
      'error.type': error.name
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    throw error;
  } finally {
    span.end();
  }
}
```

### Worker Pool Operations

```javascript
async function submitWorkerTask(taskType, taskData) {
  const span = tracer.startSpan('worker.task.submit', {
    attributes: {
      'worker.type': 'blurhash',
      'task.type': taskType,
      'task.id': taskData.id,
      'worker.queue_depth': pool.queueSize
    }
  });

  try {
    const result = await pool.run(taskData);
    
    span.setAttributes({
      'task.success': true,
      'task.execution_duration_ms': result.duration
    });
    
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error);
    span.setAttribute('task.success', false);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    throw error;
  } finally {
    span.end();
  }
}
```

## Collecting Metrics

### Counter

```javascript
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('your-module-name');
const requestCounter = meter.createCounter('http.requests', {
  description: 'Total HTTP requests',
  unit: '1'
});

// Increment counter
requestCounter.add(1, { 
  'http.method': 'GET',
  'http.route': '/api/videos'
});
```

### Gauge

```javascript
const queueDepthGauge = meter.createObservableGauge('worker.queue_depth', {
  description: 'Current worker queue depth',
  unit: '1'
});

queueDepthGauge.addCallback((observableResult) => {
  observableResult.observe(pool.queueSize, {
    'worker.type': 'blurhash'
  });
});
```

### Histogram

```javascript
const processingDuration = meter.createHistogram('video.processing_duration', {
  description: 'Video processing duration',
  unit: 'ms'
});

// Record value
const startTime = Date.now();
await processVideo(video);
const duration = Date.now() - startTime;

processingDuration.record(duration, {
  'video.type': 'movie',
  'video.codec': 'h264'
});
```

## Viewing Traces in SigNoz

### Access SigNoz UI

Navigate to your SigNoz instance (typically `http://localhost:3301` for local setups).

### Finding Your Service

1. Go to **Services** tab
2. Look for `media-processor` (or your configured service name)
3. Click to view service metrics

### Viewing Traces

1. Go to **Traces** tab
2. Filter by:
   - Service: `media-processor`
   - Operation: Specific span names
   - Tags: Custom attributes
   - Duration: Slow operations
   - Status: Errors only

### Common Queries

**Find slow video transcodes**:
- Filter: `video.transcode`
- Duration: `> 5000ms`

**Find failed API calls**:
- Filter: `tmdb.api.request`
- Status: `Error`

**Find database bottlenecks**:
- Filter: `db.sqlite.*`
- Sort by: Duration (descending)

## Troubleshooting

### No Traces Appearing

1. **Check OTEL_ENABLED**: Ensure it's set to `true`
2. **Check endpoint**: Verify `OTEL_EXPORTER_OTLP_ENDPOINT` is correct
3. **Check network**: Ensure app can reach SigNoz collector
4. **Check logs**: Look for OpenTelemetry initialization errors
5. **Test connectivity**: 
   ```bash
   curl http://localhost:4317
   ```

### Traces Not Linked

- Ensure context propagation across async boundaries
- Check that all async operations use `context.with()`
- Verify worker threads have context propagation

### High Memory Usage

- Reduce sampling rate: `OTEL_TRACES_SAMPLER_ARG=0.1` (10%)
- Limit span attributes
- Reduce batch size in exporter configuration

### Performance Impact

- Use sampling for high-volume operations
- Batch telemetry export
- Monitor overhead with metrics
- Consider async exporters

## Best Practices

### Do's

✅ Use semantic conventions for standard operations  
✅ Add meaningful attributes to spans  
✅ Record exceptions with `span.recordException(error)`  
✅ Set span status appropriately  
✅ End spans in `finally` blocks  
✅ Use consistent naming conventions  
✅ Propagate context across async boundaries  
✅ Sample high-volume operations

### Don'ts

❌ Don't log sensitive data (passwords, tokens, user data)  
❌ Don't create too many spans (creates overhead)  
❌ Don't forget to end spans  
❌ Don't create spans for trivial operations (<1ms)  
❌ Don't hardcode service names  
❌ Don't ignore error cases  
❌ Don't export to production without sampling

## Performance Considerations

### Expected Overhead

- **CPU**: <2% additional CPU usage
- **Memory**: ~15-30MB for SDK
- **Latency**: <1ms per request
- **Network**: Depends on span volume and batch size

### Optimization Tips

1. **Use sampling** for high-volume endpoints
2. **Batch exports** to reduce network calls
3. **Limit span attributes** to essential data only
4. **Avoid creating spans** for sub-millisecond operations
5. **Use async exporters** to prevent blocking

## Security Considerations

### Data Sanitization

Always sanitize sensitive data before adding to spans:

```javascript
function sanitizePath(path) {
  // Remove user paths, keep relative structure
  return path.replace(/^\/home\/[^\/]+/, '/home/USER');
}

function sanitizeQuery(sql) {
  // Remove parameter values, keep structure
  return sql.replace(/\?/g, '?').replace(/'[^']*'/g, "'***'");
}

span.setAttribute('video.path', sanitizePath(videoPath));
span.setAttribute('db.statement', sanitizeQuery(sqlQuery));
```

### Network Security

- Use HTTPS for OTLP endpoints in production
- Implement authentication if collector is exposed
- Use firewalls to restrict collector access

## Migration Path

### Phase 1: Core Setup (Week 1)
- Install dependencies
- Create telemetry module
- Add basic configuration
- Verify connectivity to SigNoz

### Phase 2: Auto-Instrumentation (Week 1)
- Enable Express auto-instrumentation
- Enable MongoDB auto-instrumentation
- Verify automatic trace capture

### Phase 3: Custom Instrumentation (Weeks 2-3)
- Add video processing spans
- Add database operation spans
- Add API call spans
- Add worker pool spans

### Phase 4: Metrics & Optimization (Week 4)
- Implement metrics collection
- Optimize sampling
- Create dashboards
- Set up alerts

## Support & Resources

### Documentation Links
- [OpenTelemetry Node.js Docs](https://opentelemetry.io/docs/instrumentation/js/getting-started/nodejs/)
- [SigNoz Node.js Guide](https://signoz.io/docs/instrumentation/nodejs/)
- [Implementation Plan](../plans/OPENTELEMETRY_INSTRUMENTATION.md)

### Internal Resources
- Implementation Plan: [`plans/OPENTELEMETRY_INSTRUMENTATION.md`](../plans/OPENTELEMETRY_INSTRUMENTATION.md)
- Telemetry Module: [`node/lib/telemetry.mjs`](../node/lib/telemetry.mjs)
- Logger Integration: [`node/lib/logger.mjs`](../node/lib/logger.mjs)

### Getting Help

If you encounter issues:
1. Check SigNoz logs for collector errors
2. Check application logs for telemetry errors
3. Verify environment configuration
4. Test with console exporter first
5. Review the troubleshooting section above
