/**
 * How an alert looks in Discord: one colour and one emoji per severity, and
 * green for resolved. Shared by this processor's own log alerts
 * (lib/alerts/notifier.mjs) and the alerts it relays for other apps
 * (integrations/alert-intake/embeds.mjs), so the two read as one system.
 */

export const COLORS = Object.freeze({ critical: 0xe53935, warning: 0xffb300, info: 0x1e88e5, resolved: 0x43a047 });
export const EMOJI = Object.freeze({ critical: '🚨', warning: '⚠️', info: 'ℹ️', resolved: '✅' });

/** `text` cut to `length` characters, with an ellipsis when it was longer. */
export function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
