# SQLite OpenTelemetry Integration Plan

## Overview

This plan outlines the implementation of **optional** OpenTelemetry instrumentation for SQLite databases in the media processor application. The implementation will be controlled via environment variables, allowing users to enable telemetry without code changes.

## Current Architecture Analysis

### SQLite Usage Patterns

The application uses 4 separate SQLite databases:
- **main** (`media.db`) - Movies, TV shows, and media metadata
- **processTracking** (`process_tracking.db`) - Process queue and job tracking
- **tmdbCache** (`tmdb_cache.db`) - TMDB API response caching
- **discordIntros** (`discord_intros.db`) - Discord bot user tracking

### Key Instrumentation Points

All database operations flow through centralized functions in [`sqliteDatabase.mjs`](../node/sqliteDatabase.mjs):

1. **`withDb(dbType, fn)`** - Read operations wrapper
2. **`withWriteTx(dbType, fn)`** - Write operations with transaction wrapper
3. **`withRetry(fn, maxRetries)`** - Retry logic for SQLITE_BUSY errors
4. **`db.run()`, `db.get()`, `db.all()`, `db.exec()`** - Direct SQLite operations

### Current Database Metrics Available

Through SQLite PRAGMA commands:
- `PRAGMA page_count` - Total database pages
- `PRAGMA page_size` - Page size in bytes
- `PRAGMA cache_size` - Cache size configuration
- `PRAGMA freelist_count` - Number of free pages
- `PRAGMA wal_checkpoint` - WAL checkpoint statistics
- `PRAGMA database_list` - List of attached databases

## Implementation Strategy

### 1. Environment Variable Configuration

All OpenTelemetry features will be controlled via environment variables:

```bash
# Enable/Disable OpenTelemetry
OTEL_ENABLED=true|false                          # Master switch (default: false)

# OpenTelemetry Collector Configuration
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318  # HTTP endpoint
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf|grpc     # Protocol (default: http/protobuf)
OTEL_EXPORTER_OTLP_HEADERS=key1=value1,key2=value2 # Optional headers

# Service Identification
OTEL_SERVICE_NAME=media-processor                   # Service name (default: media-processor)
OTEL_SERVICE_VERSION=1.0.1                         # Service version
OTEL_DEPLOYMENT_ENVIRONMENT=production|development  # Environment

# SQLite-Specific Configuration
OTEL_SQLITE_TRACE_QUERIES=true|false               # Trace individual queries (default: true)
OTEL_SQLITE_METRICS_INTERVAL=30000                 # Metrics collection interval in ms (default: 30000)
OTEL_SQLITE_TRACE_FULL_SQL=false                   # Include full SQL in spans (default: false, security)
OTEL_SQLITE_MAX_SQL_LENGTH=200                     # Max SQL length in traces (default: 200)

# Performance Configuration
OTEL_TRACES_SAMPLER=always_on|always_off|traceidratio  # Sampling strategy (default: always_on)
OTEL_TRACES_SAMPLER_ARG=0.1                            # Sample ratio if traceidratio
OTEL_METRIC_EXPORT_INTERVAL=5000                       # Metric export interval (default: 5000ms)
OTEL_BSP_EXPORT_TIMEOUT=30000                          # Batch export timeout (default: 30000ms)
```

### 2. Module Architecture

```
node/
├── lib/
│   ├── telemetry/
│   │   ├── index.mjs                  # Main initialization
│   │   ├── config.mjs                 # Environment variable parser
│   │   ├── tracer.mjs                 # Trace provider setup
│   │   ├── metrics.mjs                # Meter provider setup
│   │   └── sqlite-instrumentation.mjs # SQLite-specific instrumentation
│   └── logger.mjs                     # Existing logger
├── sqliteDatabase.mjs                 # Add instrumentation hooks
└── app.mjs                            # Initialize telemetry
```

### 3. Conditional Loading Pattern

The telemetry system will use dynamic imports to avoid loading dependencies when disabled:

