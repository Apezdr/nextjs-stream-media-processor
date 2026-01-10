import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

/**
 * Centralized button row builders for Discord bot
 * This ensures consistent button definitions across commands and event handlers
 */

/**
 * Create button row for simple status view
 * @returns {ActionRowBuilder} Action row with buttons
 */
export function createSimpleViewButtonRow() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('status_detailed')
        .setLabel('Detailed View')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📈'),
      new ButtonBuilder()
        .setCustomId('status_refresh_simple')
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔄'),
      new ButtonBuilder()
        .setCustomId('view_help')
        .setLabel('Help')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('❓')
    );
}

/**
 * Create button row for detailed status view
 * @returns {ActionRowBuilder} Action row with buttons
 */
export function createDetailedViewButtonRow() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('status_simple')
        .setLabel('Simple View')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📊'),
      new ButtonBuilder()
        .setCustomId('status_refresh_detailed')
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔄'),
      new ButtonBuilder()
        .setCustomId('view_help')
        .setLabel('Help')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('❓')
    );
}

/**
 * Create button row for tasks simple view (will show detailed option)
 * @returns {ActionRowBuilder} Action row with tasks buttons
 */
export function createTasksSimpleButtonRow() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('tasks_detailed')
        .setLabel('Detailed View')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📈'),
      new ButtonBuilder()
        .setCustomId('tasks_refresh_simple')
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔄'),
      new ButtonBuilder()
        .setCustomId('tasks_help')
        .setLabel('Help')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('❓')
    );
}

/**
 * Create button row for tasks detailed view (will show simple option)
 * @returns {ActionRowBuilder} Action row with tasks buttons
 */
export function createTasksDetailedButtonRow() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('tasks_simple')
        .setLabel('Simple View')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📊'),
      new ButtonBuilder()
        .setCustomId('tasks_refresh_detailed')
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔄'),
      new ButtonBuilder()
        .setCustomId('tasks_help')
        .setLabel('Help')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('❓')
    );
}

/**
 * Create a simple help button row
 * @returns {ActionRowBuilder} Action row with help button
 */
export function createHelpButtonRow() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('view_help')
        .setLabel('Help')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('❓')
    );
}