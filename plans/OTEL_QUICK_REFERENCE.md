# OpenTelemetry Quick Reference

## Package Installation

```bash
cd node
npm install --save \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-grpc \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-grpc \
  @opentelemetry/instrumentation \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

## Environment Variables (Add to .env)

```bash
OTEL_ENABLED=true
OTEL_SERVICE_NAME=media-processor
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_TRACES_SAMPLER=parentbased_always_on
OTEL_TRACES_SAMPLER_ARG=1.0
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production
OTEL_LOG_LEVEL=info
```

## Critical Files to Create

### 1. node/lib/telemetry.mjs
OpenTelemetry initialization - **must be imported first**

### 2. node/lib/tracer.mjs
Tracer helper utilities for easy span creation

### 3. node/lib/metrics.mjs
Metrics helper utilities for counters, gauges, histograms

## Application Startup Change

**BEFORE**:
```javascript
// node/app.mjs
import express from "express";
// ... other imports
```

**AFTER**:
```javascript
// node/app.mjs
// MUST BE FIRST - Initialize OpenTelemetry before any other imports
import './lib/telemetry.mjs';

// Now import everything else
import express from "express";
// ... other imports
```

## Priority Instrumentation Targets

### High Priority (Do First)
1. ✅ Express routes (auto-instrumented)
2. ✅ HTTP requests (auto-instrumented)
3. ✅ MongoDB operations (auto-instrumented)
4. 🔧 Video transcoding operations
5. 🔧 SQLite database operations
6. 🔧 TMDB API calls

### Medium Priority
7. 🔧 Worker pool operations
8. 🔧 Task queue operations
9. 🔧 File I/O operations
10. 🔧 Blurhash generation

### Lower Priority
11. 🔧 Scheduled jobs
12. 🔧 Cache operations
13. 🔧 Media scanning
14. 🔧 Business metrics

## Common Span Pattern

```javascript
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('module-name');

async function yourFunction(param) {
  const span = tracer.startSpan('operation.name', {
    attributes: { 'param.key': param }
  });

  try {
    const result = await doWork(param);
    span.setAttribute('result.key', result.value);
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

## Verification Steps

1. ✅ Start SigNoz
2. ✅ Configure OTEL environment variables
3. ✅ Start application
4. ✅ Generate test traffic
5. ✅ Check SigNoz UI for traces
6. ✅ Verify span hierarchy
7. ✅ Check for errors

## Key Instrumentation Points

### Video Processing
- **File**: `node/videoHandler.mjs`
- **Spans**: `video.request`, `video.stream`, `video.clip`

### FFmpeg Operations
- **File**: `node/ffmpeg/transcode.mjs`
- **Spans**: `video.transcode`, `video.probe`, `video.metadata`

### Database Operations
- **File**: `node/sqliteDatabase.mjs`
- **Spans**: `db.sqlite.query`, `db.sqlite.transaction`

### TMDB API
- **File**: `node/utils/tmdb.mjs`
- **Spans**: `tmdb.api.request`, `tmdb.metadata.fetch`

### Worker Pools
- **File**: `node/lib/blurhash-pool.mjs`
- **Spans**: `worker.task.submit`, `worker.task.execute`

## Metrics to Collect

### System Metrics
- `system.cpu.utilization`
- `system.memory.usage`
- `system.disk.usage`

### Application Metrics
- `http.server.request.duration`
- `video.transcode.duration`
- `worker.pool.queue_depth`

### Business Metrics
- `media.movies.total`
- `media.episodes.total`
- `tmdb.api.requests`

## Troubleshooting

### No traces in SigNoz?
1. Check `OTEL_ENABLED=true`
2. Verify endpoint: `http://otel-collector:4317`
3. Check Docker network connectivity
4. Look for errors in app logs

### Traces not linked?
- Use `context.with()` for async operations
- Ensure telemetry.mjs imported first
- Check context propagation in workers

### Performance issues?
- Enable sampling: `OTEL_TRACES_SAMPLER_ARG=0.1`
- Reduce span attributes
- Use async exporters

## Documentation

- **Full Plan**: [`plans/OPENTELEMETRY_INSTRUMENTATION.md`](OPENTELEMETRY_INSTRUMENTATION.md)
- **User Guide**: [`docs/OPENTELEMETRY_GUIDE.md`](../docs/OPENTELEMETRY_GUIDE.md)
- **SigNoz Docs**: https://signoz.io/docs/instrumentation/nodejs/

## Implementation Phases

**Phase 1: Core Setup** (~1 day)
- Install packages
- Create telemetry module
- Configure exporter
- Test basic connectivity

**Phase 2: Auto-Instrumentation** (~1 day)
- Enable Express instrumentation
- Enable MongoDB instrumentation
- Verify automatic traces

**Phase 3: Custom Instrumentation** (~1 week)
- Video processing spans
- Database operation spans
- API call spans
- Worker pool spans

**Phase 4: Metrics & Polish** (~3 days)
- Metrics collection
- Dashboard creation
- Alert configuration
- Performance tuning
