import { createCategoryLogger } from '../../../lib/logger.mjs';
import { getSystemStatus, ServerApiClient } from '../utils/serverApi.mjs';
import { getAdminByDiscordId } from '../../../database.mjs';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
  createSimpleViewButtonRow,
  createDetailedViewButtonRow,
  createTasksSimpleButtonRow,
  createTasksDetailedButtonRow,
  createHelpButtonRow
} from '../utils/buttonRows.mjs';

const logger = createCategoryLogger('discordBot:interaction');

export const name = 'interactionCreate';
export const once = false;
const serverUrl = process.env.SERVER_API_URL || process.env.FILE_SERVER_NODE_URL || 'Unknown Server';

export async function execute(interaction, client) {
  // Handle slash commands
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    
    if (!command) {
      logger.warn(`No command found for: ${interaction.commandName}`);
      return;
    }
    
    try {
      logger.info(`Executing command: /${interaction.commandName} by ${interaction.user.tag}`);
      await command.execute(interaction, client);
    } catch (error) {
      logger.error(`Error executing command ${interaction.commandName}: ${error.message}`);
      
      const errorMessage = { 
        content: '❌ There was an error executing this command!', 
        ephemeral: true 
      };
      
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage);
      } else {
        await interaction.reply(errorMessage);
      }
    }
  }
  
  // Handle button interactions
  else if (interaction.isButton()) {
    try {
      await handleButtonInteraction(interaction, client);
    } catch (error) {
      logger.error(`Error handling button interaction: ${error.message}`);
      await interaction.reply({ 
        content: '❌ There was an error processing this action!', 
        ephemeral: true 
      });
    }
  }
  
  // Handle select menu interactions
  else if (interaction.isStringSelectMenu()) {
    try {
      await handleSelectMenuInteraction(interaction, client);
    } catch (error) {
      logger.error(`Error handling select menu interaction: ${error.message}`);
      await interaction.reply({ 
        content: '❌ There was an error processing this selection!', 
        ephemeral: true 
      });
    }
  }
}

/**
 * Handle button interactions (for onboarding and other interactive messages)
 */
