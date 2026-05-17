import { createCategoryLogger } from '../../../lib/logger.mjs';
import { getAppConfigDb } from '../../../database.mjs';

const logger = createCategoryLogger('caption-config');

const SETTING_NAME = 'autoCaptions';

const DEFAULTS = Object.freeze({
  enabled: false,
  languages: ['en'],
  model: 'base.en',
  threads: 4,
  maxConcurrent: 1
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
    logger.info(`autoCaptions setting initialized with defaults (enabled=${DEFAULTS.enabled})`);
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
