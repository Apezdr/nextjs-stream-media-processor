import { createCategoryLogger } from '../lib/logger.mjs'
import { isValidWebhookId } from './webhookAuth.mjs'
import { sessionManager } from './sessionCache.mjs'

const logger = createCategoryLogger('auth-middleware')

/**
 * Extract the session token string from either an Authorization: Bearer header
 * or a nextjs-stream session cookie. Returns null if neither is present.
 * Used as the cache key in sessionManager and as the presence check before
 * making any DB calls.
 */
function extractSessionIdentifier(req) {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return req.headers.authorization.slice(7).trim()
  }
  const cookieHeader = req.headers.cookie
  if (cookieHeader) {
    // Match both plain and __Secure- prefixed variants of the session cookie
    const match = cookieHeader.match(/(?:__Secure-)?nextjs-stream\.session_token=([^;]+)/)
    if (match?.[1]) return decodeURIComponent(match[1])
  }
  return null
}

/**
 * Express middleware for authenticating users.
 * Validates the Bearer token issued by the Next.js / React Native auth frontend.
 * Clients must send: Authorization: Bearer <session.token>
 *
 * Now enhanced with multi-tier session caching:
 * - Request-level cache (1s TTL) for rapid consecutive requests
 * - Session-level cache (30s TTL) for general use
 * - Automatic request deduplication for concurrent requests
 */
export const authenticateUser = async (req, res, next) => {
  try {
    const origin = req.headers.origin || req.headers.referer || 'unknown'

    const sessionToken = extractSessionIdentifier(req)
    if (!sessionToken) {
      logger.warn(`No authentication provided from origin: ${origin}`)
      return res.status(401).json({
        error: 'No authentication provided',
        message: 'Provide a session cookie or Authorization: Bearer <token> header',
      })
    }

    // Use session manager with multi-tier caching
    const user = await sessionManager.getSession(sessionToken, req)

    if (!user) {
      return res.status(401).json({ error: 'Authentication failed', message: 'Invalid or expired session token' })
    }

    if (!user.approved && !user.admin) {
      return res.status(403).json({ error: 'User not approved for access' })
    }

    req.user = user
    logger.debug(`Authenticated user: ${user.email} (ID: ${user.id}) from origin: ${origin}`)
    next()
  } catch (error) {
    logger.error('Authentication error:', error)
    
    // Handle circuit breaker errors specially
    if (error.message?.includes('Circuit breaker')) {
      return res.status(503).json({
        error: 'Authentication service temporarily unavailable',
        message: 'Please try again shortly'
      })
    }
    
    res.status(500).json({ error: 'Authentication service error' })
  }
}

/**
 * Express middleware for checking admin privileges.
 * Must be used after authenticateUser.
 */
export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  if (!req.user.admin) {
    return res.status(403).json({ error: 'Admin privileges required' })
  }

  next()
}

/**
 * Express middleware for checking if user has full (non-limited) access.
 * Must be used after authenticateUser.
 */
export const requireFullAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  if (req.user.limitedAccess && !req.user.admin) {
    return res.status(403).json({ error: 'Full access required' })
  }

  next()
}

/**
 * Combined middleware — checks webhook first, then falls back to admin user auth.
 * Use for endpoints that accept either a webhook ID or an authenticated admin user.
 *
 * Flow:
 * 1. Valid x-webhook-id → grant access immediately (no DB call)
 * 2. Otherwise → validate Bearer token and verify admin role
 */
export const authenticateWebhookOrUser = async (req, res, next) => {
  // STEP 1: webhook check (fast, no database)
  const webhookId = req.headers['x-webhook-id']
  if (webhookId && isValidWebhookId(webhookId)) {
    req.isWebhook = true
    return next()
  }

  if (webhookId) {
    logger.warn(`Invalid webhook ID attempted, falling back to user authentication: ${webhookId.substring(0, 10)}...`)
  }

  // STEP 2: session token (Bearer header or session cookie)
  try {
    const origin = req.headers.origin || req.headers.referer || 'unknown'

    const sessionToken = extractSessionIdentifier(req)
    if (!sessionToken) {
      logger.warn(`No authentication provided from origin: ${origin}`)
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Either a valid webhook ID or admin user session is required',
        supportedMethods: [
          'x-webhook-id: <webhook-id> (recommended for automated services)',
          'Authorization: Bearer <token> (for admin users)',
          'Session cookie (for browser-based access)',
        ],
      })
    }
    
    // Use session manager with multi-tier caching
    const user = await sessionManager.getSession(sessionToken, req)

    if (!user) {
      return res.status(401).json({ error: 'Authentication failed', message: 'Invalid or expired session token' })
    }

    if (!user.approved && !user.admin) {
      return res.status(403).json({ error: 'User not approved for access' })
    }

    if (!user.admin) {
      return res.status(403).json({
        error: 'Admin privileges required',
        message: 'This endpoint requires either a valid webhook ID or admin user access',
      })
    }

    req.user = user
    logger.debug(`Authenticated admin user: ${user.email} (ID: ${user.id}) from origin: ${origin}`)
    next()
  } catch (error) {
    logger.error('Authentication error:', error)
    
    // Handle circuit breaker errors specially
    if (error.message?.includes('Circuit breaker')) {
      return res.status(503).json({
        error: 'Authentication service temporarily unavailable',
        message: 'Please try again shortly'
      })
    }
    
    res.status(500).json({ error: 'Authentication service error' })
  }
}

/**
 * Authorization middleware — allows either a valid webhook ID or an authenticated admin user.
 * Must be used AFTER authenticateUser or authenticateWebhookOrUser has populated req.user / req.isWebhook.
 */
export const requireWebhookOrAdmin = (req, res, next) => {
  const webhookId = req.headers['x-webhook-id']
  if (webhookId && isValidWebhookId(webhookId)) {
    return next()
  }

  if (req.user?.admin === true) {
    return next()
  }

  logger.warn(`Unauthorized request - no valid webhook ID or admin session. User: ${req.user ? req.user.email : 'none'}, Admin: ${req.user?.admin || false}`)
  return res.status(401).json({ error: 'Unauthorized' })
}

/**
 * Rate limiting middleware.
 * @param {number} maxRequests - Maximum requests per window (default: 100)
 * @param {number} windowMs - Time window in milliseconds (default: 60000 = 1 minute)
 */
export const createRateLimiter = (maxRequests = 100, windowMs = 60000) => {
  const rateLimiter = new Map()

  return (req, res, next) => {
    const userId = req.user?.id || req.ip
    const now = Date.now()
    const userRequests = rateLimiter.get(userId) || []

    const validRequests = userRequests.filter(time => now - time < windowMs)

    if (validRequests.length >= maxRequests) {
      logger.warn(`Rate limit exceeded for user ${req.user?.email || req.ip}`)
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil(windowMs / 1000),
      })
    }

    validRequests.push(now)
    rateLimiter.set(userId, validRequests)
    next()
  }
}
