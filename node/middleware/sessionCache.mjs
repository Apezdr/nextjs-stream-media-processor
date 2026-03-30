import { fromNodeHeaders } from 'better-auth/node'
import { createCategoryLogger } from '../lib/logger.mjs'
import { auth } from '../lib/auth.mjs'

const logger = createCategoryLogger('session-cache')

/**
 * Bounded LRU Cache with TTL
 * Prevents unbounded memory growth with hard size limits and automatic eviction
 */
class BoundedLRUCache {
  constructor(maxSize = 1000, ttl = 30000) {
    this.maxSize = maxSize
    this.ttl = ttl
    this.cache = new Map()
    this.accessOrder = new Map() // timestamp tracking for LRU
  }

  get(key) {
    const item = this.cache.get(key)
    if (!item) return null

    // Check if expired
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key)
      this.accessOrder.delete(key)
      return null
    }

    // Update access time for LRU
    this.accessOrder.set(key, Date.now())
    return item.value
  }

  set(key, value) {
    const now = Date.now()
    
    // Remove oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictOldest()
    }

    this.cache.set(key, { value, timestamp: now })
    this.accessOrder.set(key, now)
  }

  evictOldest() {
    // Find least recently accessed item
    let oldest = null
    let oldestTime = Infinity
    
    for (const [key, time] of this.accessOrder) {
      if (time < oldestTime) {
        oldestTime = time
        oldest = key
      }
    }

    if (oldest) {
      this.cache.delete(oldest)
      this.accessOrder.delete(oldest)
      logger.debug(`Evicted LRU cache entry: ${oldest.substring(0, 10)}...`)
    }
  }

  clear() {
    this.cache.clear()
    this.accessOrder.clear()
  }

  size() {
    return this.cache.size
  }

  // Remove expired entries
  cleanup() {
    const now = Date.now()
    const toDelete = []

    for (const [key, item] of this.cache) {
      if (now - item.timestamp > this.ttl) {
        toDelete.push(key)
      }
    }

    for (const key of toDelete) {
      this.cache.delete(key)
      this.accessOrder.delete(key)
    }

    return toDelete.length
  }
}

/**
 * Memory-Aware Session Cache with adaptive behavior
 * Monitors memory pressure and adjusts caching strategy accordingly
 */
class MemoryAwareSessionCache {
  constructor() {
    this.sessionCache = new BoundedLRUCache(1000, 30000) // 1000 sessions, 30s TTL
    this.inflightCache = new BoundedLRUCache(100, 5000)   // 100 concurrent, 5s TTL
    this.requestCache = new BoundedLRUCache(500, 1000)    // 500 requests, 1s TTL
    
    this.memoryPressure = false
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      memoryCleanups: 0,
      lastCleanup: null
    }

    this.memoryMonitor = null
    this.cleanupScheduler = null

