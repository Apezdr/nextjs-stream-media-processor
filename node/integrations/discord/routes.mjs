import express from 'express';
import { verifyKey } from 'discord-interactions';
import { createCategoryLogger } from '../../lib/logger.mjs';
import { sendIntroductionDM } from './utils/introductionDM.mjs';

const logger = createCategoryLogger('discordWebhookEvents');
const isDebugMode = process.env.DEBUG === 'TRUE';

// Store seen event IDs for idempotency (prevent duplicate processing)
const processedEvents = new Set();
const MAX_PROCESSED_EVENTS = 1000; // Limit memory usage

/**
 * Initialize and configure Discord webhook routes
 * @returns {object} Configured Express router
 */
export function setupDiscordRoutes() {
  const router = express.Router();

/**
 * Discord Webhook Events endpoint
 * Handles APPLICATION_AUTHORIZED events to send intro DMs immediately when users authorize the app
 * 
 * Required environment variables:
 * - DISCORD_PUBLIC_KEY: Your Discord app's public key (for signature verification)
 * - NOTIFICATION_X_TYPE=discord_bot: At least one bot notification configured
 * - DISCORD_NOTIFY_USERS: Comma-separated user IDs to notify
 */
router.post('/discord/events', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    
    if (!publicKey) {
      logger.error('DISCORD_PUBLIC_KEY not configured - cannot verify webhook events');
      return res.status(500).json({ error: 'Server configuration error' });
    }
    
    // Get signature headers
    const signature = req.get('X-Signature-Ed25519');
    const timestamp = req.get('X-Signature-Timestamp');
    
    if (!signature || !timestamp) {
      logger.warn('Missing signature headers in Discord webhook event');
      return res.status(401).json({ error: 'Missing signature' });
    }
    
    // Verify the request signature (must use raw buffer, not string)
    let rawBody = req.body;
    
    // Check if body is a Buffer, if not, convert it
    if (!Buffer.isBuffer(rawBody)) {
      logger.warn('⚠️ Body is not a Buffer, converting...');
      logger.warn(`Body type: ${typeof rawBody}`);
      
      if (typeof rawBody === 'string') {
        rawBody = Buffer.from(rawBody, 'utf8');
      } else if (typeof rawBody === 'object') {
        rawBody = Buffer.from(JSON.stringify(rawBody), 'utf8');
      } else {
        logger.error('❌ Cannot convert body to Buffer');
        return res.status(400).send('Invalid request body');
      }
    }
    
    logger.info(`Body is Buffer: ${Buffer.isBuffer(rawBody)}, length: ${rawBody.length} bytes`);
    
    const isValid = await verifyKey(rawBody, signature, timestamp, publicKey);
    
    if (!isValid) {
      logger.warn('❌ Invalid signature in Discord webhook event');
      logger.warn(`Signature: ${signature.substring(0, 20)}...`);
      logger.warn(`Timestamp: ${timestamp}`);
      logger.warn(`Body length: ${rawBody.length} bytes`);
      logger.warn(`First 50 chars: ${rawBody.toString('utf8').substring(0, 50)}`);
      return res.status(401).send('Invalid signature');
    }
    
    logger.info('✅ Signature verified successfully');
    
    // Parse the webhook payload after verification
    const payload = JSON.parse(rawBody.toString('utf8'));
    
    if (isDebugMode) {
      logger.debug(`Received Discord webhook payload type: ${payload.type}`);
    }
    
    // Handle PING event (Discord sends this to verify the endpoint)
    // PING has type: 0 in the outer payload
    // Must respond with 204 No Content with valid Content-Type header
    if (payload.type === 0) {
      logger.info('✅ Discord PING event received - responding with 204');
      res.setHeader('Content-Type', 'application/json');
      return res.status(204).end();
    }
    
    // For actual events, type will be 1 and event data is in payload.event
    if (payload.type === 1 && payload.event) {
      const event = payload.event;
      const eventType = event.type;
      
      if (isDebugMode) {
        logger.debug(`Event type: ${eventType}, timestamp: ${event.timestamp}`);
      }
      
      // Check for duplicate events (idempotency with automatic cleanup)
      // Use a combination of payload event type and timestamp as ID
      const eventId = `${eventType}_${event.timestamp}`;
      if (processedEvents.has(eventId)) {
        logger.debug(`Event ${eventId} already processed - returning 204`);
        res.setHeader('Content-Type', 'application/json');
        return res.status(204).end();
      }
      
      // Add to processed set
      processedEvents.add(eventId);
      
      // Clean up old entries (simple size-based eviction)
      if (processedEvents.size > MAX_PROCESSED_EVENTS) {
        const toRemove = Array.from(processedEvents).slice(0, MAX_PROCESSED_EVENTS / 2);
        toRemove.forEach(id => processedEvents.delete(id));
      }
      
      // Handle APPLICATION_AUTHORIZED event
      if (eventType === 'APPLICATION_AUTHORIZED') {
        logger.info('APPLICATION_AUTHORIZED event received');
        
        // User data is in event.data.user according to Discord docs
        const userId = event.data?.user?.id;
        const username = event.data?.user?.username ?? 'Unknown';
        const integType = event.data?.integration_type; // 0 = guild, 1 = user
        
        if (!userId) {
          logger.warn('APPLICATION_AUTHORIZED event missing user ID in event.data.user');
          return res.status(204).end();
        }
        
        logger.info(`User ${username} (${userId}) authorized the application (integration_type: ${integType})`);
        
        // Process authorization asynchronously
        processUserAuthorization(userId, username).catch(error => {
          logger.error(`Error processing user authorization: ${error.message}`);
        });
        
        res.setHeader('Content-Type', 'application/json');
        return res.status(204).end();
      }
      
      // Handle APPLICATION_DEAUTHORIZED event (optional cleanup)
      if (eventType === 'APPLICATION_DEAUTHORIZED') {
        const userId = event.data?.user?.id;
        logger.info(`User ${userId} deauthorized the application`);
        // Could add cleanup logic here if needed
        res.setHeader('Content-Type', 'application/json');
        return res.status(204).end();
      }
      
      // Unknown event type
      if (isDebugMode) {
        logger.debug(`Unhandled event type: ${eventType}`);
      }
    }
    
    // All webhook events should respond with 204 and valid Content-Type
    res.setHeader('Content-Type', 'application/json');
    return res.status(204).end();
    
  } catch (error) {
    logger.error(`Error handling Discord webhook event: ${error.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Process user authorization - send intro DMs from all configured bots
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 */
async function processUserAuthorization(userId, username) {
  try {
    // Get all configured Discord bot notifications
    const botConfigs = getConfiguredDiscordBots();
    
    if (botConfigs.length === 0) {
      logger.info('No Discord bots configured - skipping intro DM send');
      return;
    }
    
    logger.info(`Found ${botConfigs.length} Discord bot configuration(s)`);
    
    // Check each bot to see if this user should receive an intro
    for (const config of botConfigs) {
      const userIds = config.notifyUsers.split(',')
        .map(id => id.trim())
        .filter(id => id);
      
      if (!userIds.includes(userId)) {
        if (isDebugMode) {
          logger.debug(`User ${userId} not in notify list for bot config #${config.index}`);
        }
        continue;
      }
      
      logger.info(`User ${userId} is in notify list for bot config #${config.index}`);
      
      // Send intro DM using centralized utility
      try {
        await sendIntroductionDM(userId, username, {
          botToken: config.botToken,
          serverUrl: config.serverUrl,
          botTag: 'webhook-event'
        });
      } catch (error) {
        logger.error(`Failed to send intro DM to user ${userId}: ${error.message}`);
      }
    }
  } catch (error) {
    logger.error(`Error in processUserAuthorization: ${error.message}`);
    throw error;
  }
}

/**
 * Get all configured Discord bot notification channels
 * @returns {Array<object>} Bot configurations
 */
function getConfiguredDiscordBots() {
  const bots = [];
  let index = 1;
  
  while (true) {
    const type = process.env[`NOTIFICATION_${index}_TYPE`];
    
    if (!type) break;
    
    if (type.toLowerCase() === 'discord_bot') {
      const notifyUsers = process.env.DISCORD_NOTIFY_USERS || '';
      
      if (notifyUsers) {
        bots.push({
          index,
          type: 'discord_bot',
          notifyUsers,
          serverUrl: process.env.SERVER_API_URL || process.env.FILE_SERVER_NODE_URL || 'Unknown Server',
          botToken: process.env.DISCORD_BOT_TOKEN
        });
      }
    }
    
    index++;
  }
  
  return bots;
}

  return router;
}

export default setupDiscordRoutes();