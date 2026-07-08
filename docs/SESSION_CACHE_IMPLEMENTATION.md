# Session Cache Implementation Guide

## Quick Start

The session cache system is now active and requires no configuration. It will automatically:

✅ Cache authenticated sessions for 30 seconds  
✅ Deduplicate concurrent auth requests  
✅ Monitor memory pressure and adapt  
✅ Protect against auth service failures  
✅ Clean up expired entries automatically  

## What Changed

### New Files

1. **`node/middleware/sessionCache.mjs`** - Complete session cache implementation
   - `BoundedLRUCache` - LRU cache with size limits
   - `MemoryAwareSessionCache` - Memory pressure monitoring
   - `AuthCircuitBreaker` - Service protection
   - `ProductionSessionManager` - Main coordinator

### Modified Files

1. **`node/middleware/auth.mjs`**
   - Removed direct `auth.api.getSession()` calls
   - Now uses `sessionManager.getSession()` for all authentication
   - Added circuit breaker error handling
   - Both `authenticateUser` and `authenticateWebhookOrUser` now use caching

2. **`node/routes/admin.mjs`**
   - Added `GET /api/admin/session-cache/stats` endpoint
   - Added `POST /api/admin/session-cache/clear` endpoint
   - Imported `sessionManager` for admin operations

3. **`docs/SESSION_CACHE.md`**
   - Complete documentation of architecture and usage
   - API reference for all endpoints
   - Troubleshooting guide

## Performance Impact

### Before (Without Cache)

```
Request 1 → MongoDB auth query → 50-100ms
Request 2 → MongoDB auth query → 50-100ms
Request 3 → MongoDB auth query → 50-100ms
...
```

### After (With Cache)

```
Request 1 → MongoDB auth query → 50-100ms → Cache stored
Request 2 → Cache hit → <1ms
Request 3 → Cache hit → <1ms
Request 4 (concurrent with 3) → Deduplication → <1ms
...
Request N (after 30s) → MongoDB auth query → 50-100ms → Cache refreshed
```

**Expected Improvements:**
- 95%+ reduction in MongoDB queries
- 50-100x faster response times for cached sessions
- Zero duplicate auth checks for concurrent requests
- Automatic protection during service issues

## Testing the Implementation

### 1. Start Your Server

```bash
npm start
# or
node node/app.mjs
```

Watch for the startup log message confirming session cache is active.

### 2. Test Cache Performance

Make multiple rapid API requests with the same auth token:

```bash
# Request 1 (cache miss - will query MongoDB)
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/movies

# Request 2 (cache hit - should be much faster)
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/movies

# Request 3 (cache hit - should be much faster)
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/api/tv
```

### 3. Check Cache Statistics

View cache performance metrics (requires admin token):

```bash
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  http://localhost:3000/api/admin/session-cache/stats
```

Example output:

```json
{
  "cacheStats": {
    "hits": 245,
    "misses": 12,
    "hitRate": "95.33%",
    "evictions": 0,
    "memoryCleanups": 0,
    "lastCleanup": "2024-03-17T02:00:00.000Z"
  },
  "cacheSizes": {
    "sessionCache": 12,
    "requestCache": 3,
    "inflightRequests": 0
  },
  "memoryStatus": {
    "memoryPressure": false,
    "heapUsed": "234.56 MB",
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

### 4. Monitor Logs

Watch for cache-related log messages:

```bash
# Look for these log categories
[session-cache] - Cache operations and cleanup
[auth-middleware] - Authentication with cache usage
```

**Expected log patterns:**

```
[session-cache] DEBUG: Blurhash cache hit for ... (cache working)
[auth-middleware] DEBUG: Authenticated user: user@example.com ... (cached auth)
[session-cache] INFO: Regular cache cleanup: 5 expired entries removed (maintenance)
```

## Monitoring in Production

### Key Metrics to Watch

1. **Cache Hit Rate** (should be > 90%)
   ```bash
   curl -H "Authorization: Bearer ADMIN_TOKEN" \
     http://localhost:3000/api/admin/session-cache/stats | \
     jq '.cacheStats.hitRate'
   ```

2. **Memory Pressure** (should be false)
   ```bash
   curl -H "Authorization: Bearer ADMIN_TOKEN" \
     http://localhost:3000/api/admin/session-cache/stats | \
     jq '.memoryStatus.memoryPressure'
   ```

3. **Circuit Breaker State** (should be CLOSED)
   ```bash
   curl -H "Authorization: Bearer ADMIN_TOKEN" \
     http://localhost:3000/api/admin/session-cache/stats | \
     jq '.circuitBreaker.state'
   ```

### Setting Up Alerts

Consider setting up alerts for:

- ⚠️ Cache hit rate drops below 80%
- ⚠️ Memory pressure detected (true)
- ⚠️ Circuit breaker opens
- ⚠️ High eviction rate (> 10% of cache size)
- ⚠️ Frequent memory cleanups

## Common Operations

### Clear Cache Manually

If you need to force-refresh all sessions:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  http://localhost:3000/api/admin/session-cache/clear
```