async function handleButtonInteraction(interaction, client) {
  const customId = interaction.customId;
  
  switch (customId) {
    // Introduction message buttons - show simple view immediately
    case 'check_status':
    case 'status_simple':
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const status = await getSystemStatus();
        
        const simpleEmbed = new EmbedBuilder()
          .setTitle(`${getEmojiForStatus(status.status)} Server Status: ${status.status.toUpperCase()}`)
          .setDescription(status.message)
          .setColor(getColorForStatus(status.status))
          .addFields([
            { name: '💻 CPU', value: `${status.metrics.cpu.usage}%`, inline: true },
            { name: '🧠 Memory', value: `${status.metrics.memory.usage}%`, inline: true },
            { name: '💾 Disk', value: `${status.metrics.disk.usage}%`, inline: true }
          ])
          .setFooter({ text: `Simple View • Monitoring: ${serverUrl}` })
          .setTimestamp();
        
        await interaction.editReply({
          embeds: [simpleEmbed],
          components: [createSimpleViewButtonRow()]
        });
      } catch (error) {
        logger.error(`Error fetching server status: ${error.message}`);
        await interaction.editReply({
          content: `❌ Failed to fetch server status: ${error.message}`,
          components: [createHelpButtonRow()]
        });
      }
      break;
      
    // Refresh simple view
    case 'status_refresh_simple':
      await interaction.deferReply({ ephemeral: true });
      
      try {
        logger.info('Refreshing simple view');
        const status = await getSystemStatus(); // Use normal endpoint
        
        const simpleEmbed = new EmbedBuilder()
          .setTitle(`${getEmojiForStatus(status.status)} Server Status: ${status.status.toUpperCase()}`)
          .setDescription(status.message)
          .setColor(getColorForStatus(status.status))
          .addFields([
            { name: '💻 CPU', value: `${status.metrics.cpu.usage}%`, inline: true },
            { name: '🧠 Memory', value: `${status.metrics.memory.usage}%`, inline: true },
            { name: '💾 Disk', value: `${status.metrics.disk.usage}%`, inline: true }
          ])
          .setFooter({ text: `Simple View • Monitoring: ${serverUrl}` })
          .setTimestamp();
        
        await interaction.editReply({
          embeds: [simpleEmbed],
          components: [createSimpleViewButtonRow()]
        });
      } catch (error) {
        logger.error(`Error fetching server status: ${error.message}`);
        await interaction.editReply({
          content: `❌ Failed to fetch server status: ${error.message}`,
          components: [createHelpButtonRow()]
        });
      }
      break;
      
    // Detailed status view
    case 'status_detailed':
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const status = await getSystemStatus();
        
        const detailedEmbed = new EmbedBuilder()
          .setTitle(`${getEmojiForStatus(status.status)} Server Status: ${status.status.toUpperCase()}`)
          .setDescription(status.message)
          .setColor(getColorForStatus(status.status))
          .addFields([
            {
              name: '💻 CPU Usage',
              value: `**Usage:** ${status.metrics.cpu.usage}%\n**Cores:** ${status.metrics.cpu.cores}\n**Model:** ${status.metrics.cpu.model}`,
              inline: false
            },
            {
              name: '🧠 Memory Usage',
              value: `**Usage:** ${status.metrics.memory.usage}%\n**Total:** ${status.metrics.memory.total}\n**Used:** ${status.metrics.memory.used}\n**Free:** ${status.metrics.memory.free}`,
              inline: false
            },
            {
              name: '💾 Disk Usage',
              value: `**Usage:** ${status.metrics.disk.usage}%\n**Total:** ${status.metrics.disk.total}\n**Free:** ${status.metrics.disk.free}`,
              inline: false
            },
            {
              name: '📊 Processes',
              value: `**Total:** ${status.metrics.processes.total}\n**Running:** ${status.metrics.processes.running}`,
              inline: true
            }
          ])
          .setFooter({ text: `Detailed View • Monitoring: ${serverUrl}` })
          .setTimestamp();
        
        // Add disk I/O if available
        if (status.metrics.disk.io) {
          detailedEmbed.addFields({
            name: '💿 Disk I/O',
            value: `**Read:** ${status.metrics.disk.io.read_sec}/s\n**Write:** ${status.metrics.disk.io.write_sec}/s`,
            inline: true
          });
        }
        
        await interaction.editReply({
          embeds: [detailedEmbed],
          components: [createDetailedViewButtonRow()]
        });
      } catch (error) {
        logger.error(`Error fetching server status: ${error.message}`);
        await interaction.editReply({
          content: `❌ Failed to fetch server status: ${error.message}`,
          components: [createHelpButtonRow()]
        });
      }
      break;
      
    // Refresh detailed view
    case 'status_refresh_detailed':
      await interaction.deferReply({ ephemeral: true });
      
      try {
        logger.info('Refreshing detailed view');
        const status = await getSystemStatus(); // Use normal endpoint
        
        const detailedEmbed = new EmbedBuilder()
          .setTitle(`${getEmojiForStatus(status.status)} Server Status: ${status.status.toUpperCase()}`)
          .setDescription(status.message)
          .setColor(getColorForStatus(status.status))
          .addFields([
            {
              name: '💻 CPU Usage',
              value: `**Usage:** ${status.metrics.cpu.usage}%\n**Cores:** ${status.metrics.cpu.cores}\n**Model:** ${status.metrics.cpu.model}`,
              inline: false
            },
            {
              name: '🧠 Memory Usage',
              value: `**Usage:** ${status.metrics.memory.usage}%\n**Total:** ${status.metrics.memory.total}\n**Used:** ${status.metrics.memory.used}\n**Free:** ${status.metrics.memory.free}`,
              inline: false
            },
            {
              name: '💾 Disk Usage',
              value: `**Usage:** ${status.metrics.disk.usage}%\n**Total:** ${status.metrics.disk.total}\n**Free:** ${status.metrics.disk.free}`,
              inline: false
            },
            {
              name: '📊 Processes',
              value: `**Total:** ${status.metrics.processes.total}\n**Running:** ${status.metrics.processes.running}`,
              inline: true
            }
          ])
          .setFooter({ text: `Detailed View • Monitoring: ${serverUrl}` })
          .setTimestamp();
        
        // Add disk I/O if available
        if (status.metrics.disk.io) {
          detailedEmbed.addFields({
            name: '💿 Disk I/O',
            value: `**Read:** ${status.metrics.disk.io.read_sec}/s\n**Write:** ${status.metrics.disk.io.write_sec}/s`,
            inline: true
          });
        }
        
        await interaction.editReply({
          embeds: [detailedEmbed],
          components: [createDetailedViewButtonRow()]
        });
      } catch (error) {
        logger.error(`Error fetching server status: ${error.message}`);
        await interaction.editReply({
          content: `❌ Failed to fetch server status: ${error.message}`,
          components: [createHelpButtonRow()]
        });
      }
      break;
      
    case 'view_help':
      const helpCommands = Array.from(client.commands.values());
      const helpCommandList = helpCommands.map(cmd =>
        `• **/${cmd.data.name}** - ${cmd.data.description}`
      ).join('\n');
      
      const helpEmbed = new EmbedBuilder()
        .setTitle('📚 Bot Help & Actions')
        .setDescription(`**Monitoring Server:** \`${serverUrl}\`\n\nHere are all the actions you can perform with this bot:`)
        .setColor(0x0099FF)
        .addFields([
          {
            name: '🖥️ Server Being Monitored',
            value: `This bot monitors: \`${serverUrl}\`\n\nAll status checks and alerts are for this backend server.`,
            inline: false
          },
          {
            name: '📊 Status Actions',
            value: '**Check Server Status** - View current server metrics\n' +
                   '**Simple View** - Quick overview of CPU, Memory, Disk\n' +
                   '**Detailed View** - Comprehensive metrics with I/O and processes\n' +
                   '**Refresh** - Update current view with latest data',
            inline: false
          },
          {
            name: '💬 Slash Commands',
            value: helpCommandList || 'No commands available',
            inline: false
          },
          {
            name: '🔔 Notifications',
            value: 'You\'ll receive DM alerts when:\n' +
                   '• System load reaches elevated levels\n' +
                   '• Resources become critically constrained\n' +
                   '• Incidents are created or resolved',
            inline: false
          },
          {
            name: '💡 Tips',
            value: '• Click buttons below for quick actions\n' +
                   '• Use `/help <command>` for detailed command info\n' +
                   '• Refresh button gets data updated every 60 seconds\n' +
                   '• All messages are private (only you can see them)',
            inline: false
          }
        ])
        .setFooter({ text: 'Use the buttons below for quick access' })
        .setTimestamp();
      
      // Create action buttons for quick access
      const actionRow1 = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('check_status')
            .setLabel('Check Status')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📊'),
          new ButtonBuilder()
            .setCustomId('setup_notifications')
            .setLabel('Notification Info')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔔')
        );
      
      await interaction.reply({
        embeds: [helpEmbed],
        components: [actionRow1],
        ephemeral: true
      });
      break;
    
    // Onboarding message buttons (server messages)
    case 'setup_notifications':
      const notifEmbed = new EmbedBuilder()
        .setTitle('🔔 Notification System')
        .setDescription(`This bot sends you DM alerts when **${serverUrl}** needs attention.`)
        .setColor(0xFFAA00)
        .addFields([
          {
            name: '🖥️ Monitoring Server',
            value: `\`${serverUrl}\`\n\nThis bot monitors the backend server at this URL and sends you alerts when issues arise.`,
            inline: false
          },
          {
            name: ' How It Works',
            value: 'Notifications are managed through server configuration. Your server admin has already set you up to receive alerts!',
            inline: false
          },
          {
            name: '🚨 When You\'ll Get Notified',
            value: '• **Elevated Load** - System under moderate stress\n' +
                   '• **Heavy Load** - Resources becoming constrained\n' +
                   '• **Critical Status** - Immediate attention needed\n' +
                   '• **Incident Updates** - Status changes and resolutions',
            inline: false
          },
          {
            name: '✅ You\'re All Set!',
            value: `Your Discord User ID (\`${interaction.user.id}\`) is configured to receive notifications. You'll get DMs automatically when system issues arise.`,
            inline: false
          },
          {
            name: '🔕 Want to Stop Notifications?',
            value: 'Contact your server administrator to remove your User ID from the `DISCORD_NOTIFY_USERS` environment variable.',
            inline: false
          },
          {
            name: '💡 Pro Tip',
            value: 'Make sure you have DMs enabled from server members to receive notifications!',
            inline: false
          }
        ])
        .setFooter({ text: 'Notifications are sent based on real-time system monitoring' })
        .setTimestamp();
      
      await interaction.reply({
        embeds: [notifEmbed],
        components: [createHelpButtonRow()],
        ephemeral: true
      });
      break;
      
    case 'view_commands':
      const commands = Array.from(client.commands.values());
      const commandList = commands.map(cmd =>
        `• **/${cmd.data.name}** - ${cmd.data.description}`
      ).join('\n');
      
      await interaction.reply({
        content: '📋 **Available Commands**\n\n' + commandList + '\n\nUse `/help <command>` for detailed information.',
        components: [createHelpButtonRow()],
        ephemeral: true
      });
      break;
    
    // Tasks command buttons - Simple and Detailed views
    case 'tasks_simple':
    case 'tasks_refresh_simple':
    case 'tasks_detailed':
    case 'tasks_refresh_detailed':
      await interaction.deferReply({ ephemeral: true });
      
      try {
        const adminUser = await getAdminByDiscordId(interaction.user.id);
        if (!adminUser) {
          await interaction.editReply({
            content: '❌ **Admin Privileges Required**\n\nYou must be an administrator to view task information.',
            components: []
          });
          return;
        }
        
        const apiClient = new ServerApiClient();
        const taskData = await apiClient.getTasks();
        
        const summary = taskData.summary || {};
        const serverName = serverUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
        const isDetailed = customId.includes('detailed');
        
        const tasksEmbed = new EmbedBuilder()
          .setTitle(`📊 ${serverName} - Task Manager${isDetailed ? ' (Detailed)' : ''}`)
          .setDescription(`**Active:** ${summary.totalActiveTasks || 0} tasks\n**Queued:** ${summary.totalQueued || 0} tasks`)
          .setColor(0x0099FF)
          .setFooter({ text: `Task Manager • Monitoring: ${serverUrl}` })
          .setTimestamp();
        
        // Add active tasks
        if (taskData.activeTasks && taskData.activeTasks.length > 0) {
          const taskList = taskData.activeTasks.map(task => {
            const seconds = Math.floor(task.runningForMs / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            const runtime = hours > 0 ? `${hours}h ${minutes % 60}m ${seconds % 60}s` :
                           minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
            
            if (isDetailed) {
              return `**${task.type}** (ID: ${task.id})\n├ ${task.name}\n└ Running for: ${runtime}`;
            } else {
              return `• **${task.type}** - ${runtime}`;
            }
          }).join(isDetailed ? '\n\n' : '\n');
          
          tasksEmbed.addFields([{
            name: `⚙️ Active Tasks (${taskData.activeTasks.length})`,
            value: taskList.length > 1024 ? taskList.substring(0, 1021) + '...' : taskList,
            inline: false
          }]);
        } else {
          tasksEmbed.addFields([{
            name: '⚙️ Active Tasks',
            value: 'No active tasks',
            inline: false
          }]);
        }
        
        // Add queue info (detailed only shows all, simple shows only non-zero)
        if (isDetailed && taskData.queueSizes && Object.keys(taskData.queueSizes).length > 0) {
          const queueEntries = Object.entries(taskData.queueSizes)
            .sort((a, b) => b[1].size - a[1].size);
          
          const queueList = queueEntries
            .map(([type, info]) => `• **${type}**: ${info.size} ${info.size === 1 ? 'task' : 'tasks'}`)
            .join('\n');
          
          tasksEmbed.addFields([{
            name: '📋 Task Queues',
            value: queueList.length > 1024 ? queueList.substring(0, 1021) + '...' : queueList,
            inline: false
          }]);
        }
        
        // Add completion history
        if (taskData.completionHistory && Object.keys(taskData.completionHistory).length > 0) {
          const importantTypes = ['Media Scan', 'Movie Scan', 'TV Show Scan'];
          const relevantHistory = isDetailed
            ? Object.entries(taskData.completionHistory)
            : Object.entries(taskData.completionHistory).filter(([type]) => importantTypes.includes(type));
          
          if (relevantHistory.length > 0) {
            const numRuns = isDetailed ? 3 : 1;
            const historyList = relevantHistory.map(([type, history]) => {
              const recentRuns = history.slice(0, numRuns);
              const runDetails = recentRuns.map((run, idx) => {
                const agoMs = run.completedAgo;
                const agoMinutes = Math.floor(agoMs / 60000);
                const agoHours = Math.floor(agoMinutes / 60);
                const ago = agoHours > 0 ? `${agoHours}h ago` : `${agoMinutes}m ago`;
                
                const durationMs = run.durationMs;
                const durationSeconds = Math.floor(durationMs / 1000);
                const durationMinutes = Math.floor(durationSeconds / 60);
                const duration = durationMinutes > 0 ? `${durationMinutes}m ${durationSeconds % 60}s` : `${durationSeconds}s`;
                
                if (isDetailed) {
                  return `  ${idx + 1}. ${duration} - ${ago}`;
                } else {
                  return `Last: ${duration} (${ago})`;
                }
              }).join('\n');
              return `**${type}**\n${runDetails}`;
            }).join('\n\n');
            
            tasksEmbed.addFields([{
              name: isDetailed ? '📊 Task Completion History' : '📊 Recent Scans',
              value: historyList.length > 1024 ? historyList.substring(0, 1021) + '...' : historyList,
              inline: false
            }]);
          }
        }
        
        await interaction.editReply({
          embeds: [tasksEmbed],
          components: [isDetailed ? createTasksDetailedButtonRow() : createTasksSimpleButtonRow()]
        });
      } catch (error) {
        logger.error(`Error fetching tasks: ${error.message}`);
        await interaction.editReply({
          content: `❌ Failed to fetch task information: ${error.message}`,
          components: [createHelpButtonRow()]
        });
      }
      break;
      
    // Tasks command button - Show help
    case 'tasks_help':
      const tasksHelpEmbed = new EmbedBuilder()
        .setTitle('📖 Task Manager Help')
        .setDescription('The Task Manager monitors background processing tasks on your media server.')
        .setColor(0x0099FF)
        .addFields([
          {
            name: '🖥️ Monitoring Server',
            value: `\`${serverUrl}\`\n\nThis shows real-time task information from your backend server.`,
            inline: false
          },
          {
            name: '⚙️ Task Types',
            value: '• **Media Scan** - Scanning media library\n' +
                   '• **Movie/TV Scan** - Type-specific scans\n' +
                   '• **TMDB Download** - Fetching metadata\n' +
                   '• **Blurhash** - Generating image hashes\n' +
                   '• **System Monitoring** - Health checks',
            inline: false
          },
          {
            name: '📊 What You See',
            value: '• **Active Tasks** - Currently running\n' +
                   '• **Queued Tasks** - Waiting to run\n' +
                   '• **Recent Scans** - Last completion times',
            inline: false
          },
          {
            name: '💬 Slash Commands',
            value: '• `/tasks` - View task status\n' +
                   '• `/tasks action:history` - View completion history\n' +
                   '• `/tasks detailed:true` - Extended information\n' +
                   '• `/tasks type:MediaScan` - Filter by type',
            inline: false
          },
          {
            name: '🔘 Buttons',
            value: '• **Refresh** - Update task information\n' +
                   '• **Help** - Show this help message\n' +
                   '• **System Status** - Check server health',
            inline: false
          }
        ])
        .setFooter({ text: 'Admin access required • Use buttons for quick actions' })
        .setTimestamp();
      
      await interaction.reply({
        embeds: [tasksHelpEmbed],
        components: [createTasksSimpleButtonRow()],
        ephemeral: true
      });
      break;
      
    default:
      logger.warn(`Unknown button interaction: ${customId}`);
      await interaction.reply({
        content: '❓ Unknown button action',
        components: [createHelpButtonRow()],
        ephemeral: true
      });
  }
}

// Helper functions
function getEmojiForStatus(status) {
  const emojis = {
    normal: '✅',
    elevated: '⚠️',
    heavy: '🔶',
    critical: '🚨'
  };
  return emojis[status] || '📊';
}

function getColorForStatus(status) {
  const colors = {
    normal: 0x00FF00,    // Green
    elevated: 0xFFFF00,  // Yellow
    heavy: 0xFFA500,     // Orange
    critical: 0xFF0000   // Red
  };
  return colors[status] || 0x0099FF;
}

/**
 * Handle select menu interactions
 */
async function handleSelectMenuInteraction(interaction, client) {
  // To be implemented based on specific select menus
  await interaction.reply({
    content: 'Select menu interaction received',
    ephemeral: true
  });
}