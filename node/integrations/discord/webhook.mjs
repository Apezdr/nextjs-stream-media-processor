import axios from 'axios';
import { createCategoryLogger } from '../../lib/logger.mjs';

const logger = createCategoryLogger('discordIntegration');
const isDebugMode = process.env.DEBUG === 'TRUE';

/**
 * Discord webhook integration for system status notifications
 * Formats system status as rich Discord embeds and sends to configured webhooks
 */
export class DiscordAdapter {
  /**
   * Post one ready-made embed (log alerts, lib/alerts/notifier.mjs).
   * @returns {Promise<object>} { success, platform }
   */
  async sendEmbed(webhookUrl, embed) {
    const response = await axios.post(webhookUrl, { embeds: [embed] }, { timeout: 5000 });
    return { success: response.status >= 200 && response.status < 300, platform: 'discord' };
  }

  /**
   * Send system status notification to Discord webhook
   * @param {string} webhookUrl - Discord webhook URL
   * @param {string} status - System status level (normal, elevated, heavy, critical)
   * @param {string} message - Detailed status message
   * @param {object} metrics - System metrics object
   * @param {object} incident - Current incident information (if any)
   * @param {string} serverUrl - Server URL for identification
   * @returns {Promise<object>} Result of the notification attempt
   */
  async send(webhookUrl, status, message, metrics, incident, serverUrl) {
    try {
      // Determine embed color based on status
      const colors = {
        normal: 3066993,    // Green
        elevated: 16776960, // Yellow
        heavy: 16744192,    // Orange
        critical: 15158332  // Red
      };
      
      // Determine emoji based on status
      const emojis = {
        normal: '✅',
        elevated: '⚠️',
        heavy: '🔶',
        critical: '🚨'
      };
      
      const color = colors[status] || colors.normal;
      const emoji = emojis[status] || '📊';
      
      // Build fields array with metrics
      const fields = [];
      
      if (metrics?.cpu) {
        fields.push({
          name: '💻 CPU Usage',
          value: `${metrics.cpu.usage}%`,
          inline: true
        });
      }
      
      if (metrics?.memory) {
        fields.push({
          name: '🧠 Memory Usage',
          value: `${metrics.memory.usage}%\n${metrics.memory.used} / ${metrics.memory.total}`,
          inline: true
        });
      }
      
      if (metrics?.disk) {
        fields.push({
          name: '💾 Disk Usage',
          value: `${metrics.disk.usage}%\n${metrics.disk.free} free`,
          inline: true
        });
      }
      
      // Add disk I/O if available
      if (metrics?.disk?.io) {
        const io = metrics.disk.io;
        fields.push({
          name: '📊 Disk I/O',
          value: `Read: ${io.read_sec}/s\nWrite: ${io.write_sec}/s`,
          inline: true
        });
      }
      
      // Add incident information if present
      if (incident && incident.status !== 'resolved') {
        fields.push({
          name: '📋 Incident ID',
          value: incident.id,
          inline: false
        });
        
        fields.push({
          name: '⏱️ Started',
          value: `<t:${Math.floor(new Date(incident.startTime).getTime() / 1000)}:R>`,
          inline: true
        });
        
        if (incident.updates && incident.updates.length > 1) {
          fields.push({
            name: '🔄 Updates',
            value: `${incident.updates.length} status updates`,
            inline: true
          });
        }
      }
      
      // Build the embed
      const embed = {
        title: `${emoji} System Status: ${status.toUpperCase()}`,
        description: message,
        color: color,
        fields: fields,
        timestamp: new Date().toISOString(),
        footer: {
          text: `Server: ${serverUrl || 'Unknown'}`
        }
      };
      
      // Add thumbnail based on status
      if (status === 'critical' || status === 'heavy') {
        embed.thumbnail = {
          url: 'https://cdn.discordapp.com/emojis/1234567890.png' // Optional: Add your own icon URL
        };
      }
      
      const payload = {
        embeds: [embed],
        username: 'System Monitor',
        avatar_url: 'https://cdn.discordapp.com/emojis/1234567890.png' // Optional: Add your own bot avatar
      };
      
      if (isDebugMode) {
        logger.debug(`Sending Discord notification to webhook: ${this.maskWebhookUrl(webhookUrl)}`);
      }
      
      const response = await axios.post(webhookUrl, payload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });
      
      if (response.status === 204 || response.status === 200) {
        logger.info(`Discord notification sent successfully to ${this.maskWebhookUrl(webhookUrl)}`);
        return { success: true, platform: 'discord', webhook: this.maskWebhookUrl(webhookUrl) };
      } else {
        logger.warn(`Discord notification returned unexpected status: ${response.status}`);
        return { success: false, platform: 'discord', status: response.status };
      }
    } catch (error) {
      logger.error(`Failed to send Discord notification: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Mask webhook URL for logging (hide sensitive parts)
   * @param {string} url - Webhook URL
   * @returns {string} Masked URL
   */
  maskWebhookUrl(url) {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/');
      if (pathParts.length >= 4) {
        // Mask the webhook token (last part)
        pathParts[pathParts.length - 1] = '***';
        urlObj.pathname = pathParts.join('/');
      }
      return urlObj.toString();
    } catch {
      return 'invalid-url';
    }
  }
  
  /**
   * Validate Discord webhook URL format
   * @param {string} url - Webhook URL to validate
   * @returns {boolean} True if valid Discord webhook URL
   */
  static isValidWebhookUrl(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname === 'discord.com' && 
             urlObj.pathname.includes('/api/webhooks/');
    } catch {
      return false;
    }
  }
}

export default DiscordAdapter;