This is useful after:
- User permission changes
- Major system updates
- Troubleshooting auth issues

### Graceful Shutdown

The cache automatically cleans up on server shutdown:

```bash
# Send SIGTERM or SIGINT
kill -TERM <pid>
# or
Ctrl+C in terminal
```

You'll see: `[session-cache] INFO: Session manager shutdown complete`

## Troubleshooting

### Issue: Low Cache Hit Rate

**Check:**
1. Are sessions expiring too quickly? (increase TTL in sessionCache.mjs)
2. Are users logging out frequently? (expected behavior)
3. Multiple server instances? (cache is per-instance, consider Redis)

### Issue: Memory Pressure Warnings

**Check:**
1. Total server memory allocation
2. Other memory-intensive operations
3. Cache size configuration (reduce if needed)

**Resolution:**
- Memory pressure triggers automatic cache cleanup
- System will recover automatically
- Consider increasing server memory

### Issue: Circuit Breaker Opening

**Check:**
1. MongoDB connectivity
2. Better Auth service health
3. Network issues between services

**Resolution:**
- Circuit breaker will auto-retry after 30 seconds
- Fix underlying service issue
- Monitor for automatic recovery

### Issue: Authentication Failures

**Check:**
1. Better Auth configuration
2. MongoDB connection string
3. Session token validity

**Resolution:**
- Check Better Auth logs first
- Verify MongoDB is accessible
- Cache will not serve invalid sessions

## Advanced Configuration

### Adjusting Cache Sizes

Edit [`node/middleware/sessionCache.mjs`](node/middleware/sessionCache.mjs):

```javascript
// Default configuration
this.sessionCache = new BoundedLRUCache(1000, 30000)  // 1000 sessions, 30s TTL
this.requestCache = new BoundedLRUCache(500, 1000)    // 500 requests, 1s TTL
this.inflightCache = new BoundedLRUCache(100, 5000)   // 100 concurrent, 5s TTL

// For high-traffic scenarios (more users)
this.sessionCache = new BoundedLRUCache(5000, 30000)  // 5000 sessions
this.requestCache = new BoundedLRUCache(1000, 1000)   // 1000 requests

// For low-memory environments (fewer resources)
this.sessionCache = new BoundedLRUCache(500, 30000)   // 500 sessions
this.requestCache = new BoundedLRUCache(250, 1000)    // 250 requests
```

### Adjusting TTLs

```javascript
// Longer cache for stable sessions
this.sessionCache = new BoundedLRUCache(1000, 60000)  // 60s instead of 30s

// Shorter cache for frequently changing permissions
this.sessionCache = new BoundedLRUCache(1000, 15000)  // 15s instead of 30s
```

### Adjusting Circuit Breaker

```javascript
// More tolerant (allow more failures before opening)
new AuthCircuitBreaker(10, 30000)  // 10 failures instead of 5

// Less tolerant (open circuit faster)
new AuthCircuitBreaker(3, 60000)   // 3 failures, longer timeout
```

## Rollback Instructions

If you need to rollback to the non-cached version:

1. **Restore `node/middleware/auth.mjs`:**
   ```bash
   git checkout HEAD~1 node/middleware/auth.mjs
   ```

2. **Remove session cache file:**
   ```bash
   rm node/middleware/sessionCache.mjs
   ```

3. **Restore admin routes:**
   ```bash
   git checkout HEAD~1 node/routes/admin.mjs
   ```

4. **Restart server:**
   ```bash
   npm restart
   ```

## Migration Checklist

- [x] Session cache implementation created
- [x] Auth middleware updated to use cache
- [x] Admin endpoints added for monitoring
- [x] Documentation updated
- [x] Memory safety measures implemented
- [x] Circuit breaker protection added
- [x] Automatic cleanup configured
- [x] Graceful shutdown handling
- [ ] Test in development environment
- [ ] Monitor initial cache performance
- [ ] Deploy to production
- [ ] Set up monitoring alerts
- [ ] Document baseline metrics

## Support

For issues or questions:

1. Check [`docs/SESSION_CACHE.md`](SESSION_CACHE.md) for detailed documentation
2. Review server logs for error messages
3. Check cache statistics via admin endpoint
4. Verify Better Auth and MongoDB connectivity

The session cache is designed to be zero-configuration and self-managing for most use cases.
