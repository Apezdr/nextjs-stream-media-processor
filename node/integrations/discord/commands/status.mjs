import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { ServerApiClient } from '../utils/serverApi.mjs';
import { createCategoryLogger } from '../../../lib/logger.mjs';

const logger = createCategoryLogger('discordBot:statusCommand');

export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Check current server health status')
  .addBooleanOption(option =>
    option
      .setName('detailed')
      .setDescription('Show detailed metrics')
      .setRequired(false)
  )
  .addBooleanOption(option =>
    option
      .setName('ephemeral')
      .setDescription('Show response only to you')
      .setRequired(false)
  );

export async function execute(interaction, client) {
  const detailed = interaction.options.getBoolean('detailed') ?? false;
  const ephemeral = interaction.options.getBoolean('ephemeral') ?? true;
  
  // Defer reply since API call might take time
  await interaction.deferReply({ ephemeral });
  
  try {
    const apiClient = new ServerApiClient(
      client.botAdapter.serverApiUrl,
      client.botAdapter.serverApiKey
    );
    
    const statusData = await apiClient.getSystemStatus();
    
    // Determine color based on status
    const colors = {
      normal: 0x00FF00,    // Green
      elevated: 0xFFFF00,  // Yellow
      heavy: 0xFFA500,     // Orange
      critical: 0xFF0000   // Red
    };
    
    // Determine emoji based on status
    const emojis = {
      normal: '✅',
      elevated: '⚠️',
      heavy: '🔶',
      critical: '🚨'
    };
    
    const status = statusData.status || 'unknown';
    const color = colors[status] || 0x0099FF;
    const emoji = emojis[status] || '📊';
    
    const embed = new EmbedBuilder()
      .setTitle(`${emoji} Server Status: ${status.toUpperCase()}`)
      .setDescription(statusData.message || 'No status message available')
      .setColor(color)
      .setTimestamp()
      .setFooter({ text: 'Last updated' });
    
    // Add basic metrics
    if (statusData.metrics) {
      const fields = [];
      
      if (statusData.metrics.cpu) {
        fields.push({
          name: '💻 CPU Usage',
          value: `${statusData.metrics.cpu.usage}%${detailed ? `\nCores: ${statusData.metrics.cpu.cores}` : ''}`,
          inline: true
        });
      }
      
      if (statusData.metrics.memory) {
        fields.push({
          name: '🧠 Memory Usage',
          value: `${statusData.metrics.memory.usage}%${detailed ? `\n${statusData.metrics.memory.used} / ${statusData.metrics.memory.total}` : ''}`,
          inline: true
        });
      }
      
      if (statusData.metrics.disk) {
        fields.push({
          name: '💾 Disk Usage',
          value: `${statusData.metrics.disk.usage}%${detailed ? `\n${statusData.metrics.disk.free} free` : ''}`,
          inline: true
        });
      }
      
      // Add detailed disk I/O if requested
      if (detailed && statusData.metrics.disk?.io) {
        fields.push({
          name: '📊 Disk I/O',
          value: `Read: ${statusData.metrics.disk.io.read_sec}/s\nWrite: ${statusData.metrics.disk.io.write_sec}/s`,
          inline: true
        });
      }
      
      // Add processes if detailed
      if (detailed && statusData.metrics.processes) {
        fields.push({
          name: '⚙️ Processes',
          value: `Total: ${statusData.metrics.processes.total}\nRunning: ${statusData.metrics.processes.running}`,
          inline: true
        });
      }
      
      embed.addFields(fields);
    }
    
    // Add incident information if present
    if (statusData.incident && statusData.incident.status !== 'resolved') {
      embed.addFields([
        {
          name: '🚨 Active Incident',
          value: `**ID:** ${statusData.incident.id}\n` +
                 `**Status:** ${statusData.incident.status}\n` +
                 `**Started:** <t:${Math.floor(new Date(statusData.incident.startTime).getTime() / 1000)}:R>` +
                 (statusData.incident.updates ? `\n**Updates:** ${statusData.incident.updates.length}` : ''),
          inline: false
        }
      ]);
    }
    
    await interaction.editReply({ embeds: [embed] });
    
  } catch (error) {
    logger.error(`Error fetching status: ${error.message}`);
    await interaction.editReply({
      content: '❌ Failed to fetch server status. Please check if the backend server is running and API is configured correctly.',
      embeds: []
    });
  }
}