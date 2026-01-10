import { createCategoryLogger } from '../../../lib/logger.mjs';
import { sendBulkIntroductionDMs } from '../utils/introductionDM.mjs';

const logger = createCategoryLogger('discordBot:ready');

export const name = 'ready';
export const once = true;

export async function execute(client) {
  logger.info(`Discord bot logged in as ${client.user.tag}`);
  logger.info(`Bot is in ${client.guilds.cache.size} guild(s)`);
  
  // Set bot presence/status
  client.user.setPresence({
    activities: [{
      name: 'server health',
      type: 3 // Watching
    }],
    status: 'online'
  });
  
  // Mark bot adapter as ready
  if (client.botAdapter) {
    client.botAdapter.ready = true;
  }
  
  logger.info('Discord bot is ready and operational');
  
  // Send introduction DMs to configured notification users (but only if they haven't received one before)
  const notifyUsers = process.env.DISCORD_NOTIFY_USERS;
  if (notifyUsers && client.botAdapter) {
    const userIds = notifyUsers.split(',').map(id => id.trim()).filter(Boolean);
    
    if (userIds.length > 0) {
      logger.info(`Checking introduction status for ${userIds.length} configured user(s)...`);
      
      // Prepare user list with usernames
      const users = [];
      for (const userId of userIds) {
        try {
          const user = await client.users.fetch(userId);
          users.push({ userId, username: user.username });
        } catch (error) {
          logger.warn(`Could not fetch user ${userId}: ${error.message}`);
          users.push({ userId, username: 'Unknown' });
        }
      }
      
      // Send bulk intro DMs using centralized utility
      const config = {
        botToken: client.botAdapter.token,
        serverUrl: client.botAdapter.serverApiUrl || 'Unknown Server',
        botTag: client.user.tag
      };
      
      try {
        const stats = await sendBulkIntroductionDMs(users, config, 100);
        
        if (stats.sent > 0) {
          logger.info(`Sent ${stats.sent} new introduction DM(s), skipped ${stats.skipped} already sent`);
        } else {
          logger.info(`All ${userIds.length} user(s) have already received introductions`);
        }
        
        if (stats.failed > 0) {
          logger.warn(`Failed to send ${stats.failed} introduction DM(s)`);
        }
      } catch (error) {
        logger.error(`Error sending bulk intro DMs: ${error.message}`);
      }
    }
  }
}