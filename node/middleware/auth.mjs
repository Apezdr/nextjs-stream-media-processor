import { createCategoryLogger } from '../lib/logger.mjs';
import {
  authenticateWithMobileToken,
  authenticateWithSessionToken
} from '../database.mjs';

/**
 * Detect if a token is a mobile-auth JWT
 * @param {string} token - JWT token to check
 * @returns {boolean} True if the token is a mobile-auth JWT, false otherwise
 */
const isMobileAuthJwt = (token) => {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return payload.type === 'mobile-auth';
  } catch {
    return false;
  }
};
import { sessionCache } from './sessionCache.mjs';
import { isValidWebhookId } from './webhookAuth.mjs';

const logger = createCategoryLogger('auth-middleware');

// Enhanced cookie extraction for cross-domain scenarios
const extractSessionTokenFromCookies = (cookies) => {
  if (!cookies) return null;
  
  // Try multiple cookie patterns for better compatibility
  const patterns = [
    /__Secure-authjs\.session-token=([^;]+)/,
    /next-auth\.session-token=([^;]+)/,
    /authjs\.session-token=([^;]+)/,
    /session-token=([^;]+)/
  ];
  
  for (const pattern of patterns) {
    const match = cookies.match(pattern);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch (error) {
        logger.warn(`Failed to decode cookie value: ${error.message}`);
      }
    }
  }
  
  return null;
};

/**
 * Extract authentication credentials from request headers
 * Returns token, authMethod, and isMobileToken flag
 */
const extractAuthCredentials = (req) => {
  const authHeader = req.headers.authorization;
  const sessionToken = req.headers['x-session-token'];
  let mobileToken = req.headers['x-mobile-token'];
  const sessionTokenFromCookie = extractSessionTokenFromCookies(req.headers.cookie);
  
  let token = null;
  let authMethod = null;
  let isMobileToken = false;
  
  if (mobileToken) {
    token = mobileToken;
    authMethod = 'x-mobile-token header';
    isMobileToken = true;
  } else if (authHeader) {
    token = authHeader.replace('Bearer ', '');
    if (isMobileAuthJwt(token)) {
      authMethod = 'Authorization header (mobile-auth)';
      isMobileToken = true;
    } else {
      authMethod = 'Authorization header';
    }
  } else if (sessionToken) {
    token = sessionToken;
    authMethod = 'x-session-token header';
  } else if (sessionTokenFromCookie) {
    token = sessionTokenFromCookie;
    authMethod = 'session cookie';
  }
  
  return { token, authMethod, isMobileToken, hasAnyAuth: !!(authHeader || sessionToken || mobileToken || sessionTokenFromCookie) };
};

/**
 * Build the user data object to cache
 */
const buildUserCacheData = (user) => ({
  id: user.id,
  email: user.email,
  admin: user.admin,
  approved: user.approved,
  limitedAccess: user.limitedAccess
});

/**
 * Authenticate user with token, using cache when appropriate
 */
const authenticateUserWithToken = async (token, isMobileToken, authMethod, isDebugMode = false) => {
  let user = null;
  
  if (isMobileToken) {
    // Mobile tokens bypass cache - use direct authentication
    if (isDebugMode) {
      logger.debug('Attempting mobile token authentication (bypassing cache)');
    }
    user = await authenticateWithMobileToken(token);
  } else {
    // Try cache for session tokens
    const cachedUser = sessionCache.get(token);
    
    if (cachedUser) {
      user = cachedUser;
      if (isDebugMode) {
        logger.debug(`Cache hit for user: ${user.email}`);
      }
    } else {
      // Cache miss - query database
      if (isDebugMode) {
        logger.debug(`Cache miss - authenticating via ${authMethod}`);
      }
      
      // If this is a mobile-auth JWT, use mobile token authentication
      if (isMobileAuthJwt(token)) {
        user = await authenticateWithMobileToken(token);
      } else {
        user = await authenticateWithSessionToken(token);
      }
      
      // Cache the authenticated user (only essential fields)
      if (user) {
        const userToCache = buildUserCacheData(user);
        sessionCache.set(token, userToCache);
        if (isDebugMode) {
          logger.debug(`User cached: ${user.email}`);
        }
      }
    }
  }
  
  return user;
};

/**
 * Build standard "no authentication provided" error response
 */