    this.initializeMemoryMonitoring()
    this.initializeCleanupScheduler()
  }

  initializeMemoryMonitoring() {
    // Check memory every 30 seconds
    this.memoryMonitor = setInterval(() => {
      if (process.memoryUsage) {
        const usage = process.memoryUsage()
        const heapUsedMB = usage.heapUsed / 1024 / 1024
        const heapTotalMB = usage.heapTotal / 1024 / 1024
        
        // Consider memory pressure if heap used > 80% of total or > 500MB
        const wasUnderPressure = this.memoryPressure
        this.memoryPressure = (heapUsedMB / heapTotalMB > 0.8) || (heapUsedMB > 500)
        
        if (this.memoryPressure && !wasUnderPressure) {
          logger.warn(`Memory pressure detected: ${heapUsedMB.toFixed(1)}MB used (${((heapUsedMB / heapTotalMB) * 100).toFixed(1)}% of heap)`)
          this.handleMemoryPressure()
        } else if (!this.memoryPressure && wasUnderPressure) {
          logger.info('Memory pressure relieved')
        }
      }
    }, 30000)
  }

  handleMemoryPressure() {
    // Aggressively clean caches under memory pressure
    const sessionCleared = this.sessionCache.cleanup()
    const inflightCleared = this.inflightCache.cleanup()
    const requestCleared = this.requestCache.cleanup()
    
    this.stats.memoryCleanups++
    this.stats.lastCleanup = new Date().toISOString()
    
    logger.info(`Emergency cache cleanup: ${sessionCleared + inflightCleared + requestCleared} entries removed`)
    
    // If still under pressure, clear everything
    if (this.memoryPressure) {
      this.sessionCache.clear()
      this.inflightCache.clear()
      this.requestCache.clear()
      logger.warn('Full cache clear due to severe memory pressure')
    }
  }

  initializeCleanupScheduler() {
    // Regular cleanup every 5 minutes
    this.cleanupScheduler = setInterval(() => {
      if (!this.memoryPressure) { // Skip if under memory pressure (already cleaned)
        const cleaned = this.sessionCache.cleanup() + 
                        this.inflightCache.cleanup() + 
                        this.requestCache.cleanup()
        
        if (cleaned > 0) {
          logger.debug(`Regular cache cleanup: ${cleaned} expired entries removed`)
          this.stats.lastCleanup = new Date().toISOString()
        }
      }
    }, 5 * 60 * 1000)
  }

  // Graceful degradation
  shouldUseCache() {
    return !this.memoryPressure
  }

  shutdown() {
    if (this.memoryMonitor) clearInterval(this.memoryMonitor)
    if (this.cleanupScheduler) clearInterval(this.cleanupScheduler)
    this.sessionCache.clear()
    this.inflightCache.clear()
    this.requestCache.clear()
  }
}

/**
 * Circuit Breaker for Auth Service Protection
 * Prevents cascade failures and service overload
 */
class AuthCircuitBreaker {
  constructor(failureThreshold = 5, timeout = 30000) {
    this.failureCount = 0
    this.failureThreshold = failureThreshold
    this.timeout = timeout
    this.state = 'CLOSED' // CLOSED (normal), OPEN (failing), HALF_OPEN (testing)
    this.nextAttempt = null
    this.lastFailure = null
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error(`Circuit breaker is OPEN. Auth service unavailable until ${new Date(this.nextAttempt).toISOString()}`)
      }
      this.state = 'HALF_OPEN'
      logger.info('Circuit breaker entering HALF_OPEN state, testing auth service...')
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure(error)
      throw error
    }
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      logger.info('Circuit breaker closing after successful auth')
    }
    this.failureCount = 0
    this.state = 'CLOSED'
    this.nextAttempt = null
    this.lastFailure = null
  }

  onFailure(error) {
    this.failureCount++
    this.lastFailure = new Date().toISOString()
    
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN'
      this.nextAttempt = Date.now() + this.timeout
      logger.error(`Circuit breaker OPENED after ${this.failureCount} failures. Next attempt at ${new Date(this.nextAttempt).toISOString()}`)
    } else {
      logger.warn(`Auth failure ${this.failureCount}/${this.failureThreshold}: ${error.message}`)
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      nextAttempt: this.nextAttempt ? new Date(this.nextAttempt).toISOString() : null,
      lastFailure: this.lastFailure
    }
  }
}

/**
 * Production Session Manager
 * Comprehensive session caching with memory safety and monitoring
 */
class ProductionSessionManager {
  constructor() {
    this.cache = new MemoryAwareSessionCache()
    this.circuitBreaker = new AuthCircuitBreaker(5, 30000)
    this.inflightRequests = new Map() // token -> { promise, timestamp }
    
    // Bounded inflight tracking with automatic cleanup
    this.inflightCleanup = setInterval(() => this.cleanupInflight(), 10000) // Every 10 seconds
  }

