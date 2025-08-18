import { createCategoryLogger } from '../lib/logger.mjs';

const logger = createCategoryLogger('webhook-auth');

/**
 * Gets all valid webhook IDs from environment variables
 * Supports unlimited webhook IDs through incrementing numeric suffixes:
 * WEBHOOK_ID_1, WEBHOOK_ID_2, WEBHOOK_ID_3, etc.
 * Each environment variable can also contain comma-separated values
 * @returns {string[]} Array of all valid webhook IDs
 */
export function getAllValidWebhookIds() {
  const validWebhookIds = [];
  
  // Check for unlimited number of numbered webhook IDs
  let index = 1;
  while (true) {
    const webhookId = process.env[`WEBHOOK_ID_${index}`];
    
    // Stop when we don't find a webhook ID at the current index
    if (!webhookId) break;
    
    // Split by comma and add all IDs (supports comma-separated values)
    const idsFromEnv = webhookId.split(',')
      .map(id => id.trim())
      .filter(id => id);
    
    validWebhookIds.push(...idsFromEnv);
    index++;
  }
  
  if (validWebhookIds.length === 0) {
    logger.warn('No webhook IDs configured for authentication');
  } else {
    logger.debug(`Found ${validWebhookIds.length} valid webhook IDs from ${index - 1} environment variables`);
  }
  
  return validWebhookIds;
}

/**
 * Express middleware for webhook authentication
 * Validates the X-Webhook-ID header against all configured webhook IDs
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function validateWebhookAuth(req, res, next) {
  const providedWebhookId = req.headers['x-webhook-id'];
  
  if (!providedWebhookId) {
    logger.warn('Webhook authentication attempted without X-Webhook-ID header');
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'X-Webhook-ID header is required'
    });
  }
  
  const validWebhookIds = getAllValidWebhookIds();
  
  if (validWebhookIds.length === 0) {
    logger.error('No webhook IDs configured - unable to authenticate');
    return res.status(500).json({ 
      error: 'Server configuration error',
      message: 'Webhook authentication is not properly configured'
    });
  }
  
  if (!validWebhookIds.includes(providedWebhookId)) {
    logger.warn(`Unauthorized webhook request attempted with ID: ${providedWebhookId.substring(0, 8)}...`);
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Invalid webhook ID'
    });
  }
  
  logger.debug(`Webhook authenticated successfully with ID: ${providedWebhookId.substring(0, 8)}...`);
  next();
}

/**
 * Check if a webhook ID is valid (non-middleware version)
 * @param {string} webhookId - The webhook ID to validate
 * @returns {boolean} True if the webhook ID is valid
 */
export function isValidWebhookId(webhookId) {
  if (!webhookId) return false;
  
  const validWebhookIds = getAllValidWebhookIds();
  return validWebhookIds.includes(webhookId);
}