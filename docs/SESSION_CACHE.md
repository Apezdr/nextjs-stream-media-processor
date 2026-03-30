# Session Cache System

## Overview

The session cache system provides a memory-safe, multi-tier caching mechanism for authenticated user sessions. It dramatically reduces MongoDB authentication queries while maintaining security and preventing memory leaks through sophisticated bounded caching strategies.

## Architecture

### Multi-Tier Caching Strategy

The system implements three levels of caching with different TTLs and purposes:

1. **Request-Level Cache** (1 second TTL, max 500 entries)
   - Ultra-fast cache for sub-second consecutive requests
   - Prevents duplicate auth checks within the same second
   - Ideal for rapid API calls (e.g., pagination, media loading)

2. **Session-Level Cache** (30 second TTL, max 1000 entries)
   - Primary cache for user sessions
   - Reduces MongoDB queries by 95%+ for normal usage patterns
   - Uses LRU eviction when capacity is reached

3. **Inflight Request Deduplication** (5 second TTL, max 100 entries)
   - Prevents concurrent requests from triggering multiple auth checks
   - Single auth lookup shared across simultaneous requests
   - Automatic cleanup of stale promises

## Memory Safety Features

### 1. Bounded LRU Cache

All caches have hard size limits and implement Least Recently Used (LRU) eviction:

```javascript
// Configuration
sessionCache: 1000 sessions max, 30s TTL
requestCache: 500 requests max, 1s TTL
inflightCache: 100 concurrent max, 5s TTL
```

When capacity is reached, the least recently accessed entry is automatically removed.

### 2. Memory Pressure Detection

The system monitors Node.js heap usage every 30 seconds:

- **Warning Threshold**: 80% heap usage or 500MB absolute
- **Emergency Actions**:
  - Aggressive cleanup of expired entries
  - Full cache clear if pressure persists
  - Temporary cache disable during high memory conditions

### 3. Circuit Breaker Pattern

Protects against authentication service failures:

- **Failure Threshold**: 5 consecutive auth failures
- **Open State**: Blocks auth attempts for 30 seconds
- **Half-Open State**: Tests service recovery with single attempt
- **Automatic Recovery**: Closes circuit on successful auth

### 4. Automatic Cleanup

Multiple cleanup mechanisms prevent memory accumulation:

- **Regular Cleanup**: Every 5 minutes (expired entries only)
- **Emergency Cleanup**: Triggered by memory pressure
- **Stale Promise Cleanup**: Every 10 seconds (hung requests)
- **TTL Expiration**: Checked on every cache access

## Performance Metrics

### Expected Performance Improvements

- **95%+ reduction** in MongoDB authentication queries
- **Sub-millisecond** response time for cached sessions
- **Zero duplicate auth checks** for concurrent requests
- **Automatic failover** during service degradation

### Cache Hit Rates

Typical hit rates by usage pattern:

| Pattern | Expected Hit Rate | Cache Layer |
|---------|------------------|-------------|
| Rapid consecutive requests (< 1s) | 99% | Request cache |
| Normal browsing (< 30s) | 95% | Session cache |
| Long idle periods (> 30s) | 0% | Cache miss (expected) |
| Concurrent requests | 100% | Deduplication |

## API Endpoints

### Get Cache Statistics

```http
GET /api/admin/session-cache/stats
Authorization: Bearer <admin-token>
```

**Response:**

```json
{
  "cacheStats": {
    "hits": 12543,
    "misses": 234,
    "hitRate": "98.17%",
    "evictions": 5,
    "memoryCleanups": 0,
    "lastCleanup": "2024-03-17T02:00:00.000Z"
  },
  "cacheSizes": {
    "sessionCache": 234,
    "requestCache": 12,
    "inflightRequests": 0
  },
  "memoryStatus": {
    "memoryPressure": false,
    "heapUsed": "245.34 MB",
    "heapTotal": "512.00 MB"
  },
  "circuitBreaker": {
    "state": "CLOSED",
    "failureCount": 0,
    "nextAttempt": null,
    "lastFailure": null
  }
}
```

### Clear Session Cache

```http
POST /api/admin/session-cache/clear
Authorization: Bearer <admin-token>
```

**Response:**

```json
{
  "success": true,
  "message": "Session cache cleared successfully",
  "timestamp": "2024-03-17T02:00:00.000Z"
}
```

## Configuration

### Environment Variables

No additional configuration required. The system uses sensible defaults:

```env
# Better Auth (existing configuration)
BETTER_AUTH_SECRET=your-secret-key
MONGODB_AUTH_DB=Users
```

### Tunable Parameters

Advanced users can modify cache parameters in [`node/middleware/sessionCache.mjs`](node/middleware/sessionCache.mjs):

```javascript
// In MemoryAwareSessionCache constructor
this.sessionCache = new BoundedLRUCache(1000, 30000) // size, TTL in ms
this.requestCache = new BoundedLRUCache(500, 1000)
this.inflightCache = new BoundedLRUCache(100, 5000)

// In AuthCircuitBreaker constructor
new AuthCircuitBreaker(5, 30000) // failure threshold, timeout in ms
```

## Monitoring & Observability

### Log Messages

The system logs important events for monitoring:

**Debug Level:**
- Cache hits and misses
- Request deduplication
- Regular cleanup operations