  cleanupInflight() {
    const now = Date.now()
    const staleThreshold = 30000 // 30 seconds
    let cleaned = 0
    
    for (const [token, { timestamp }] of this.inflightRequests) {
      if (now - timestamp > staleThreshold) {
        logger.warn(`Cleaning up stale inflight auth request for token: ${token.substring(0, 10)}...`)
        this.inflightRequests.delete(token)
        cleaned++
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} stale inflight auth requests`)
    }
  }

  async getSession(sessionToken, req) {
    // Validate token format to prevent cache pollution
    if (!sessionToken || sessionToken.length < 10 || sessionToken.length > 200) {
      throw new Error('Invalid token format')
    }

    // Quick request-level cache check (sub-second granularity)
    const requestKey = `${sessionToken}:${Math.floor(Date.now() / 1000)}`
    if (this.cache.shouldUseCache()) {
      const cached = this.cache.requestCache.get(requestKey)
      if (cached) {
        this.cache.stats.hits++
        return cached
      }

      // Check session-level cache (30 second TTL)
      const sessionCached = this.cache.sessionCache.get(sessionToken)
      if (sessionCached) {
        this.cache.stats.hits++
        this.cache.requestCache.set(requestKey, sessionCached)
        return sessionCached
      }
    }

    // Check inflight with bounded tracking
    if (this.inflightRequests.has(sessionToken)) {
      const { promise } = this.inflightRequests.get(sessionToken)
      logger.debug('Deduplicating concurrent auth request')
      return await promise
    }

    // Prevent inflight request accumulation
    if (this.inflightRequests.size > 50) {
      logger.warn(`Too many inflight auth requests (${this.inflightRequests.size}), clearing`)
      this.inflightRequests.clear()
    }

    // Create bounded promise with circuit breaker protection
    const authPromise = this.circuitBreaker.execute(async () => {
      return await this.resolveSessionFromAuth(sessionToken, req)
    })

    // Track with timestamp for cleanup
    this.inflightRequests.set(sessionToken, {
      promise: authPromise,
      timestamp: Date.now()
    })

    try {
      const user = await authPromise
      
      // Cache successful auth
      if (user && this.cache.shouldUseCache()) {
        this.cache.sessionCache.set(sessionToken, user)
        this.cache.requestCache.set(requestKey, user)
      }

      this.cache.stats.misses++
      return user
    } finally {
      this.inflightRequests.delete(sessionToken)
    }
  }

  async resolveSessionFromAuth(sessionToken, req) {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers)
      })

      if (!session?.user) return null

      const u = session.user
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        image: u.image,
        approved: u.approved ?? false,
        limitedAccess: u.limitedAccess ?? false,
        admin: u.role === 'admin',
      }
    } catch (error) {
      logger.error(`Failed to resolve session from Better Auth: ${error.message}`)
      throw error
    }
  }

  getStats() {
    const totalRequests = this.cache.stats.hits + this.cache.stats.misses
    const hitRate = totalRequests > 0 ? (this.cache.stats.hits / totalRequests * 100).toFixed(2) : 0

    return {
      cacheStats: {
        hits: this.cache.stats.hits,
        misses: this.cache.stats.misses,
        hitRate: `${hitRate}%`,
        evictions: this.cache.stats.evictions,
        memoryCleanups: this.cache.stats.memoryCleanups,
        lastCleanup: this.cache.stats.lastCleanup
      },
      cacheSizes: {
        sessionCache: this.cache.sessionCache.size(),
        requestCache: this.cache.requestCache.size(),
        inflightRequests: this.inflightRequests.size
      },
      memoryStatus: {
        memoryPressure: this.cache.memoryPressure,
        heapUsed: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB`
      },
      circuitBreaker: this.circuitBreaker.getState()
    }
  }

  // Manual cache control
  clearCache() {
    this.cache.sessionCache.clear()
    this.cache.requestCache.clear()
    this.cache.inflightCache.clear()
    logger.info('Session cache manually cleared')
  }

  // Graceful shutdown
  shutdown() {
    if (this.inflightCleanup) clearInterval(this.inflightCleanup)
    this.cache.shutdown()
    this.inflightRequests.clear()
    logger.info('Session manager shutdown complete')
  }
}

// Singleton instance
export const sessionManager = new ProductionSessionManager()

// Graceful shutdown handling
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down session manager...')
  sessionManager.shutdown()
})

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down session manager...')
  sessionManager.shutdown()
})
