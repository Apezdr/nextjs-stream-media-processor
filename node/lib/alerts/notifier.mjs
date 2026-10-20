/**
 * Sends log alerts to their channels:
 *   discord   this processor's Discord channels, through the shared
 *             NotificationManager (bot DMs to DISCORD_NOTIFY_USERS, webhooks)
 *   frontend  the home frontend's admin notifications
 *             (POST /api/authenticated/admin/log-alert, with its webhook ID)
 *
 * The home frontend is FRONT_END_1 / WEBHOOK_ID_1. That follows how the
 * architecture works today; the goal is a real multi-server network, where a
 * server's own sysadmin chooses which paired frontends get which alerts.
 *
 * Channels are independent: a frontend that is down never holds up Discord.
 * Failed frontend deliveries are kept (the newest 50) and retried each tick;
 * how long they have been failing feeds the home-frontend rule, which goes to
 * Discord.
 */

import axios from 'axios';

const MAX_PENDING = 50;
const TIMEOUT_MS = 5000;

const COLORS = { critical: 0xe53935, warning: 0xffb300, info: 0x1e88e5, resolved: 0x43a047 };
const EMOJI = { critical: '🚨', warning: '⚠️', info: 'ℹ️', resolved: '✅' };

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** The Discord embed for an alert. */
export function alertEmbed(alert, transition, serverLabel) {
  const resolved = transition === 'resolved';
  const label = resolved ? 'Resolved' : transition === 'reminder' ? `Still ${alert.severity}` : alert.severity[0].toUpperCase() + alert.severity.slice(1);
  const fields = [{ name: 'Server', value: truncate(serverLabel, 1024), inline: true }];
  if (alert.category) fields.push({ name: 'Category', value: truncate(alert.category, 1024), inline: true });
  if (alert.count !== null && alert.count !== undefined) {
    fields.push({ name: 'Count', value: alert.windowMinutes ? `${alert.count} in ${alert.windowMinutes} min` : String(alert.count), inline: true });
  }
  if (alert.firedAt) fields.push({ name: 'Since', value: `<t:${Math.floor(Date.parse(alert.firedAt) / 1000)}:R>`, inline: true });
  return {
    title: truncate(`${EMOJI[resolved ? 'resolved' : alert.severity] ?? ''} ${label}: ${alert.title}`, 256),
    description: alert.fp ? `Fingerprint \`${alert.fp}\`: search the Logs page for it to see the lines.` : undefined,
    color: COLORS[resolved ? 'resolved' : alert.severity] ?? COLORS.info,
    fields,
    timestamp: new Date().toISOString(),
  };
}

/**
 * @param {object} options
 * @param {{ sendDiscordEmbed(embed: object): Promise<boolean> }} options.notificationManager
 * @param {{ id: string, label: string }} options.processor
 * @param {() => number} [options.now]
 */
export function createAlertNotifier({ notificationManager, processor, http = axios, now = () => Date.now() }) {
  const pending = [];
  let failingSince = null;

  const home = () => ({
    url: process.env.FRONT_END_1 ? process.env.FRONT_END_1.replace(/\/+$/, '') : null,
    webhookId: process.env.WEBHOOK_ID_1?.split(',')[0]?.trim() || null,
  });

  async function postToHome(payload) {
    const { url, webhookId } = home();
    if (!url || !webhookId) return false;
    try {
      const response = await http.post(`${url}/api/authenticated/admin/log-alert`, payload, {
        headers: { 'X-Webhook-ID': webhookId, 'Content-Type': 'application/json' },
        timeout: TIMEOUT_MS,
      });
      const ok = response.status >= 200 && response.status < 300;
      if (ok) failingSince = null;
      else failingSince ??= now();
      return ok;
    } catch {
      failingSince ??= now();
      return false;
    }
  }

  const payloadOf = (alert, transition) => ({ alert, transition, processor });

  return {
    homeStatus() {
      return { failingSince, url: home().url };
    },

    /** @returns {Promise<{ discord: boolean, frontend: boolean }>} which channels took it */
    async send(alert, transition, channels) {
      const [discord, frontend] = await Promise.all([
        channels.includes('discord')
          ? notificationManager.sendDiscordEmbed(alertEmbed(alert, transition, processor.label)).catch(() => false)
          : false,
        channels.includes('frontend') ? postToHome(payloadOf(alert, transition)) : false,
      ]);
      // Kept for a retry only if there is a home frontend to retry against.
      if (channels.includes('frontend') && !frontend && home().url && home().webhookId) {
        pending.push(payloadOf(alert, transition));
        if (pending.length > MAX_PENDING) pending.shift();
      }
      return { discord, frontend };
    },

    /** Retries undelivered frontend notices, oldest first, stopping at the first failure. */
    async flush() {
      while (pending.length > 0) {
        if (!(await postToHome(pending[0]))) return;
        pending.shift();
      }
    },
  };
}
