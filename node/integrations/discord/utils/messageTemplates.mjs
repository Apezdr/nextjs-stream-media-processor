/**
 * Discord Message Templates
 * Centralized definitions for all Discord embeds and components
 * Prevents duplication across bot.mjs, routes.mjs, and event handlers
 */

/**
 * Create introduction DM embed for new users
 * @param {string} username - Discord username
 * @param {string} serverUrl - Server URL being monitored
 * @returns {object} Discord embed object
 */
export function createIntroductionEmbed(username, serverUrl) {
  return {
    title: '👋 Welcome to Server Monitor Bot!',
    description: `Hi ${username}! I'm your server monitoring assistant for **${serverUrl}**.\n\nI'll keep you informed about this backend server's health and send you alerts when issues arise.`,
    color: 0x00FF00,
    fields: [
      {
        name: '🖥️ Monitoring Server',
        value: `\`${serverUrl}\`\n\nThis bot is configured to monitor the backend server at this URL. All status updates and alerts will be for this server.`,
        inline: false
      },
      {
        name: '🎯 What I Do',
        value: '• Monitor server health (CPU, Memory, Disk)\n' +
               '• Send you DM alerts for system issues\n' +
               '• Provide real-time status via commands\n' +
               '• Track and report incidents\n' +
               '• Help you manage your server'
      },
      {
        name: '🚀 Getting Started',
        value: 'You can use these slash commands in any server where I\'m present:\n\n' +
               '`/status` - Check current server status\n' +
               '`/help` - See all available commands\n' +
               '`/ping` - Test bot responsiveness'
      },
      {
        name: '🔔 Notifications',
        value: 'You\'re all set up to receive notifications! I\'ll send you a DM whenever:\n' +
               '• System load reaches elevated levels\n' +
               '• Resources become critically constrained\n' +
               '• An ongoing incident updates or resolves'
      },
      {
        name: '📊 Current Status',
        value: 'Use the `/status` command to check the current server status!'
      }
    ],
    footer: {
      text: `Monitoring: ${serverUrl} • You can disable DMs anytime in Discord settings`
    },
    timestamp: new Date().toISOString()
  };
}

/**
 * Create introduction message components (buttons)
 * @returns {Array} Discord components array
 */
export function createIntroductionComponents() {
  return [
    {
      type: 1, // ACTION_ROW
      components: [
        {
          type: 2, // BUTTON
          style: 1, // PRIMARY
          label: 'Check Server Status',
          custom_id: 'check_status',
          emoji: { name: '📊' }
        },
        {
          type: 2, // BUTTON
          style: 2, // SECONDARY
          label: 'View Help',
          custom_id: 'view_help',
          emoji: { name: '❓' }
        }
      ]
    }
  ];
}

/**
 * Create system alert DM embed
 * @param {string} status - System status level (normal, elevated, heavy, critical)
 * @param {string} message - Alert message
 * @param {object} metrics - System metrics
 * @param {object} incident - Incident information (optional)
 * @returns {object} Discord embed object
 */
export function createAlertEmbed(status, message, metrics, incident) {
  const embed = {
    title: `${getEmojiForStatus(status)} Server Alert: ${status.toUpperCase()}`,
    description: message,
    color: getColorForStatus(status),
    fields: [
      { name: '💻 CPU Usage', value: `${metrics.cpu.usage}%`, inline: true },
      { name: '🧠 Memory Usage', value: `${metrics.memory.usage}%`, inline: true },
      { name: '💾 Disk Usage', value: `${metrics.disk.usage}%`, inline: true }
    ],
    timestamp: new Date().toISOString()
  };
  
  // Add incident info if present and not resolved
  if (incident && incident.status !== 'resolved') {
    embed.fields.push(
      { name: '🚨 Incident ID', value: incident.id, inline: false },
      { 
        name: '⏱️ Started', 
        value: `<t:${Math.floor(new Date(incident.startTime).getTime() / 1000)}:R>`, 
        inline: true 
      }
    );
  }
  
  return embed;
}

/**
 * Create guild onboarding embed (when bot joins a server)
 * @returns {object} Discord embed object
 */
export function createGuildOnboardingEmbed() {
  return {
    title: '👋 Server Monitor Bot Ready!',
    description: 'Thanks for adding me to your server! I\'m here to help you monitor and manage your backend server.',
    color: 0x00FF00,
    fields: [
      {
        name: '🎯 What I Can Do',
        value: '• Monitor server health (CPU, Memory, Disk)\n' +
               '• Send alerts for system issues\n' +
               '• Provide real-time status via commands\n' +
               '• Track and report incidents\n' +
               '• Help you manage your server'
      },
      {
        name: '🚀 Getting Started',
        value: 'Use `/help` to see all available commands\n' +
               'Use `/status` to check current server status\n' +
               'Use `/setup` to configure notifications'
      },
      {
        name: '⚙️ Configuration Required',
        value: 'To start receiving notifications, you\'ll need to:\n' +
               '1. Set up your bot token in `.env`\n' +
               '2. Configure SERVER_API_URL to point to your backend\n' +
               '3. Optionally set notification preferences with `/setup`'
      },
      {
        name: '📚 Need Help?',
        value: 'Check the documentation at: [GitHub](https://github.com/your-repo)\n' +
               'Or use `/help` for command details'
      }
    ],
    footer: { text: 'Tip: React with 👍 if you see this message!' },
    timestamp: new Date().toISOString()
  };
}

/**
 * Create guild onboarding components (buttons)
 * @returns {Array} Discord components array
 */
export function createGuildOnboardingComponents() {
  return [
    {
      type: 1, // ACTION_ROW
      components: [
        {
          type: 2, // BUTTON
          style: 1, // PRIMARY
          label: 'Setup Notifications',
          custom_id: 'setup_notifications',
          emoji: { name: '🔔' }
        },
        {
          type: 2, // BUTTON
          style: 2, // SECONDARY
          label: 'View Commands',
          custom_id: 'view_commands',
          emoji: { name: '📋' }
        },
        {
          type: 2, // BUTTON
          style: 5, // LINK
          label: 'Documentation',
          url: 'https://github.com/your-repo',
          emoji: { name: '📚' }
        }
      ]
    }
  ];
}

/**
 * Get emoji for system status
 * @param {string} status - System status level
 * @returns {string} Emoji
 */
export function getEmojiForStatus(status) {
  const emojis = {
    normal: '✅',
    elevated: '⚠️',
    heavy: '🔶',
    critical: '🚨'
  };
  return emojis[status] || '📊';
}

/**
 * Get color for system status
 * @param {string} status - System status level
 * @returns {number} Color hex value
 */
export function getColorForStatus(status) {
  const colors = {
    normal: 0x00FF00,    // Green
    elevated: 0xFFFF00,  // Yellow
    heavy: 0xFFA500,     // Orange
    critical: 0xFF0000   // Red
  };
  return colors[status] || 0x0099FF;
}