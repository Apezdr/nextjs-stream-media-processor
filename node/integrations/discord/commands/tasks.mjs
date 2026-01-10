import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { ServerApiClient } from '../utils/serverApi.mjs';
import { getAdminByDiscordId } from '../../../database.mjs';
import { createCategoryLogger } from '../../../lib/logger.mjs';
import { createTasksSimpleButtonRow, createTasksDetailedButtonRow } from '../utils/buttonRows.mjs';

const logger = createCategoryLogger('discordBot:tasksCommand');

export const data = new SlashCommandBuilder()
  .setName('tasks')
  .setDescription('Monitor background task manager status (Admin only)')
  .addStringOption(option =>
    option
      .setName('action')
      .setDescription('What to display')
      .setRequired(false)
      .addChoices(
        { name: 'Status (Active & Queued)', value: 'status' },
        { name: 'History (Recent Completions)', value: 'history' }
      )
  )
  .addBooleanOption(option =>
    option
      .setName('detailed')
      .setDescription('Show detailed task information')
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('type')
      .setDescription('Filter by task type')
      .setRequired(false)
      .addChoices(
        { name: 'API Request', value: 'API Request' },
        { name: 'System Monitoring', value: 'System Monitoring' },
        { name: 'Media Scan', value: 'Media Scan' },
        { name: 'Movie Scan', value: 'Movie Scan' },
        { name: 'TV Show Scan', value: 'TV Show Scan' },
        { name: 'Metadata Hash', value: 'Metadata Hash' },
        { name: 'Blurhash', value: 'Blurhash' },
        { name: 'TMDB Download', value: 'TMDB Download' },
        { name: 'Cache Cleanup', value: 'Cache Cleanup' }
      )
  )
  .addBooleanOption(option =>
    option
      .setName('ephemeral')
      .setDescription('Show response only to you')
      .setRequired(false)
  );