```javascript
// lib/telemetry/index.mjs
let telemetryInitialized = false;
let tracer = null;
let meter = null;

export async function initializeTelemetry() {
  const enabled = process.env.OTEL_ENABLED === 'true';
  
  if (!enabled) {
    return { enabled: false, tracer: null, meter: null };
  }

  // Dynamic import - only loaded if enabled
  const { setupTracer } = await import('./tracer.mjs');
  const { setupMetrics } = await import('./metrics.mjs');
  
  tracer = await setupTracer();
  meter = await setupMetrics();
  
  telemetryInitialized = true;
  return { enabled: true, tracer, meter };
}

export function getTracer() {
  return tracer;
}

export function getMeter() {
  return meter;
}

export function isTelemetryEnabled() {
  return telemetryInitialized;
}
```

### 4. Instrumentation Approach

#### A. Non-Invasive Wrapper Pattern

Wrap existing database functions with optional telemetry:

```javascript
// sqliteDatabase.mjs
import { instrumentDbOperation } from './lib/telemetry/sqlite-instrumentation.mjs';

export async function withDb(dbType, fn, options = {}) {
  const db = await getOrCreateDb(dbType);
  
  // Wrap the function with instrumentation if enabled
  const instrumentedFn = instrumentDbOperation({
    dbType,
    operation: 'read',
    fn: () => fn(db),
    options
  });
  
  return await instrumentedFn();
}
```

#### B. Metrics Collection

Collect SQLite-specific metrics periodically:

```javascript
// lib/telemetry/sqlite-instrumentation.mjs
import { getMeter, isTelemetryEnabled } from './index.mjs';

class SQLiteMetricsCollector {
  constructor() {
    if (!isTelemetryEnabled()) return;
    
    const meter = getMeter();
    
    // Create metrics
    this.queryCounter = meter.createCounter('sqlite.queries.total');
    this.queryDuration = meter.createHistogram('sqlite.query.duration');
    this.connectionCount = meter.createUpDownCounter('sqlite.connections.active');
    this.dbSize = meter.createUpDownCounter('sqlite.database.size_bytes');
    this.walSize = meter.createUpDownCounter('sqlite.wal.size_bytes');
    this.cacheHitRatio = meter.createGauge('sqlite.cache.hit_ratio');
    
    // Start periodic collection
    this.startCollection();
  }
  
  async startCollection() {
    const interval = parseInt(process.env.OTEL_SQLITE_METRICS_INTERVAL || '30000');
    setInterval(() => this.collect(), interval);
  }
  
  async collect() {
    // Collect database file sizes, WAL sizes, PRAGMA stats, etc.
  }
}
```

#### C. Tracing Individual Queries

Create spans for database operations:

```javascript
export function instrumentDbOperation({ dbType, operation, fn, options = {} }) {
  if (!isTelemetryEnabled()) {
    return fn;
  }
  
  return async () => {
    const tracer = getTracer();
    const meter = getMeter();
    
    return tracer.startActiveSpan(`sqlite.${operation}`, {
      attributes: {
        'db.system': 'sqlite',
        'db.name': dbType,
        'db.operation': operation,
      }
    }, async (span) => {
      const startTime = Date.now();
      
      try {
        // Increment query counter
        meter.createCounter('sqlite.queries.total').add(1, {
          db_name: dbType,
          operation
        });
        
        const result = await fn();
        
        // Record duration
        const duration = Date.now() - startTime;
        meter.createHistogram('sqlite.query.duration').record(duration, {
          db_name: dbType,
          operation,
          success: 'true'
        });
        
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
    });
  };
}
```

### 5. Package Dependencies

Add to [`package.json`](../node/package.json) as **optional dependencies**:

```json
{
  "optionalDependencies": {
    "@opentelemetry/api": "^1.8.0",
    "@opentelemetry/sdk-node": "^0.52.0",
    "@opentelemetry/sdk-trace-node": "^1.25.0",
    "@opentelemetry/sdk-metrics": "^1.25.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.52.0",
    "@opentelemetry/exporter-metrics-otlp-http": "^0.52.0",
    "@opentelemetry/resources": "^1.25.0",
    "@opentelemetry/semantic-conventions": "^1.25.0"
  }
}
```

