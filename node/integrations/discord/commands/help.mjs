import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Get help with bot commands')
  .addStringOption(option =>
    option
      .setName('command')
      .setDescription('Get help for a specific command')
      .setRequired(false)
  );

export async function execute(interaction, client) {
  const commandName = interaction.options.getString('command');
  
  if (commandName) {
    // Show help for specific command
    const command = client.commands.get(commandName);
    
    if (!command) {
      return interaction.reply({
        content: `❌ Command \`${commandName}\` not found. Use \`/help\` to see all commands.`,
        ephemeral: true
      });
    }
    
    const embed = new EmbedBuilder()
      .setTitle(`📚 Help: /${command.data.name}`)
      .setDescription(command.data.description)
      .setColor(0x0099FF);
    
    // Add options if any
    if (command.data.options && command.data.options.length > 0) {
      const options = command.data.options.map(opt => 
        `• **${opt.name}** (${opt.required ? 'required' : 'optional'}): ${opt.description}`
      ).join('\n');
      
      embed.addFields([{ name: 'Options', value: options }]);
    }
    
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
  // Show all commands
  const embed = new EmbedBuilder()
    .setTitle('📚 Bot Commands')
    .setDescription('Here are all available commands:')
    .setColor(0x0099FF);
  
  const categories = {
    'Server Monitoring': [],
    'Utilities': []
  };
  
  client.commands.forEach(command => {
    const category = getCommandCategory(command.data.name);
    const line = `**/${command.data.name}** - ${command.data.description}`;
    
    if (categories[category]) {
      categories[category].push(line);
    }
  });
  
  // Add fields for each category
  Object.entries(categories).forEach(([category, commands]) => {
    if (commands.length > 0) {
      embed.addFields([{
        name: category,
        value: commands.join('\n'),
        inline: false
      }]);
    }
  });
  
  embed.addFields([{
    name: '💡 Tip',
    value: 'Use `/help <command>` to get detailed information about a specific command.',
    inline: false
  }]);
  
  embed.setFooter({ text: 'For more help, check the documentation' });
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

function getCommandCategory(commandName) {
  const monitoringCommands = ['status', 'incidents', 'health'];
  const utilityCommands = ['help', 'ping'];
  
  if (monitoringCommands.includes(commandName)) {
    return 'Server Monitoring';
  } else if (utilityCommands.includes(commandName)) {
    return 'Utilities';
  }
  
  return 'Other';
}