import { createCategoryLogger } from '../../../lib/logger.mjs';
import { getAppConfigDb } from '../../../database.mjs';

const logger = createCategoryLogger('caption-config');

const SETTING_NAME = 'autoCaptions';

// C-2: no `maxConcurrent` field here, deliberately. Caption concurrency is
// owned SOLELY by the hardcoded limit in lib/taskManager.mjs
// (concurrencyLimits[TaskType.CAPTION_GENERATE]); a config field that looks
// authoritative but is never read is worse than none. A deployed Mongo doc
// that still carries the old field passes through the merge below harmlessly
// — nothing reads it. If per-deployment tuning is ever wanted, build it
// through a task-manager setter, never a second reader of this config.
const DEFAULTS = Object.freeze({
  enabled: false,
  languages: ['en'],
  model: 'base.en',
  threads: 4
});

/**
 * Read the autoCaptions settings doc from app_config.settings.
 * Auto-creates the doc with defaults on first read.
 */
export async function getAutoCaptionsConfig() {
  const db = await getAppConfigDb();
  const settings = db.collection('settings');

  let doc = await settings.findOne({ name: SETTING_NAME });
  if (!doc) {
    await settings.insertOne({ name: SETTING_NAME, value: { ...DEFAULTS } });
    // M-4 revert-detection audit line (see the matching note in
    // database.mjs checkAutoSync): normal on first boot, a settings
    // loss/revert signal on an established deployment. Grep marker:
    // "app_config.settings audit".
    logger.warn(
      `app_config.settings audit: seeded default document (name="${SETTING_NAME}", enabled=${DEFAULTS.enabled}) — expected on first boot only; on an established deployment this indicates a settings loss/revert`
    );
    doc = { value: { ...DEFAULTS } };
  }

  return { ...DEFAULTS, ...(doc.value || {}) };
}

export async function isLanguageEnabled(langCode) {
  const config = await getAutoCaptionsConfig();
  if (!config.enabled) return false;
  return Array.isArray(config.languages) && config.languages.includes(langCode);
}

// Process-scoped cache so per-item scanner calls don't hit MongoDB on every
// loop iteration. The scanner runs in bursts; 30s freshness is plenty.
const CACHE_TTL_MS = 30_000;
let cached = null;
let cachedAt = 0;

export async function getAutoCaptionsConfigCached() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;
  cached = await getAutoCaptionsConfig();
  cachedAt = now;
  return cached;
}

/** Test-only: clear the cache. */
export function _resetCacheForTests() {
  cached = null;
  cachedAt = 0;
}
