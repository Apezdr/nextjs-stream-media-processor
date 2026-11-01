import { createCategoryLogger } from '../lib/logger.mjs';
import { recordWebhookCaller } from '../lib/requestCaller.mjs';
import { describeWebhookId } from '../lib/webhookIdRedaction.mjs';

const logger = createCategoryLogger('webhook-auth');

/**
 * The configured webhook IDs, each with the setting it came from.
 * Supports unlimited webhook IDs through incrementing numeric suffixes:
 * WEBHOOK_ID_1, WEBHOOK_ID_2, WEBHOOK_ID_3, etc.
 * Each environment variable can also contain comma-separated values
 * @returns {{ id: string, credential: string }[]}
 */
function configuredWebhookSlots() {
  const slots = [];

  // Check for unlimited number of numbered webhook IDs
  let index = 1;
  while (true) {
    const credential = `WEBHOOK_ID_${index}`;
    const webhookId = process.env[credential];

    // Stop when we don't find a webhook ID at the current index
    if (!webhookId) break;

    // Split by comma and add all IDs (supports comma-separated values)
    const idsFromEnv = webhookId.split(',')
      .map(id => id.trim())
      .filter(id => id);

    slots.push(...idsFromEnv.map(id => ({ id, credential })));
    index++;
  }

  if (slots.length === 0) {
    logger.warn('No webhook IDs configured for authentication');
  } else {
    logger.debug(`Found ${slots.length} valid webhook IDs from ${index - 1} environment variables`);
  }

  return slots;
}

/**
 * Gets all valid webhook IDs from environment variables
 * @returns {string[]} Array of all valid webhook IDs
 */
export function getAllValidWebhookIds() {
  return configuredWebhookSlots().map(slot => slot.id);
}

/**
 * The setting a webhook ID is configured in (`WEBHOOK_ID_2`), or null when it
 * isn't one: the name a span may carry in place of the ID.
 * @param {string} webhookId
 * @returns {string|null}
 */
export function matchWebhookId(webhookId) {
  if (!webhookId) return null;
  return configuredWebhookSlots().find(slot => slot.id === webhookId)?.credential ?? null;
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
  
  const slots = configuredWebhookSlots();

  if (slots.length === 0) {
    logger.error('No webhook IDs configured - unable to authenticate');
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'Webhook authentication is not properly configured'
    });
  }

  const credential = slots.find(slot => slot.id === providedWebhookId)?.credential;
  if (!credential) {
    logger.warn(`Unauthorized webhook request attempted with ID: ${describeWebhookId(providedWebhookId)}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid webhook ID'
    });
  }

  recordWebhookCaller(providedWebhookId, credential);
  logger.debug(`Webhook authenticated successfully with ID: ${describeWebhookId(providedWebhookId)}`);
  next();
}

/**
 * Check if a webhook ID is valid (non-middleware version)
 * @param {string} webhookId - The webhook ID to validate
 * @returns {boolean} True if the webhook ID is valid
 */
export function isValidWebhookId(webhookId) {
  return matchWebhookId(webhookId) !== null;
}