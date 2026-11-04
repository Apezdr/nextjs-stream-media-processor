/**
 * Alert intake keys and limits, from the environment:
 *
 *   ALERT_INTAKE_KEYS=signoz:<key>,grafana:<key>,uptime-kuma:<key>
 *
 * One entry per key, separated by commas or newlines, each `source:key` split
 * at the first colon. The source names the sender in the Discord embed, the
 * logs and the span; a source may have several keys, so a key can be rotated
 * (add the new one, switch the sender, remove the old one). Revoking a sender
 * is removing its entries. Read once at startup.
 *
 * One list, not numbered variables: the numbered loops elsewhere stop at the
 * first gap, so deleting entry 2 would silently drop 3 and on.
 *
 * Fails loudly. A bad entry leaves the whole intake "misconfigured" (every
 * route answers 503 and integrations/alert-intake/index.mjs logs each problem
 * at startup) rather than running with one sender silently missing. Problems
 * name an entry by its position, never by its text: a malformed entry may be
 * a key.
 *
 * No logger import here: lib/webhookIdRedaction.mjs reads the keys through
 * intakeKeyValues() to keep them out of every log record, and the logger
 * imports that module.
 */

import { createHash } from 'crypto';

export const KEYS_VARIABLE = 'ALERT_INTAKE_KEYS';

/** Where integrations/alert-intake/routes.mjs is mounted (routes/index.mjs). */
export const ALERT_INTAKE_PREFIX = '/api/alert-intake';

// Lowercase on input; 1 to 32 characters, no separator at either end.
const SOURCE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;
// The characters every sender carries unchanged: Express turns a '+' in
// ?token= into a space, and '/', '=' and '~' need escaping in some of them.
// 32 at least: a guess is hopeless, and Gotify 3 keys (gtfya. + 43) fit.
const KEY_PATTERN = /^[A-Za-z0-9._-]{32,256}$/;
export const MIN_KEY_LENGTH = 32;

/** Rate-cap defaults (PLAN.md §6.2); two may be overridden from the environment. */
export const DEFAULT_LIMITS = Object.freeze({
  sourceBurst: 10,
  sourcePerHour: 20,
  globalBurst: 30,
  globalPerHour: 60,
});

const LIMIT_VARIABLES = { ALERT_INTAKE_BURST: 'sourceBurst', ALERT_INTAKE_SOURCE_PER_HOUR: 'sourcePerHour' };

const digestOf = (key) => createHash('sha256').update(key, 'utf8').digest();

/** `sha256:` and 8 hex digits: how a key may be named in a log line or on a span. */
export function keyFingerprint(key) {
  return `sha256:${createHash('sha256').update(String(key)).digest('hex').slice(0, 8)}`;
}

/** The admin credentials an intake key must never equal: they unlock the processor's API. */
function adminCredentials(env) {
  const values = [];
  for (let index = 1; env[`WEBHOOK_ID_${index}`]; index += 1) {
    values.push(...env[`WEBHOOK_ID_${index}`].split(','));
  }
  if (env.SERVER_API_KEY) values.push(env.SERVER_API_KEY);
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

function parseLimits(env, problems) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [variable, field] of Object.entries(LIMIT_VARIABLES)) {
    const raw = env[variable];
    if (raw === undefined || raw.trim() === '') continue;
    if (!/^\d{1,5}$/.test(raw.trim()) || Number(raw) < 1) {
      problems.push(`${variable} must be a whole number of at least 1`);
      continue;
    }
    limits[field] = Number(raw);
  }
  return limits;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{
 *   state: 'off' | 'on' | 'misconfigured',
 *   sources: string[],
 *   keys: { source: string, sourceIndex: number, digest: Buffer, fingerprint: string }[],
 *   limits: typeof DEFAULT_LIMITS,
 *   problems: string[],
 * }}
 */
export function parseIntakeConfig(env = process.env) {
  const problems = [];
  const limits = parseLimits(env, problems);
  const raw = env[KEYS_VARIABLE];
  if (raw === undefined || raw.trim() === '') {
    return { state: problems.length ? 'misconfigured' : 'off', sources: [], keys: [], limits, problems };
  }

  const admin = adminCredentials(env);
  const seen = new Map(); // key → entry position
  const sources = [];
  const keys = [];
  const entries = raw.split(/[,\n]/).map((entry) => entry.trim());
  let position = 0;
  for (const entry of entries) {
    if (entry === '') continue;
    position += 1;
    const colon = entry.indexOf(':');
    if (colon < 0) {
      problems.push(`${KEYS_VARIABLE} entry ${position} is not source:key`);
      continue;
    }
    const source = entry.slice(0, colon).trim().toLowerCase();
    const key = entry.slice(colon + 1).trim();
    if (!SOURCE_PATTERN.test(source)) {
      problems.push(`${KEYS_VARIABLE} entry ${position}: the source must be 1 to 32 of a-z, 0-9, '.', '_' and '-', starting and ending with a letter or digit`);
      continue;
    }
    if (!KEY_PATTERN.test(key)) {
      problems.push(`${KEYS_VARIABLE} entry ${position} (${source}): the key must be ${MIN_KEY_LENGTH} to 256 of A-Z, a-z, 0-9, '.', '_' and '-'`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`${KEYS_VARIABLE} entry ${position} (${source}) repeats the key of entry ${seen.get(key)}`);
      continue;
    }
    if (admin.has(key)) {
      problems.push(`${KEYS_VARIABLE} entry ${position} (${source}) is a WEBHOOK_ID or SERVER_API_KEY value; an intake key must be its own`);
      continue;
    }
    seen.set(key, position);
    if (!sources.includes(source)) sources.push(source);
    keys.push({ source, sourceIndex: sources.indexOf(source), digest: digestOf(key), fingerprint: keyFingerprint(key) });
  }
  if (keys.length === 0 && problems.length === 0) problems.push(`${KEYS_VARIABLE} is set but holds no entries`);
  return { state: problems.length ? 'misconfigured' : 'on', sources, keys, limits, problems };
}

let cachedRaw = null;
let cachedValues = [];

/**
 * The configured key values that pass the key rule, for log redaction. Cached
 * on the variable's text, so the logger can call it for every record.
 */
export function intakeKeyValues(env = process.env) {
  const raw = env[KEYS_VARIABLE] ?? '';
  if (raw === cachedRaw) return cachedValues;
  cachedRaw = raw;
  cachedValues = [
    ...new Set(
      raw
        .split(/[,\n]/)
        .map((entry) => entry.slice(entry.indexOf(':') + 1).trim())
        .filter((key) => KEY_PATTERN.test(key))
    ),
  ];
  return cachedValues;
}