export async function execute(interaction, client) {
  const action = interaction.options.getString('action') ?? 'status';
  const detailed = interaction.options.getBoolean('detailed') ?? false;
  const typeFilter = interaction.options.getString('type');
  const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;
  
  // Defer reply since API call might take time
  await interaction.deferReply({ ephemeral });
  
  try {
    // Verify user is an admin in the frontend MongoDB database
    // This requires the user to have linked their Discord account to their frontend account
    const adminUser = await getAdminByDiscordId(interaction.user.id);
    
    if (!adminUser) {
      return await interaction.editReply({
        content: '❌ **Admin Privileges Required**\n\n' +
                 'This command requires administrator access on the media server frontend.\n\n' +
                 '**Requirements:**\n' +
                 '• You must have an admin account on the media server frontend\n' +
                 '• Your Discord account must be linked to your admin account\n\n' +
                 'Please contact a server administrator if you believe this is an error.',
        embeds: []
      });
    }
    
    // Log the admin action
    logger.info(`Admin ${adminUser.email} (Discord: ${interaction.user.tag}) accessed task manager`);
    
    const apiClient = new ServerApiClient(
      client.botAdapter.serverApiUrl,
      client.botAdapter.serverApiKey
    );
    
    const taskData = await apiClient.getTasks();
    
    // Filter tasks if type filter is specified
    let activeTasks = taskData.activeTasks || [];
    if (typeFilter) {
      activeTasks = activeTasks.filter(task => task.type === typeFilter);
    }
    
    // Get server URL and extract name from it (consistent with button handlers)
    const serverUrl = client.botAdapter?.serverApiUrl || process.env.FILE_SERVER_NODE_URL || 'Unknown Server';
    const serverName = serverUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    
    // Create embed
    const embed = new EmbedBuilder()
      .setTitle(`📊 ${serverName} - Task Manager`)
      .setColor(0x0099FF)
      .setTimestamp()
      .setFooter({ text: `Task Manager • Monitoring: ${serverUrl}` });
    
    // Handle different actions
    if (action === 'history') {
      // History view - show only completion history
      embed.setDescription('**Recent Task Completion History**');
      
      if (typeFilter) {
        embed.setDescription(`**Recent Task Completion History**\nFilter: ${typeFilter}`);
      }
    } else {
      // Status view - show active and queued tasks
      const summary = taskData.summary || {};
      let description = `**Active:** ${summary.totalActiveTasks || 0} tasks\n`;
      description += `**Queued:** ${summary.totalQueued || 0} tasks`;
      
      if (typeFilter) {
        description += `\n**Filter:** ${typeFilter}`;
      }
      
      embed.setDescription(description);
    }
    
    // Show active tasks only in status view
    if (action === 'status') {
      if (activeTasks.length > 0) {
        const taskList = activeTasks.map(task => {
          const runtime = formatRuntime(task.runningForMs);
          if (detailed) {
            return `**${task.type}** (ID: ${task.id})\n` +
                   `└ ${task.name}\n` +
                   `└ Running for: ${runtime}`;
          } else {
            return `• **${task.type}** - ${runtime}`;
          }
        }).join('\n');
        
        embed.addFields([
          {
            name: `⚙️ Active Tasks (${activeTasks.length})`,
            value: taskList.length > 1024 ? taskList.substring(0, 1021) + '...' : taskList,
            inline: false
          }
        ]);
      } else {
        embed.addFields([
          {
            name: '⚙️ Active Tasks',
            value: 'No active tasks',
            inline: false
          }
        ]);
      }
    }
    
    // Show queue information only in status view
    if (action === 'status' && (detailed || Object.keys(taskData.queueSizes || {}).length > 0)) {
      const queueSizes = taskData.queueSizes || {};
      const queueEntries = Object.entries(queueSizes);
      
      // Filter queues if type filter is specified
      const filteredQueues = typeFilter
        ? queueEntries.filter(([type]) => type === typeFilter)
        : queueEntries;
      
      if (filteredQueues.length > 0) {
        // Only show queues with items or if detailed view
        const visibleQueues = detailed
          ? filteredQueues
          : filteredQueues.filter(([, info]) => info.size > 0);
        
        if (visibleQueues.length > 0) {
          const queueList = visibleQueues
            .sort((a, b) => b[1].size - a[1].size) // Sort by queue size descending
            .map(([type, info]) => `• **${type}**: ${info.size} ${info.size === 1 ? 'task' : 'tasks'}`)
            .join('\n');
          
          embed.addFields([
            {
              name: '📋 Task Queues',
              value: queueList.length > 1024 ? queueList.substring(0, 1021) + '...' : queueList,
              inline: false
            }
          ]);
        }
      }
    }
    
    // Show completion history
    if (taskData.completionHistory && Object.keys(taskData.completionHistory).length > 0) {
      const completionHistory = taskData.completionHistory;
      
      // In history view, show all task types. In status view, show important types
      const importantTypes = ['Media Scan', 'Movie Scan', 'TV Show Scan'];
      const relevantHistory = typeFilter
        ? Object.entries(completionHistory).filter(([type]) => type === typeFilter)
        : (action === 'history'
            ? Object.entries(completionHistory)
            : Object.entries(completionHistory).filter(([type]) => importantTypes.includes(type)));
      
      if (relevantHistory.length > 0) {
        // In history view or detailed mode, show 3 runs. Otherwise show 1
        const numRuns = (action === 'history' || detailed) ? 3 : 1;
        
        const historyList = relevantHistory
          .map(([type, history]) => {
            const recentRuns = history.slice(0, numRuns);
            const runDetails = recentRuns.map((run, idx) => {
              const ago = formatTimeSince(run.completedAgo);
              const duration = formatDuration(run.durationMs);
              if (action === 'history' || detailed) {
                return `  ${idx + 1}. ${duration} - ${ago}`;
              } else {
                return `Last: ${duration} (${ago})`;
              }
            }).join('\n');
            return `**${type}**\n${runDetails}`;
          })
          .join('\n\n');
        
        const fieldName = action === 'history' ? '📊 Task Completion History' : '📊 Recent Scan History';
        embed.addFields([
          {
            name: fieldName,
            value: historyList.length > 1024 ? historyList.substring(0, 1021) + '...' : historyList,
            inline: false
          }
        ]);
      }
    } else if (action === 'history') {
      embed.addFields([
        {
          name: '📊 Task Completion History',
          value: 'No completed tasks in history yet.',
          inline: false
        }
      ]);
    }
    
    // Add helpful footer if no tasks are running (status view only)
    if (action === 'status' && activeTasks.length === 0 && (taskData.summary?.totalQueued || 0) === 0) {
      embed.addFields([
        {
          name: '💡 Status',
          value: 'All systems idle - no background tasks active or queued.',
          inline: false
        }
      ]);
    }
    
    // Use centralized button rows - defaulting to simple for initial view
    const buttonRow = detailed ? createTasksDetailedButtonRow() : createTasksSimpleButtonRow();
    
    await interaction.editReply({
      embeds: [embed],
      components: [buttonRow]
    });
    
  } catch (error) {
    logger.error(`Error fetching task status: ${error.message}`);
    await interaction.editReply({
      content: '❌ Failed to fetch task manager status. Please check if the backend server is running and API is configured correctly.',
      embeds: []
    });
  }
}

/**
 * Format runtime in milliseconds to human-readable string
 * @param {number} ms - Runtime in milliseconds
 * @returns {string} Formatted runtime
 */
function formatRuntime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Format time since completion to human-readable string
 * @param {number} ms - Time in milliseconds since completion
 * @returns {string} Formatted time
 */
function formatTimeSince(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    return `${days}d ago`;
  } else if (hours > 0) {
    return `${hours}h ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return `${seconds}s ago`;
  }
}