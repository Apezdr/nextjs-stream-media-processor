import { Client, GatewayIntentBits, Collection, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createCategoryLogger } from '../../lib/logger.mjs';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  createAlertEmbed,
  createGuildOnboardingEmbed
} from './utils/messageTemplates.mjs';
import { sendIntroductionDM as sendIntroDM } from './utils/introductionDM.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createCategoryLogger('discordBot');
const isDebugMode = process.env.DEBUG === 'TRUE';

/**
 * Discord Bot Adapter - Interactive bot for server monitoring and control
 * Provides slash commands, DM notifications, and server management capabilities
 */
export class DiscordBotAdapter {
  constructor(config = {}) {
    this.token = config.token || process.env.DISCORD_BOT_TOKEN;
    this.clientId = config.clientId || process.env.DISCORD_CLIENT_ID;
    this.guildId = config.guildId || process.env.DISCORD_GUILD_ID;
    this.serverApiUrl = config.serverApiUrl || process.env.SERVER_API_URL || process.env.FILE_SERVER_NODE_URL;
    this.serverApiKey = config.serverApiKey || process.env.SERVER_API_KEY;
    
    if (!this.token || !this.clientId) {
      throw new Error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required');
    }
    
    this.client = null;
    this.commands = new Collection();
    this.ready = false;
  }
  
  /**
   * Initialize the Discord bot
   */
  async initialize() {
    try {
      logger.info('Initializing Discord bot...');
      
      // Create Discord client with necessary intents
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages
        ]
      });
      
      // Store reference to adapter in client
      this.client.botAdapter = this;
      
      // Load commands and events
      await this.loadCommands();
      await this.loadEvents();
      
      // Register commands with Discord
      await this.registerCommands();
      
      // Login to Discord
      await this.client.login(this.token);
      
      logger.info('Discord bot initialized successfully');
    } catch (error) {
      logger.error(`Failed to initialize Discord bot: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Load all command files from the commands directory
   */
  async loadCommands() {
    const commandsPath = join(__dirname, 'commands');
    const commandFiles = readdirSync(commandsPath).filter(file => file.endsWith('.mjs'));
    
    for (const file of commandFiles) {
      const filePath = join(commandsPath, file);
      const command = await import(`file://${filePath}`);
      
      if ('data' in command && 'execute' in command) {
        this.commands.set(command.data.name, command);
        logger.info(`Loaded command: /${command.data.name}`);
      } else {
        logger.warn(`Command at ${file} is missing required "data" or "execute" property`);
      }
    }
    
    // Store commands in client for easy access
    this.client.commands = this.commands;
  }
  
  /**
   * Load all event handlers from the events directory
   */
  async loadEvents() {
    const eventsPath = join(__dirname, 'events');
    const eventFiles = readdirSync(eventsPath).filter(file => file.endsWith('.mjs'));
    
    for (const file of eventFiles) {
      const filePath = join(eventsPath, file);
      const event = await import(`file://${filePath}`);
      
      if (event.once) {
        this.client.once(event.name, (...args) => event.execute(...args, this.client));
      } else {
        this.client.on(event.name, (...args) => event.execute(...args, this.client));
      }
      
      logger.info(`Loaded event: ${event.name}`);
    }
  }
  
  /**
   * Register slash commands with Discord
   */
  async registerCommands() {
    const rest = new REST({ version: '10' }).setToken(this.token);
    const commandsData = Array.from(this.commands.values()).map(cmd => cmd.data.toJSON());
    
    try {
      logger.info(`Registering ${commandsData.length} slash commands...`);
      
      if (this.guildId) {
        // Guild-specific (faster for development)
        await rest.put(
          Routes.applicationGuildCommands(this.clientId, this.guildId),
          { body: commandsData }
        );
        logger.info(`Successfully registered commands for guild ${this.guildId}`);
      } else {
        // Global registration (takes up to 1 hour to propagate)
        await rest.put(
          Routes.applicationCommands(this.clientId),
          { body: commandsData }
        );
        logger.info('Successfully registered global commands');
      }
    } catch (error) {
      logger.error(`Failed to register commands: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Send a DM to a specific user
   * @param {string} userId - Discord user ID
   * @param {string} status - System status level
   * @param {string} message - Status message
   * @param {object} metrics - System metrics
   * @param {object} incident - Incident information
   */
  async sendDM(userId, status, message, metrics, incident) {
    try {
      const user = await this.client.users.fetch(userId);
      
      // Use centralized template
      const embedData = createAlertEmbed(status, message, metrics, incident);
      const embed = new EmbedBuilder(embedData);
      
      await user.send({ embeds: [embed] });
      logger.info(`Sent DM to user ${userId}`);
      
      return { success: true, userId };
    } catch (error) {
      logger.error(`Failed to send DM to user ${userId}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Send introduction DM to a user using centralized utility
   * @param {string} userId - Discord user ID
   */
  async sendIntroductionDM(userId) {
    try {
      const user = await this.client.users.fetch(userId);
      const serverUrl = this.serverApiUrl || 'Unknown Server';
      
      // Use centralized intro DM utility
      const result = await sendIntroDM(userId, user.username, {
        botToken: this.token,
        serverUrl: serverUrl,
        botTag: this.client.user.tag
      });
      
      if (result.success) {
        logger.info(`Sent introduction DM to user ${userId} (${user.username})`);
      }
      
      return result;
    } catch (error) {
      logger.error(`Failed to send introduction DM to user ${userId}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Send onboarding message to a guild when bot joins
   * @param {Guild} guild - Discord guild object
   */
  async sendOnboardingMessage(guild) {
    try {
      // Find a suitable channel to send the message (system channel or first text channel)
      const channel = guild.systemChannel ||
                     guild.channels.cache.find(ch => ch.type === 0 && ch.permissionsFor(guild.members.me).has('SendMessages'));
      
      if (!channel) {
        logger.warn(`No suitable channel found in guild ${guild.name} for onboarding message`);
        return;
      }
      
      // Use centralized template
      const embedData = createGuildOnboardingEmbed();
      const embed = new EmbedBuilder(embedData);
      
      // Convert plain component objects to Discord.js builders
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('setup_notifications')
            .setLabel('Setup Notifications')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🔔'),
          new ButtonBuilder()
            .setCustomId('view_commands')
            .setLabel('View Commands')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📋'),
          new ButtonBuilder()
            .setLabel('Documentation')
            .setStyle(ButtonStyle.Link)
            .setURL('https://github.com/Apezdr/nextjs-stream/blob/main/README.md')
            .setEmoji('📚')
        );
      
      await channel.send({ embeds: [embed], components: [row] });
      logger.info(`Sent onboarding message to guild: ${guild.name}`);
    } catch (error) {
      logger.error(`Failed to send onboarding message: ${error.message}`);
    }
  }
  
  /**
   * Shutdown the bot gracefully
   */
  async shutdown() {
    logger.info('Shutting down Discord bot...');
    if (this.client) {
      this.client.destroy();
    }
    this.ready = false;
    logger.info('Discord bot shut down successfully');
  }
}

export default DiscordBotAdapter;