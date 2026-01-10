import { createCategoryLogger } from '../lib/logger.mjs';
import {
  authenticateWithMobileToken,
  authenticateWithSessionToken
} from '../database.mjs';
import { sessionCache } from './sessionCache.mjs';

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
 * Express middleware for authenticating Next.js frontend users
 * Supports multiple authentication methods:
 * - Authorization header with Bearer token
 * - x-session-token header
 * - x-mobile-token header
 * - Next.js session cookies
 */
export const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const sessionToken = req.headers['x-session-token'];
    const mobileToken = req.headers['x-mobile-token'];
    
    // Enhanced cookie extraction
    const sessionTokenFromCookie = extractSessionTokenFromCookies(req.headers.cookie);
    
    // Log authentication attempt for debugging
    const origin = req.headers.origin || req.headers.referer || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    if (sessionTokenFromCookie) {
      logger.debug(`Found session token in cookie: ${sessionTokenFromCookie.substring(0, 10)}...`);
    }
    
    logger.debug(`Authentication attempt from origin: ${origin}, User-Agent: ${userAgent.substring(0, 50)}...`);
    
    if (!authHeader && !sessionToken && !mobileToken && !sessionTokenFromCookie) {
      logger.warn(`No authentication provided from origin: ${origin}`);
      
      // Determine if this is likely a cross-domain request
      const isCrossDomain = origin && origin !== 'unknown' && !origin.includes('localhost');
      const corsAdvice = isCrossDomain ?
        'For cross-domain requests, use Authorization header or x-session-token header instead of cookies.' :
        'For same-domain requests, session cookies should work automatically.';
      
      return res.status(401).json({
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
      });
    }

    let user = null;
    let token = null;
    let authMethod = null;
    
    // Extract the token and determine auth method
    if (mobileToken) {
      token = mobileToken;
      authMethod = 'x-mobile-token header';
    } else if (authHeader) {
      token = authHeader.replace('Bearer ', '');
      authMethod = 'Authorization header';
    } else if (sessionToken) {
      token = sessionToken;
      authMethod = 'x-session-token header';
    } else if (sessionTokenFromCookie) {
      token = sessionTokenFromCookie;
      authMethod = 'session cookie';
    }
    
    if (!token) {
      return res.status(401).json({ error: 'Invalid token format' });
    }
    
    // CHECK CACHE FIRST (skip for mobile tokens as they use different auth logic)
    if (mobileToken) {
      // Mobile tokens bypass cache - use direct authentication
      logger.debug('Attempting mobile token authentication (bypassing cache)');
      user = await Promise.all([authenticateWithMobileToken(mobileToken)]).then(results => results[0]);
    } else {
      // Try cache for session tokens
      const cachedUser = sessionCache.get(token);
      
      if (cachedUser) {
        // CACHE HIT - Use cached user data
        user = cachedUser;
        logger.debug(`Cache hit for user: ${user.email}`);
      } else {
        // CACHE MISS - Query database
        logger.debug(`Cache miss - authenticating via ${authMethod}`);
        user = await authenticateWithSessionToken(token);
        
        // Cache the authenticated user (only essential fields)
        if (user) {
          const userToCache = {
            id: user.id,
            email: user.email,
            admin: user.admin,
            approved: user.approved,
            limitedAccess: user.limitedAccess
          };
          sessionCache.set(token, userToCache);
          logger.debug(`User cached: ${user.email}`);
        }
      }
    }
    
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
    logger.info(`Authenticated user: ${user.email} (ID: ${user.id}) via ${authMethod} from origin: ${origin}`);
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