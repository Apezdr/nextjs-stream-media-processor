import { createCategoryLogger } from '../../../lib/logger.mjs';
import { initializeDatabase } from '../../../sqliteDatabase.mjs';
import { hasReceivedIntro, recordIntroSent } from '../../../sqlite/discordIntros.mjs';
import { createIntroductionEmbed, createIntroductionComponents } from './messageTemplates.mjs';

const logger = createCategoryLogger('discordIntro');
const isDebugMode = process.env.DEBUG === 'TRUE';

/**
 * Send introduction DM to a user using Discord's REST API
 * This approach works regardless of whether the bot shares a server with the user
 * 
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username (for logging and templates)
 * @param {object} config - Configuration object
 * @param {string} config.botToken - Discord bot token
 * @param {string} config.serverUrl - Server URL to include in message
 * @param {string} [config.botTag] - Bot tag for recording (e.g., "BotName#1234")
 * @returns {Promise<object>} Success status
 */
export async function sendIntroductionDM(userId, username, config) {
  const { botToken, serverUrl, botTag = 'rest-api' } = config;
  
  if (!botToken) {
    throw new Error('Bot token is required to send intro DM');
  }
  
  if (!serverUrl) {
    throw new Error('Server URL is required for intro message');
  }
  
  try {
    // Check if user already received intro
    const db = await initializeDatabase('discordIntros');
    const alreadySent = await hasReceivedIntro(db, userId);
    
    if (alreadySent) {
      logger.debug(`User ${userId} already received intro - skipping`);
      return { success: false, reason: 'already_sent' };
    }
    
    // Create DM channel with user
    const dmResponse = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ recipient_id: userId })
    });
    
    // Handle rate limiting
    if (dmResponse.status === 429) {
      const rateLimitData = await dmResponse.json().catch(() => ({}));
      const retryAfter = rateLimitData.retry_after || 'unknown';
      logger.warn(`Rate limited creating DM channel. retry_after=${retryAfter}s`);
      throw new Error(`Rate limited creating DM (retry after ${retryAfter}s)`);
    }
    
    // Handle user blocking DMs
    if (dmResponse.status === 403) {
      logger.warn(`Cannot create DM with user ${userId} - user may have DMs disabled or blocked the bot`);
      return { success: false, reason: 'dm_blocked' };
    }
    
    if (!dmResponse.ok) {
      const errorText = await dmResponse.text();
      throw new Error(`Failed to create DM channel: ${dmResponse.status} ${errorText}`);
    }
    
    const dmChannel = await dmResponse.json();
    
    // Prepare message using centralized templates
    const embed = createIntroductionEmbed(username, serverUrl);
    const components = createIntroductionComponents();
    
    // Send introduction message
    const messageResponse = await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [embed],
        components: components
      })
    });
    
    // Handle rate limiting
    if (messageResponse.status === 429) {
      const rateLimitData = await messageResponse.json().catch(() => ({}));
      const retryAfter = rateLimitData.retry_after || 'unknown';
      logger.warn(`Rate limited sending DM message. retry_after=${retryAfter}s`);
      throw new Error(`Rate limited sending message (retry after ${retryAfter}s)`);
    }
    
    // Handle user blocking DMs after channel was created
    if (messageResponse.status === 403) {
      logger.warn(`Cannot send message to user ${userId} - permissions changed or user blocked bot`);
      return { success: false, reason: 'dm_blocked' };
    }
    
    if (!messageResponse.ok) {
      const errorText = await messageResponse.text();
      throw new Error(`Failed to send message: ${messageResponse.status} ${errorText}`);
    }
    
    // Record successful send in database
    await recordIntroSent(db, userId, username, botTag);
    
    logger.info(`✅ Successfully sent intro DM to user ${userId} (${username})`);
    return { success: true, userId, username };
    
  } catch (error) {
    logger.error(`Failed to send intro DM to user ${userId}: ${error.message}`);
    throw error;
  }
}

/**
 * Send introduction DMs to multiple users
 * Includes rate limit protection with delays between sends
 * 
 * @param {Array<{userId: string, username?: string}>} users - Array of users to send to
 * @param {object} config - Configuration object (same as sendIntroductionDM)
 * @param {number} [delayMs=100] - Delay between sends in milliseconds
 * @returns {Promise<object>} Statistics about sends
 */
export async function sendBulkIntroductionDMs(users, config, delayMs = 100) {
  const stats = {
    total: users.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };
  
  logger.info(`Sending intro DMs to ${users.length} user(s)...`);
  
  for (const user of users) {
    try {
      const result = await sendIntroductionDM(user.userId, user.username || 'User', config);
      
      if (result.success) {
        stats.sent++;
      } else if (result.reason === 'already_sent') {
        stats.skipped++;
      } else {
        stats.failed++;
      }
      
      // Delay to avoid rate limits (unless this is the last user)
      if (user !== users[users.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      
    } catch (error) {
      stats.failed++;
      stats.errors.push({
        userId: user.userId,
        error: error.message
      });
      logger.error(`Failed to send intro to user ${user.userId}: ${error.message}`);
    }
  }
  
  logger.info(`Intro DM bulk send complete: ${stats.sent} sent, ${stats.skipped} skipped, ${stats.failed} failed`);
  
  return stats;
}