import axios from 'axios';
import { createCategoryLogger } from '../lib/logger.mjs';
import { DiscordAdapter } from './discord/webhook.mjs';
import { DiscordBotAdapter } from './discord/bot.mjs';

const logger = createCategoryLogger('notificationManager');
const isDebugMode = process.env.DEBUG === 'TRUE';

/**
 * Notification Manager - Central hub for sending notifications across multiple platforms
 * Supports: Frontend webhooks, Discord webhooks, Discord bot DMs, and extensible for other platforms
 */
export class NotificationManager {
  constructor() {
    this.discordAdapter = new DiscordAdapter();
    this.discordBot = null;
    this.botInitPromise = null;
    
    // Start bot initialization but don't block constructor
    this.initializeDiscordBot().catch(error => {
      logger.error(`Discord bot initialization failed: ${error.message}`);
    });
  }
  
  /**
   * Initialize Discord bot if configured
   */
  async initializeDiscordBot() {
    // Check if discord_bot notification type is configured
    const channels = this.getNotificationChannels();
    const hasBotChannel = channels.some(ch => ch.type === 'discord_bot');
    
    logger.info(`Checking Discord bot configuration...`);
    logger.info(`Found ${channels.length} notification channel(s)`);
    logger.info(`Discord bot type configured: ${hasBotChannel}`);
    
    if (!hasBotChannel) {
      logger.info('Discord bot not configured in NOTIFICATION_X_TYPE variables');
      return;
    }
    
    // Check if bot credentials are available
    if (!process.env.DISCORD_BOT_TOKEN) {
      logger.error('DISCORD_BOT_TOKEN is missing!');
      return;
    }
    
    if (!process.env.DISCORD_CLIENT_ID) {
      logger.error('DISCORD_CLIENT_ID is missing!');
      return;
    }
    
    logger.info('Discord bot credentials found, initializing...');
    
    try {
      this.discordBot = new DiscordBotAdapter();
      await this.discordBot.initialize();
      logger.info('✅ Discord bot initialized successfully and is ready!');
    } catch (error) {
      logger.error(`❌ Failed to initialize Discord bot: ${error.message}`);
      console.error(error);
      this.discordBot = null;
    }
  }
  
  /**
   * Parse environment variables to get all configured notification channels
   * Supports both legacy frontend webhooks and new unified notification system
   * 
   * Legacy format (backward compatible):
   *   FRONT_END_1=https://frontend.com
   *   WEBHOOK_ID_1=webhook-id-123
   * 
   * New unified format:
   *   NOTIFICATION_1_TYPE=discord
   *   NOTIFICATION_1_URL=https://discord.com/api/webhooks/...
   *   NOTIFICATION_1_COOLDOWN=300000 (optional, in milliseconds)
   * 
   * @returns {Array<object>} Array of notification channel configurations
   */
  getNotificationChannels() {
    const channels = [];
    
    // Parse legacy frontend webhooks (FRONT_END_X + WEBHOOK_ID_X)
    let index = 1;
    while (true) {
      const frontendUrl = process.env[`FRONT_END_${index}`];
      const webhookId = process.env[`WEBHOOK_ID_${index}`];
      
      if (!frontendUrl || !webhookId) break;
      
      channels.push({
        type: 'frontend',
        url: frontendUrl,
        webhookId: webhookId,
        index: index,
        cooldown: null // Use default from NOTIFICATION_COOLDOWN
      });
      
      index++;
      if (isDebugMode) {
        logger.debug(`Found legacy frontend configuration #${index - 1}: ${frontendUrl}`);
      }
    }
    
    // Parse new unified notification channels (NOTIFICATION_X_TYPE, NOTIFICATION_X_URL)
    index = 1;
    while (true) {
      const type = process.env[`NOTIFICATION_${index}_TYPE`];
      const url = process.env[`NOTIFICATION_${index}_URL`];
      
      // For discord_bot type, URL is optional (uses DISCORD_NOTIFY_USERS instead)
      if (!type) break;
      if (!url && type.toLowerCase() !== 'discord_bot') break;
      
      const cooldown = process.env[`NOTIFICATION_${index}_COOLDOWN`];
      const webhookId = process.env[`NOTIFICATION_${index}_WEBHOOK_ID`]; // For frontend type
      
      channels.push({
        type: type.toLowerCase(),
        url: url || null, // URL is optional for discord_bot
        webhookId: webhookId,
        index: index,
        cooldown: cooldown ? parseInt(cooldown, 10) : null
      });
      
      index++;
      if (isDebugMode) {
        logger.debug(`Found unified notification #${index - 1}: ${type} -> ${url || 'N/A (bot)'}`);
      }
    }
    
    if (channels.length === 0) {
      logger.warn('No notification channels configured');
    } else {
      logger.info(`Loaded ${channels.length} notification channel(s)`);
    }
    
    return channels;
  }
  