const buildNoAuthProvidedError = (origin, isCrossDomain) => {
  const corsAdvice = isCrossDomain ?
    'For cross-domain requests, use Authorization header or x-session-token header instead of cookies.' :
    'For same-domain requests, session cookies should work automatically.';
  
  return {
    error: 'No authentication provided',
    message: 'Authentication is required to access this endpoint.',
    crossDomainAdvice: corsAdvice,
    supportedMethods: [
      'Authorization: Bearer <token> (recommended for cross-domain)',
      'x-session-token: <token> (alternative for cross-domain)',
      'x-mobile-token: <token> (for mobile apps)',
      'Cookie: session-token=<token> (same-domain only)'
    ],
    origin: origin,
    isCrossDomain: isCrossDomain,
    documentation: {
      cors: 'Cross-domain requests require explicit headers due to browser security policies',
      headers: 'Include your session token in Authorization header: "Authorization: Bearer YOUR_TOKEN"'
    }
  };
};

/**
 * Express middleware for authenticating Next.js frontend users
 * Supports multiple authentication methods:
 * - Authorization header with Bearer token
 * - x-session-token header
 * - x-mobile-token header
 * - Next.js session cookies
 */
export const authenticateUser = async (req, res, next) => {
  try {
    const path = req.originalUrl || req.url;
    const origin = req.headers.origin || req.headers.referer || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    // Extract credentials from request
    const { token, authMethod, isMobileToken, hasAnyAuth } = extractAuthCredentials(req);
    
    const sessionTokenFromCookie = extractSessionTokenFromCookies(req.headers.cookie);
    if (sessionTokenFromCookie) {
      logger.debug(`Found session token in cookie: ${sessionTokenFromCookie.substring(0, 10)}...`);
    }

    logger.debug(`Auth attempt: ${req.method} ${path} origin=${origin}`);
    logger.debug(`Authentication attempt from origin: ${origin}, User-Agent: ${userAgent.substring(0, 50)}...`);
    
    // Check if any authentication was provided
    if (!hasAnyAuth) {
      logger.warn(`No authentication provided from origin: ${origin}`);
      const isCrossDomain = origin && origin !== 'unknown' && !origin.includes('localhost');
      return res.status(401).json(buildNoAuthProvidedError(origin, isCrossDomain));
    }

    if (!token) {
      return res.status(401).json({ error: 'Invalid token format' });
    }
    
    // Authenticate the user with token
    const user = await authenticateUserWithToken(token, isMobileToken, authMethod, false);
    
    if (!user) {
      const isCrossDomain = origin && origin !== 'unknown' && !origin.includes('localhost');
      const failureAdvice = isCrossDomain ?
        'Cross-domain authentication failed. Ensure you are sending a valid token in the Authorization header.' :
        'Authentication failed. Check your session token or login again.';
        
      return res.status(401).json({
        error: 'Authentication failed',
        message: failureAdvice,
        debug: 'No valid session found in headers or cookies',
        isCrossDomain: isCrossDomain
      });
    }
    
    // Check if user is approved
    if (!user.approved && !user.admin) {
      return res.status(403).json({ error: 'User not approved for access' });
    }
    
    // Add user info to request
    req.user = user;
    
    // Log successful authentication
    logger.debug(`Authenticated user: ${user.email} (ID: ${user.id}) via ${authMethod} from origin: ${origin}`);
    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication service error' });
  }
};

/**
 * Express middleware for checking admin privileges
 * Must be used after authenticateUser middleware
 */
export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (!req.user.admin) {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  
  next();
};

/**
 * Express middleware for checking if user has full access (not limited)
 * Must be used after authenticateUser middleware
 */
export const requireFullAccess = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (req.user.limitedAccess && !req.user.admin) {
    return res.status(403).json({ error: 'Full access required' });
  }
  
  next();
};

/**
 * Combined authentication middleware - checks webhook FIRST, then falls back to admin user authentication
 * This middleware handles both webhook and user authentication in the correct order.
 *
 * Flow:
 * 1. Check webhook (fast, no database) - if valid, grant access immediately
 * 2. Fall back to user authentication and verify admin privileges
 *
 * Use this for endpoints that require either webhook OR admin user access.
 */
