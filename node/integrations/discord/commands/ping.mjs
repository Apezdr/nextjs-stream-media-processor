import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check if the bot is responsive');

export async function execute(interaction) {
  const sent = await interaction.reply({ 
    content: '🏓 Pinging...', 
    fetchReply: true,
    ephemeral: true
  });
  
  const latency = sent.createdTimestamp - interaction.createdTimestamp;
  const apiLatency = Math.round(interaction.client.ws.ping);
  
  await interaction.editReply(
    `🏓 Pong!\n` +
    `**Roundtrip Latency:** ${latency}ms\n` +
    `**WebSocket Latency:** ${apiLatency}ms`
  );
}