/**
 * The relay's way into Discord: the processor's Discord channels (bot DMs to
 * DISCORD_NOTIFY_USERS, discord webhook channels), through the shared
 * NotificationManager's quiet deliverDiscordEmbeds(), which logs nothing.
 *
 * The manager is resolved at the first send, never at import: constructing it
 * starts the bot, and mounting the intake routes must not.
 *
 * At startup the bot takes a few seconds to log in. Uptime Kuma and the *arr
 * apps don't retry, so a send waits up to `readyWaitMs` for it rather than
 * failing at once. That wait is inside the send, so the relay's response
 * budget still bounds the request.
 */

import { discordTargets } from '../notificationChannels.mjs';

export const READY_WAIT_MS = 6000;

/**
 * @param {object} options
 * @param {() => Promise<{ whenDiscordReady(ms: number): Promise<boolean>, deliverDiscordEmbeds(embeds: object[]): Promise<object> }>} options.getManager
 *   resolved at the first send; may return the manager or a promise of it
 * @param {Record<string, string|undefined>} [options.env]
 */
export function createDiscordSink({ getManager, env = process.env, readyWaitMs = READY_WAIT_MS }) {
  return {
    /** Whether there is anywhere to send to at all (startup check). */
    hasTargets() {
      const { webhookUrls, userIds, botConfigured } = discordTargets(env);
      return webhookUrls.length > 0 || (botConfigured && userIds.length > 0);
    },

    /** @returns {Promise<{ ok: boolean, reason?: string, detail?: string, delivered?: number, failed?: number }>} */
    async deliver(embeds) {
      const { webhookUrls, userIds, botConfigured } = discordTargets(env);
      const toBot = botConfigured && userIds.length > 0;
      if (webhookUrls.length === 0 && !toBot) return { ok: false, reason: 'no-target' };
      const manager = await getManager();
      if (toBot) await manager.whenDiscordReady(readyWaitMs);
      const outcome = await manager.deliverDiscordEmbeds(embeds);
      if (outcome.delivered > 0) return { ok: true, delivered: outcome.delivered, failed: outcome.failed };
      if (outcome.botNotReady && outcome.botNotReady === outcome.targets) return { ok: false, reason: 'not-ready' };
      return { ok: false, reason: 'rejected', detail: outcome.reasons[0] };
    },
  };
}