**Rationale for optionalDependencies:**
- Won't fail build if packages missing
- Can be installed on-demand
- Keeps base image lighter
- User can build with or without telemetry support

### 6. Dockerfile Integration

Update [`Dockerfile`](../Dockerfile) to support optional build:

```dockerfile
# Add build argument for telemetry support
ARG ENABLE_TELEMETRY=false

# In builder stage, conditionally install telemetry dependencies
WORKDIR /usr/src/app/node
RUN if [ "$ENABLE_TELEMETRY" = "true" ]; then \
      npm install --include=optional; \
    else \
      npm install --omit=optional; \
    fi
```

**Build commands:**
```bash
# Without telemetry (smaller image)
docker build -t media-processor:latest .

# With telemetry support
docker build --build-arg ENABLE_TELEMETRY=true -t media-processor:telemetry .
```

### 7. SigNoz Collector Configuration

Update `otel-collector-config.yaml` to add metrics pipeline:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

  # ... existing filelog receiver ...

processors:
  # ... existing processors ...

  # Add SQLite-specific transformations
  transform/sqlite_metrics:
    metric_statements:
      - context: metric
        statements:
          - set(attributes["service.name"], "media-processor") where attributes["service.name"] == nil
          - set(attributes["db.type"], "sqlite") where name matches "sqlite_.*"
          - set(attributes["deployment.environment"], "docker") where attributes["deployment.environment"] == nil

  # Add resource detection
  resource:
    attributes:
      - key: deployment.environment
        value: docker
        action: upsert

  batch:
    send_batch_size: 10000
    send_batch_max_size: 11000
    timeout: 10s

exporters:
  clickhousetraces:
    datasource: tcp://clickhouse:9000/?database=signoz_traces

  clickhouselogsexporter:
    dsn: tcp://clickhouse:9000/signoz_logs
    timeout: 10s
    use_new_schema: true

  # Add metrics exporter
  clickhousemetricsexporter:
    dsn: tcp://clickhouse:9000/signoz_metrics
    timeout: 10s

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, resource]
      exporters: [clickhousetraces]

    logs:
      receivers: [filelog, otlp]
      processors: [transform/logseverity, batch, resource]
      exporters: [clickhouselogsexporter]

    # Add metrics pipeline
    metrics:
      receivers: [otlp]
      processors: [transform/sqlite_metrics, batch, resource]
      exporters: [clickhousemetricsexporter]