export const authenticateWebhookOrUser = async (req, res, next) => {
  const isDebugMode = process.env.DEBUG === 'TRUE';
  
  // STEP 1: Check webhook authentication FIRST (fast, no database request)
  const webhookId = req.headers['x-webhook-id'];
  if (webhookId && isValidWebhookId(webhookId)) {
    if (isDebugMode) {
      logger.debug('Access granted via webhook authentication');
    }
    req.isWebhook = true;
    return next();
  }
  
  // STEP 2: Webhook not provided or invalid - fall back to user authentication
  if (webhookId) {
    logger.warn(`Invalid webhook ID attempted, falling back to user authentication: ${webhookId.substring(0, 10)}...`);
  }
  
  try {
    const origin = req.headers.origin || req.headers.referer || 'unknown';
    
    // Extract credentials from request
    const { token, authMethod, isMobileToken, hasAnyAuth } = extractAuthCredentials(req);
    
    if (!hasAnyAuth) {
      logger.warn(`No authentication provided from origin: ${origin}`);
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Either a valid webhook ID or admin user session is required',
        supportedMethods: [
          'x-webhook-id: <webhook-id> (recommended for automated services)',
          'Authorization: Bearer <token> (for admin users)',
          'x-session-token: <token> (for admin users)',
          'Cookie: session-token=<token> (for admin users - same-domain only)'
        ]
      });
    }

    if (!token) {
      return res.status(401).json({ error: 'Invalid token format' });
    }
    
    // Authenticate the user with token
    const user = await authenticateUserWithToken(token, isMobileToken, authMethod, isDebugMode);
    
    if (!user) {
      return res.status(401).json({
        error: 'Authentication failed',
        message: 'Invalid or expired session token'
      });
    }
    
    // Check if user is approved
    if (!user.approved && !user.admin) {
      return res.status(403).json({ error: 'User not approved for access' });
    }
    
    // CRITICAL: User must be admin for this combined middleware
    if (!user.admin) {
      return res.status(403).json({
        error: 'Admin privileges required',
        message: 'This endpoint requires either a valid webhook ID or admin user access'
      });
    }
    
    // User is authenticated and is admin
    req.user = user;
    logger.debug(`Authenticated admin user: ${user.email} (ID: ${user.id}) via ${authMethod} from origin: ${origin}`);
    
    if (isDebugMode) {
      logger.debug(`Access granted via admin user: ${user.email}`);
    }
    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication service error' });
  }
};

/**
 * Combined authorization middleware - allows either webhook OR admin user
 * Useful for endpoints that should be accessible from both automated services and admin panel
 * NOTE: This should be used AFTER authenticateUser or authenticateWebhookOrUser has run
 */
export const requireWebhookOrAdmin = (req, res, next) => {
  const isDebugMode = process.env.DEBUG === 'TRUE';
  
  // Debug logging to investigate req.user
  if (isDebugMode) {
    logger.debug(`requireWebhookOrAdmin check - req.user: ${JSON.stringify(req.user)}, webhook ID: ${req.headers['x-webhook-id']}`);
  }
  
  // Check for webhook authentication first
  const webhookId = req.headers['x-webhook-id'];
  if (webhookId && isValidWebhookId(webhookId)) {
    if (isDebugMode) {
      logger.debug('Access granted via webhook authentication');
    }
    return next();
  }
  
  // If no valid webhook, check for admin authentication
  // Note: req.user.admin is a boolean, not req.user.role
  if (req.user && req.user.admin === true) {
    if (isDebugMode) {
      logger.debug(`Access granted via admin authentication: ${req.user.email}`);
    }
    return next();
  }
  
  // Neither authentication method succeeded
  logger.warn(`Unauthorized request - no valid webhook ID or admin session. User: ${req.user ? req.user.email : 'none'}, Admin: ${req.user?.admin || false}`);
  return res.status(401).json({ error: 'Unauthorized' });
};

/**
 * Rate limiting middleware
 * @param {number} maxRequests - Maximum requests per window (default: 100)
 * @param {number} windowMs - Time window in milliseconds (default: 60000 = 1 minute)
 */
export const createRateLimiter = (maxRequests = 100, windowMs = 60000) => {
  const rateLimiter = new Map();
  
  return (req, res, next) => {
    const userId = req.user?.id || req.ip;
    const now = Date.now();
    const userRequests = rateLimiter.get(userId) || [];
    
    // Remove old requests outside the window
    const validRequests = userRequests.filter(time => now - time < windowMs);
    
    if (validRequests.length >= maxRequests) {
      logger.warn(`Rate limit exceeded for user ${req.user?.email || req.ip}`);
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }
    
    validRequests.push(now);
    rateLimiter.set(userId, validRequests);
    next();
  };
};