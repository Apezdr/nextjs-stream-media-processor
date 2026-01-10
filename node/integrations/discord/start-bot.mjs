#!/usr/bin/env node

/**
 * Discord Bot Standalone Starter
 * Run this file to start the Discord bot independently of the main server
 * 
 * Usage:
 *   node node/integrations/discord/start-bot.mjs
 *   npm run discord-bot (if added to package.json scripts)
 */

import { DiscordBotAdapter } from './bot.mjs';
import { createCategoryLogger } from '../../lib/logger.mjs';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from project root
const rootDir = join(__dirname, '../../..');
config({ path: join(rootDir, '.env') });
config({ path: join(rootDir, '.env.local') });

const logger = createCategoryLogger('discordBotStarter');

// Validate required environment variables
const requiredVars = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'SERVER_API_URL'
];

const missingVars = requiredVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
  logger.error('Missing required environment variables:');
  missingVars.forEach(v => logger.error(`  - ${v}`));
  logger.error('\nPlease configure these variables in your .env file');
  logger.error('See node/integrations/discord/README.md for setup instructions');
  process.exit(1);
}

// Log configuration (hide sensitive data)
logger.info('Starting Discord Bot with configuration:');
logger.info(`  Client ID: ${process.env.DISCORD_CLIENT_ID}`);
logger.info(`  Guild ID: ${process.env.DISCORD_GUILD_ID || 'Not set (global commands)'}`);
logger.info(`  Server API: ${process.env.SERVER_API_URL}`);
logger.info(`  Debug Mode: ${process.env.DEBUG === 'TRUE' ? 'Enabled' : 'Disabled'}`);

// Create and initialize bot
const bot = new DiscordBotAdapter();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  await bot.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  await bot.shutdown();
  process.exit(0);
});

// Handle unhandled errors
process.on('unhandledRejection', (error) => {
  logger.error(`Unhandled promise rejection: ${error.message}`);
  console.error(error);
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.message}`);
  console.error(error);
  process.exit(1);
});

// Start the bot
(async () => {
  try {
    await bot.initialize();
    logger.info('Discord bot is running. Press Ctrl+C to stop.');
  } catch (error) {
    logger.error(`Failed to start bot: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
})();