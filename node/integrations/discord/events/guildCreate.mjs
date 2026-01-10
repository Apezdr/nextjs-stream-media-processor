import { createCategoryLogger } from '../../../lib/logger.mjs';

const logger = createCategoryLogger('discordBot:guildCreate');

export const name = 'guildCreate';
export const once = false;

export async function execute(guild, client) {
  logger.info(`Bot joined new guild: ${guild.name} (ID: ${guild.id})`);
  logger.info(`Guild has ${guild.memberCount} members`);
  
  // Send onboarding message
  if (client.botAdapter) {
    try {
      await client.botAdapter.sendOnboardingMessage(guild);
    } catch (error) {
      logger.error(`Failed to send onboarding message: ${error.message}`);
    }
  }
}