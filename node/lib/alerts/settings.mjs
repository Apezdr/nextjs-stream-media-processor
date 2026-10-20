/**
 * Log alerting settings: this processor's own, read from its own Mongo
 * (app_config.settings, name "logAlerting"), since the processor is the one
 * acting on them. Missing document or fields: the defaults below. Nothing is
 * seeded; the admin settings page (phase 2) will write the document.
 *
 * Routing by severity: "discord" is this processor's Discord channels (the
 * bot's DMs to DISCORD_NOTIFY_USERS, or a webhook); "frontend" is the home
 * frontend's admin notifications.
 */

export const DEFAULT_ALERTING = Object.freeze({
  enabled: true,
  routing: { critical: ['discord', 'frontend'], warning: ['frontend'], info: ['frontend'] },
  // Areas (lib/logAreas.mjs) whose alerts are recorded but not sent anywhere.
  mutedAreas: [],
  // A Discord alert still firing after this many hours is sent once more.
  discordReminderHours: 6,
  rules: {
    recurring: { count: 6, windowMinutes: 60, quietMinutes: 30 },
    errorBurst: { count: 3, criticalCount: 20, windowMinutes: 15, quietMinutes: 30 },
    newError: { quietMinutes: 60 },
    heartbeats: { 'library-scan': { minutes: 30, label: 'library scan' } },
    fingerprintFlood: { count: 50, windowMinutes: 60 },
    volumeSpike: { factor: 10, minPerMinute: 200, windowMinutes: 5, baselineMinutes: 60 },
    secret: { quietMinutes: 60 },
    homeFrontend: { minutes: 5 },
  },
});

const SETTING_NAME = 'logAlerting';
const CACHE_MS = 60_000;

/** The defaults with a stored document laid over them: top-level fields, and each rule's fields. */
export function mergeAlertingSettings(stored) {
  const value = stored && typeof stored === 'object' ? stored : {};
  const rules = {};
  for (const [name, defaults] of Object.entries(DEFAULT_ALERTING.rules)) {
    rules[name] = { ...defaults, ...(value.rules?.[name] ?? {}) };
  }
  return {
    ...DEFAULT_ALERTING,
    ...value,
    routing: { ...DEFAULT_ALERTING.routing, ...(value.routing ?? {}) },
    rules,
  };
}

/**
 * Reads the settings from `getDb()` (app_config), cached for a minute.
 * @param {{ getDb: () => Promise<import('mongodb').Db>, now?: () => number }} options
 */
export function createSettingsLoader({ getDb, now = Date.now }) {
  let cached = null; // { value, at }
  return async function loadAlertingSettings() {
    if (cached && now() - cached.at < CACHE_MS) return cached.value;
    const db = await getDb();
    const doc = await db.collection('settings').findOne({ name: SETTING_NAME });
    const value = mergeAlertingSettings(doc?.value);
    cached = { value, at: now() };
    return value;
  };
}
