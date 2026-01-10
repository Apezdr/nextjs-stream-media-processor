/**
 * Discord Integration Module
 * Exports both webhook and bot adapters for Discord notifications
 */

export { DiscordAdapter as DiscordWebhookAdapter } from './webhook.mjs';
export { DiscordBotAdapter } from './bot.mjs';

// Re-export for backward compatibility
export { DiscordAdapter } from './webhook.mjs';