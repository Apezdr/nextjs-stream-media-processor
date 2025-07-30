import { createCategoryLogger } from '../lib/logger.mjs';
import {
  authenticateWithMobileToken,
  authenticateWithSessionToken
} from '../database.mjs';

const logger = createCategoryLogger('auth-middleware');

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
    
    // Extract session token from cookies (Next.js session)
    const cookies = req.headers.cookie;
    let sessionTokenFromCookie = null;
    
    if (cookies) {
      // Look for authjs session token in cookies (matches your format)
      const sessionCookieMatch = cookies.match(/__Secure-authjs\.session-token=([^;]+)/);
      const sessionCookieAltMatch = cookies.match(/next-auth\.session-token=([^;]+)/);
      
      sessionTokenFromCookie = sessionCookieMatch?.[1] || sessionCookieAltMatch?.[1];
      
      if (sessionTokenFromCookie) {
        // URL decode the cookie value
        sessionTokenFromCookie = decodeURIComponent(sessionTokenFromCookie);
        logger.debug(`Found session token in cookie: ${sessionTokenFromCookie.substring(0, 10)}...`);
      }
    }
    
    if (!authHeader && !sessionToken && !mobileToken && !sessionTokenFromCookie) {
      return res.status(401).json({
        error: 'No authentication provided',
        debug: 'Expected Authorization header, x-session-token header, x-mobile-token header, or session cookie'
      });
    }

    let user = null;
    
    // Handle mobile token authentication
    if (mobileToken) {
      logger.debug('Attempting mobile token authentication');
      user = await authenticateWithMobileToken(mobileToken);
    }
    
    // Handle regular session token authentication (headers)
    if (!user && (authHeader || sessionToken)) {
      const token = authHeader?.replace('Bearer ', '') || sessionToken;
      
      if (!token) {
        return res.status(401).json({ error: 'Invalid token format' });
      }

      logger.debug('Attempting header token authentication');
      user = await authenticateWithSessionToken(token);
    }
    
    // Handle session token from cookies (Next.js session)
    if (!user && sessionTokenFromCookie) {
      logger.debug('Attempting cookie session authentication');
      user = await authenticateWithSessionToken(sessionTokenFromCookie);
    }
    
    if (!user) {
      return res.status(401).json({
        error: 'Authentication failed',
        debug: 'No valid session found in headers or cookies'
      });
    }
    
    // Check if user is approved
    if (!user.approved && !user.admin) {
      return res.status(403).json({ error: 'User not approved for access' });
    }
    
    // Add user info to request
    req.user = user;
    
    logger.info(`Authenticated user: ${user.email} (ID: ${user.id})`);
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