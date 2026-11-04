import axios from 'axios';
import { createCategoryLogger } from '../lib/logger.mjs';
import { DiscordAdapter } from './discord/webhook.mjs';
import { DiscordBotAdapter } from './discord/bot.mjs';
import { readNotificationChannels, discordTargets } from './notificationChannels.mjs';

export { readNotificationChannels, discordTargets };

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

    // Start bot initialization but don't block constructor. Kept, so
    // whenDiscordReady() can wait for it; it never rejects.
    this.botInitPromise = this.initializeDiscordBot().catch(error => {
      logger.error(`Discord bot initialization failed: ${error.message}`);
    });
  }

  /**
   * Resolves true once the bot can send DMs, false when there is no bot or it
   * isn't ready within `timeoutMs`. Never rejects. The alert intake waits on
   * it at startup: Uptime Kuma and the *arr apps don't retry, so an alert
   * refused while the bot logs in would be lost.
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async whenDiscordReady(timeoutMs) {
    if (this.discordBot?.ready) return true;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const ready = (async () => {
      await this.botInitPromise;
      if (!this.discordBot) return false;
      if (this.discordBot.ready) return true;
      return this.discordBot.whenReady().then(() => true);
    })().catch(() => false);
    try {
      return await Promise.race([ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
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
    const channels = readNotificationChannels(process.env);

    if (isDebugMode) {
      for (const channel of channels) {
        if (channel.type === 'frontend' && channel.source === 'legacy') {
          logger.debug(`Found legacy frontend configuration #${channel.index}: ${channel.url}`);
        } else {
          logger.debug(`Found unified notification #${channel.index}: ${channel.type} -> ${channel.url || 'N/A (bot)'}`);
        }
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
   * Send one ready-made embed to every Discord channel (bot DMs to
   * DISCORD_NOTIFY_USERS, and Discord webhooks). Used by log alerts
   * (lib/alerts/notifier.mjs), which carry no system metrics.
   * @returns {Promise<boolean>} whether at least one Discord delivery succeeded
   */
  async sendDiscordEmbed(embed) {
    const outcome = await this.deliverDiscordEmbeds([embed]);
    for (const reason of outcome.reasons) logger.warn(`Discord alert delivery failed: ${reason}`);
    return outcome.delivered > 0;
  }

  /**
   * Send one message holding up to 10 ready-made embeds to every Discord
   * channel, as sendDiscordEmbed does, and say how it went. Logs nothing and
   * never rejects: the alert intake (integrations/alert-intake/) relays other
   * apps' alerts through it, and a failure it logged could come back to
   * Discord as a log alert. Its caller logs the outcome.
   * @param {object[]} embeds
   * @returns {Promise<{ targets: number, delivered: number, failed: number, botNotReady: number, reasons: string[] }>}
   */
  async deliverDiscordEmbeds(embeds) {
    const { webhookUrls, userIds, botConfigured } = discordTargets(process.env);
    const sends = webhookUrls.map((url) => this.discordAdapter.sendEmbeds(url, embeds));
    let botNotReady = 0;
    if (botConfigured) {
      if (this.discordBot?.ready) {
        sends.push(...userIds.map((userId) => this.discordBot.sendEmbedsDM(userId, embeds)));
      } else {
        botNotReady = Math.max(userIds.length, 1);
      }
    }
    const results = await Promise.allSettled(sends);
    const delivered = results.filter((result) => result.status === 'fulfilled' && result.value?.success).length;
    const reasons = [
      ...(botNotReady ? ['Discord bot not ready'] : []),
      ...results.map((result) =>
        result.status === 'rejected' ? String(result.reason?.message ?? result.reason) : result.value?.success ? null : 'Discord refused the message'
      ),
    ].filter(Boolean);
    return { targets: sends.length + botNotReady, delivered, failed: sends.length + botNotReady - delivered, botNotReady, reasons };
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

let shared = null;

/**
 * The process's one NotificationManager: constructing one starts the Discord
 * bot, so system status and log alerts share this instance.
 */
export function getNotificationManager() {
  shared ??= new NotificationManager();
  return shared;
}

export default NotificationManager;