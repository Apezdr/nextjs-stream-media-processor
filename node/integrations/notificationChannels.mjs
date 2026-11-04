/**
 * The notification channels in the environment, read without logging or
 * importing anything heavy: the alert intake reads them per send, and
 * integrations/index.mjs (which pulls in the Discord bot and Mongo) builds on
 * them.
 */

/**
 * The notification channels configured in `env`, read without logging:
 * legacy frontend pairs (FRONT_END_<n> + WEBHOOK_ID_<n>), then the unified
 * NOTIFICATION_<n>_TYPE / _URL / _COOLDOWN / _WEBHOOK_ID set. Each list stops
 * at its first gap, as it always has.
 * @returns {Array<object>}
 */
export function readNotificationChannels(env = process.env) {
  const channels = [];
  for (let index = 1; env[`FRONT_END_${index}`] && env[`WEBHOOK_ID_${index}`]; index += 1) {
    channels.push({
      type: 'frontend',
      source: 'legacy',
      url: env[`FRONT_END_${index}`],
      webhookId: env[`WEBHOOK_ID_${index}`],
      index,
      cooldown: null, // Use default from NOTIFICATION_COOLDOWN
    });
  }
  for (let index = 1; ; index += 1) {
    const type = env[`NOTIFICATION_${index}_TYPE`];
    const url = env[`NOTIFICATION_${index}_URL`];
    // For discord_bot type, URL is optional (uses DISCORD_NOTIFY_USERS instead)
    if (!type) break;
    if (!url && type.toLowerCase() !== 'discord_bot') break;
    const cooldown = env[`NOTIFICATION_${index}_COOLDOWN`];
    channels.push({
      type: type.toLowerCase(),
      url: url || null,
      webhookId: env[`NOTIFICATION_${index}_WEBHOOK_ID`], // For frontend type
      index,
      cooldown: cooldown ? parseInt(cooldown, 10) : null,
    });
  }
  return channels;
}

/**
 * Where a Discord notification goes: each discord webhook channel, and the
 * bot's DMs to DISCORD_NOTIFY_USERS when a discord_bot channel is configured.
 * @returns {{ webhookUrls: string[], userIds: string[], botConfigured: boolean }}
 */
export function discordTargets(env = process.env) {
  const channels = readNotificationChannels(env);
  return {
    webhookUrls: channels.filter((channel) => channel.type === 'discord').map((channel) => channel.url),
    userIds: (env.DISCORD_NOTIFY_USERS || '').split(',').map((id) => id.trim()).filter(Boolean),
    botConfigured: channels.some((channel) => channel.type === 'discord_bot'),
  };
}