  /**
   * Send system status notification to all configured channels
   * @param {string} status - System status level (normal, elevated, heavy, critical)
   * @param {string} message - Detailed status message
   * @param {object} statusData - Complete status information with metrics
   * @param {object} incident - Current incident information (if any)
   * @param {string} serverUrl - Server URL for identification
   * @param {object} cooldowns - Cooldown tracker object (lastNotificationTime)
   * @param {object} cooldownLimits - Cooldown limits by status level
   * @returns {Promise<object>} Results summary
   */
  async sendNotifications(status, message, statusData, incident, serverUrl, cooldowns, cooldownLimits) {
    const channels = this.getNotificationChannels();
    
    if (channels.length === 0) {
      return { sent: 0, failed: 0, skipped: 0 };
    }
    
    // Check global cooldown for this status level
    const now = Date.now();
    const cooldownLimit = cooldownLimits[status] || Infinity;
    const timeSinceLastNotification = now - (cooldowns[status] || 0);
    
    if (timeSinceLastNotification < cooldownLimit) {
      if (isDebugMode) {
        logger.debug(`Skipping ${status} notifications - still in cooldown period (${Math.round((cooldownLimit - timeSinceLastNotification) / 1000)}s remaining)`);
      }
      return { sent: 0, failed: 0, skipped: channels.length };
    }
    
    logger.info(`Sending ${status} notifications to ${channels.length} channel(s)`);
    
    const promises = channels.map(channel => 
      this.sendToChannel(channel, status, message, statusData, incident, serverUrl)
        .catch(error => {
          logger.error(`Failed to send to ${channel.type} channel: ${error.message}`);
          return { success: false, channel: channel.type, error: error.message };
        })
    );
    
    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value?.success)).length;
    
    if (successful > 0) {
      // Update cooldown timestamp if at least one notification succeeded
      cooldowns[status] = now;
      logger.info(`Successfully sent notifications to ${successful} of ${channels.length} channel(s)`);
    }
    
    return {
      sent: successful,
      failed: failed,
      skipped: 0,
      total: channels.length
    };
  }
  
  /**
   * Send notification to a specific channel based on its type
   * @param {object} channel - Channel configuration
   * @param {string} status - System status level
   * @param {string} message - Status message
   * @param {object} statusData - Complete status data
   * @param {object} incident - Incident information
   * @param {string} serverUrl - Server URL
   * @returns {Promise<object>} Result of the send operation
   */
  async sendToChannel(channel, status, message, statusData, incident, serverUrl) {
    switch (channel.type) {
      case 'discord':
        return await this.discordAdapter.send(
          channel.url,
          status,
          message,
          statusData.metrics,
          incident,
          serverUrl
        );
        
      case 'discord_bot':
        return await this.sendViaDiscordBot(
          status,
          message,
          statusData.metrics,
          incident,
          serverUrl
        );
        
      case 'frontend':
        return await this.sendToFrontend(
          channel.webhookId,
          channel.url,
          status,
          message,
          statusData,
          incident,
          serverUrl
        );
        
      default:
        logger.warn(`Unknown notification type: ${channel.type}`);
        return { success: false, channel: channel.type, error: 'Unknown type' };
    }
  }
  
  /**
   * Send DM notifications via Discord bot
   * @param {string} status - System status level
   * @param {string} message - Status message
   * @param {object} metrics - System metrics
   * @param {object} incident - Incident information
   * @param {string} serverUrl - Server URL
   * @returns {Promise<object>} Result of the send operation
   */
  async sendViaDiscordBot(status, message, metrics, incident, serverUrl) {
    logger.info('🤖 [Discord Bot DM] Starting DM send process...');
    logger.info(`Bot instance exists: ${!!this.discordBot}`);
    logger.info(`Bot ready status: ${this.discordBot?.ready}`);
    
    if (!this.discordBot) {
      logger.error('❌ Discord bot instance not created');
      return { success: false, platform: 'discord_bot', error: 'Bot not initialized' };
    }
    
    if (!this.discordBot.ready) {
      logger.warn('⚠️ Discord bot not ready yet');
      return { success: false, platform: 'discord_bot', error: 'Bot not ready' };
    }
    
    // Get list of user IDs to notify
    const userIdsRaw = process.env.DISCORD_NOTIFY_USERS || '';
    logger.info(`DISCORD_NOTIFY_USERS raw value: "${userIdsRaw}"`);
    
    const userIds = userIdsRaw.split(',').filter(id => id.trim());
    logger.info(`Parsed user IDs (${userIds.length}): ${JSON.stringify(userIds)}`);
    
    if (userIds.length === 0) {
      logger.error('❌ DISCORD_NOTIFY_USERS not configured or empty');
      return { success: false, platform: 'discord_bot', error: 'No users configured' };
    }
    
    logger.info(`📤 Attempting to send DMs to ${userIds.length} user(s)...`);
    
    // Send DM to each user
    const results = await Promise.allSettled(
      userIds.map(userId => {
        const trimmedId = userId.trim();
        logger.info(`Sending DM to user ID: ${trimmedId}`);
        return this.discordBot.sendDM(trimmedId, status, message, metrics, incident);
      })
    );
    
    // Log detailed results
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value?.success) {
          logger.info(`✅ DM to user ${userIds[index].trim()}: SUCCESS`);
        } else {
          logger.error(`❌ DM to user ${userIds[index].trim()}: FAILED - ${JSON.stringify(result.value)}`);
        }
      } else {
        logger.error(`❌ DM to user ${userIds[index].trim()} REJECTED: ${result.reason?.message}`);
        console.error(result.reason);
      }
    });
    
    const successful = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
    const failed = results.length - successful;
    
    if (successful > 0) {
      logger.info(`✅ Successfully sent ${successful} of ${userIds.length} Discord DMs`);
      return { success: true, platform: 'discord_bot', sent: successful, failed, total: userIds.length };
    } else {
      logger.error(`❌ All ${userIds.length} DMs failed to send`);
      return { success: false, platform: 'discord_bot', error: 'All DMs failed' };
    }
  }
  
  /**
   * Send notification to frontend (legacy method)
   * @param {string} webhookId - Webhook ID for authentication
   * @param {string} frontendUrl - Frontend base URL
   * @param {string} status - System status level
   * @param {string} message - Status message
   * @param {object} statusData - Complete status data
   * @param {object} incident - Incident information
   * @param {string} serverUrl - Server URL
   * @returns {Promise<object>} Result of the send operation
   */
  async sendToFrontend(webhookId, frontendUrl, status, message, statusData, incident, serverUrl) {
    const headers = {
      'X-Webhook-ID': webhookId,
      'Content-Type': 'application/json'
    };
    
    if (isDebugMode) {
      logger.debug(`Sending notification to frontend: ${frontendUrl}`);
    }
    
    try {
      const response = await axios.post(
        `${frontendUrl}/api/authenticated/admin/system-status-notification`,
        {
          status,
          message,
          incident,
          serverUrl,
          timestamp: new Date().toISOString(),
          metrics: statusData.metrics
        },
        { headers, timeout: 5000 }
      );
      
      if (response.status >= 200 && response.status < 300) {
        logger.info(`Frontend notification sent successfully to ${frontendUrl}`);
        return { success: true, platform: 'frontend', url: frontendUrl };
      } else {
        logger.warn(`Frontend notification failed with status: ${response.status}`);
        return { success: false, platform: 'frontend', status: response.status };
      }
    } catch (error) {
      throw error;
    }
  }
}

export default NotificationManager;