```

## Key Metrics to Track

### Performance Metrics
| Metric | Type | Description |
|--------|------|-------------|
| `sqlite.queries.total` | Counter | Total queries executed by database and operation type |
| `sqlite.query.duration` | Histogram | Query execution time distribution |
| `sqlite.transaction.duration` | Histogram | Transaction completion time |
| `sqlite.retry.count` | Counter | Number of SQLITE_BUSY retries |
| `sqlite.lock.wait_time` | Histogram | Time spent waiting for locks |

### Resource Metrics
| Metric | Type | Description |
|--------|------|-------------|
| `sqlite.database.size_bytes` | UpDownCounter | Database file size |
| `sqlite.wal.size_bytes` | UpDownCounter | WAL file size |
| `sqlite.connections.active` | UpDownCounter | Active database connections |
| `sqlite.cache.size_bytes` | UpDownCounter | SQLite cache size |
| `sqlite.page_count` | Gauge | Total database pages |

### Cache Metrics
| Metric | Type | Description |
|--------|------|-------------|
| `sqlite.cache.hit_ratio` | Gauge | Cache hit ratio (0-100%) |
| `sqlite.cache.hits` | Counter | Cache hits |
| `sqlite.cache.misses` | Counter | Cache misses |

### Health Metrics
| Metric | Type | Description |
|--------|------|-------------|
| `sqlite.errors.total` | Counter | Total errors by error code |
| `sqlite.corruption.detected` | Counter | Database corruption events |
| `sqlite.checkpoint.duration` | Histogram | WAL checkpoint duration |
| `sqlite.freelist.pages` | Gauge | Number of free pages (fragmentation) |

## Trace Attributes

For each database operation span:

```javascript
{
  // Standard semantic conventions
  "db.system": "sqlite",
  "db.name": "main|processTracking|tmdbCache|discordIntros",
  "db.operation": "read|write|transaction|checkpoint",
  
  // SQLite-specific
  "db.sqlite.file_path": "/usr/src/app/node/db/media.db",
  "db.sqlite.wal_mode": "true",
  "db.sqlite.table": "movies|tv_shows|...",
  
  // Operation-specific
  "db.statement": "SELECT * FROM movies WHERE name = ?", // truncated
  "db.statement.truncated": "true|false",
  "db.rows_affected": 42,
  
  // Performance
  "db.retry.count": 2,
  "db.retry.total_wait_ms": 50,
  
  // Status
  "error.type": "SQLITE_BUSY|SQLITE_LOCKED|...",
  "error.code": "5"
}
```

## Security Considerations

1. **SQL Statement Sanitization**: 
   - By default, SQL statements are truncated (max 200 chars)
   - Controlled via `OTEL_SQLITE_MAX_SQL_LENGTH`
   - Never include parameter values in traces

2. **Sensitive Data Protection**:
   - No user data in attributes
   - File paths only, no content
   - Error messages sanitized

3. **Performance Impact**:
   - Minimal overhead when disabled (no-op)
   - Async metric collection (non-blocking)
   - Batched exports to reduce network calls
   - Configurable sampling rates

## Testing Strategy

### Unit Tests
- Test telemetry initialization with/without env vars
- Test instrumentation wrappers (enabled/disabled)
- Test metric collection functions
- Test error handling in spans

### Integration Tests
- Test full telemetry pipeline with SigNoz
- Verify metrics appear in ClickHouse
- Test trace propagation across operations
- Test resource cleanup on shutdown

### Performance Tests
- Benchmark overhead with telemetry enabled/disabled
- Test under high concurrency (SQLITE_BUSY scenarios)
- Memory leak detection over extended periods

## Rollout Plan

### Phase 1: Foundation (Week 1)
1. Create telemetry module structure
2. Implement configuration system
3. Add conditional initialization
4. Update package.json with optional deps

### Phase 2: Instrumentation (Week 2)
1. Implement trace instrumentation for database operations
2. Create SQLite metrics collector
3. Add instrumentation to withDb/withWriteTx
4. Test with local SigNoz instance

### Phase 3: Integration (Week 3)
1. Update Dockerfile with build args
2. Update docker-compose with env vars
3. Document configuration options
4. Create SigNoz dashboards

### Phase 4: Documentation & Testing (Week 4)
1. Write comprehensive documentation
2. Create example configurations
3. Performance benchmarking
4. User acceptance testing

## Success Metrics

1. **Adoption**: % of users enabling telemetry
2. **Performance**: <5% overhead when enabled
3. **Reliability**: Zero crashes related to telemetry
4. **Visibility**: All SQLite operations visible in SigNoz
5. **Actionability**: Detect and diagnose 90% of database issues using telemetry

## Documentation Requirements

1. **User Guide**: How to enable and configure telemetry
2. **Architecture Doc**: System design and flow
3. **Troubleshooting Guide**: Common issues and solutions
4. **Dashboard Guide**: Using SigNoz dashboards effectively
5. **Performance Guide**: Tuning telemetry for production

## Future Enhancements

1. **Custom Exporters**: Support for Prometheus, Jaeger, etc.
2. **Query Profiling**: Slow query detection and alerts
3. **Auto-tuning**: Automatic cache size optimization based on metrics
4. **Intelligent Sampling**: Dynamic sampling based on query patterns
5. **Correlation**: Link database operations to HTTP requests

## References

- [OpenTelemetry JavaScript SDK](https://opentelemetry.io/docs/instrumentation/js/)
- [SQLite PRAGMA Documentation](https://www.sqlite.org/pragma.html)
- [SigNoz Documentation](https://signoz.io/docs/)
- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/database/)