**Info Level:**
- Emergency cache cleanup actions
- Circuit breaker state changes
- Admin operations (stats, clear)

**Warning Level:**
- Memory pressure detection
- Stale request cleanup
- Authentication failures

**Error Level:**
- Circuit breaker opening
- Auth service failures
- Unexpected errors

### Metrics to Monitor

1. **Hit Rate**: Should be > 90% during normal operation
2. **Memory Pressure**: Should remain false
3. **Circuit Breaker State**: Should stay CLOSED
4. **Cache Sizes**: Should stay well below limits
5. **Evictions**: Low eviction rate indicates good cache sizing

## Security Considerations

### Token Validation

All session tokens are validated before caching:

- Minimum length: 10 characters
- Maximum length: 200 characters
- Prevents cache pollution from malformed tokens

### Cache Isolation

Each user's session data is isolated by token:

- No cross-user cache contamination
- Token-based cache keys
- Automatic expiration of stale sessions

### Admin-Only Access

Cache management endpoints require admin privileges:

- Statistics viewing: Admin only
- Cache clearing: Admin only
- Respects existing auth middleware chain

## Troubleshooting

### High Memory Usage

**Symptoms:**
- Memory pressure warnings in logs
- Automatic cache clearing
- Increased cache misses

**Solutions:**
1. Check for memory leaks in other parts of application
2. Reduce cache sizes if needed
3. Monitor heap usage trends
4. Consider increasing server memory

### Low Hit Rate

**Symptoms:**
- Hit rate < 80%
- Increased MongoDB queries
- Slower response times

**Possible Causes:**
1. **Short session durations**: Users logging out frequently
2. **Distributed deployment**: Multiple servers not sharing cache
3. **Cache clearing**: Too frequent manual cache clears
4. **High user churn**: Many new users/sessions

**Solutions:**
- Review session TTL configuration
- Implement Redis for distributed caching (future enhancement)
- Reduce cache clear frequency

### Circuit Breaker Opening

**Symptoms:**
- Circuit breaker state: OPEN or HALF_OPEN
- 503 errors on auth endpoints
- Authentication failures

**Possible Causes:**
1. MongoDB connection issues
2. Better Auth service degradation
3. Network problems

**Solutions:**
1. Check MongoDB connectivity
2. Review Better Auth logs
3. Check network status
4. Wait for automatic recovery (30 seconds)

### Stale Inflight Requests

**Symptoms:**
- Growing inflight request count
- Warnings about stale request cleanup

**Possible Causes:**
1. Slow authentication responses
2. Network timeouts
3. Better Auth hanging

**Solutions:**
- Review Better Auth performance
- Check MongoDB query performance
- Investigate network latency
- Automatic cleanup occurs every 10 seconds

## Implementation Details

### Files

- [`node/middleware/sessionCache.mjs`](node/middleware/sessionCache.mjs) - Core cache implementation
- [`node/middleware/auth.mjs`](node/middleware/auth.mjs) - Auth middleware integration
- [`node/routes/admin.mjs`](node/routes/admin.mjs) - Admin endpoints

### Classes

1. **BoundedLRUCache** - LRU cache with hard size limits and TTL
2. **MemoryAwareSessionCache** - Multi-tier cache with memory monitoring
3. **AuthCircuitBreaker** - Circuit breaker for auth service protection
4. **ProductionSessionManager** - Main session manager coordinating all components

### Design Patterns

- **LRU Caching**: Automatic eviction of least recently used entries
- **Circuit Breaker**: Fail-fast pattern for service protection
- **Request Deduplication**: Single-flight pattern for concurrent requests
- **Graceful Degradation**: Cache disable under memory pressure
- **Observer Pattern**: Memory pressure monitoring with reactive cleanup

## Future Enhancements

### Planned Improvements

1. **Redis Integration**: Distributed caching across multiple servers
2. **Prometheus Metrics**: Export cache metrics for monitoring
3. **Dynamic TTL**: Adjust TTL based on usage patterns
4. **Session Prediction**: Pre-cache likely-to-be-accessed sessions
5. **Compression**: Compress cached session data for lower memory usage

### Known Limitations

1. **Single-Server Only**: Cache not shared across multiple app instances
2. **In-Memory Only**: Cache lost on server restart
3. **No Persistence**: Sessions must be re-authenticated after restart
4. **Fixed TTLs**: TTLs are hardcoded, not adaptive

## Migration from Legacy System

If you had a previous session cache implementation, this new system is a drop-in replacement:

1. **No Code Changes Required**: Existing auth middleware calls work unchanged
2. **Backwards Compatible**: All existing auth flows continue working
3. **Automatic Activation**: Cache activates immediately on server start
4. **Zero Configuration**: Works out of the box with default settings

## Best Practices

1. **Monitor Hit Rates**: Check cache statistics in system status dashboard
2. **Set Alerts**: Alert on low hit rates or memory pressure
3. **Regular Review**: Check logs for unusual patterns
4. **Load Testing**: Verify cache performance under expected load
5. **Graceful Restarts**: Plan for cache warm-up period after restarts

## Support & Maintenance

For issues or questions about the session cache system:

1. Check logs for error messages and warnings
2. Review cache statistics via admin endpoint
3. Verify MongoDB connectivity and performance
4. Check system memory availability
5. Review Better Auth configuration

The session cache system is designed to be self-managing and require minimal intervention in normal operation.
