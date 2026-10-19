/**
 * Keeps webhook IDs out of the logs.
 *
 * A webhook ID is a credential: it unlocks the processor's admin API and the
 * frontend's sync. The configured ones (WEBHOOK_ID_<n>, comma-separated, and
 * SERVER_API_KEY, which holds the same kind of key) are replaced in every log
 * record by a short SHA-256 fingerprint, which still tells two keys apart.
 * autoSync used to log its headers, ID included, on every sync under DEBUG.
 *
 * LOG_UNREDACTED_WEBHOOK_IDS=true writes them in full, for a deliberate
 * debugging session only; the logger warns at startup while it is on.
 */

import { createHash } from 'crypto';

// Shorter values are too likely to occur by chance in a log line.
const MIN_REDACTED_LENGTH = 8;
const MAX_DEPTH = 8;

export function webhookIdsExposed() {
  return process.env.LOG_UNREDACTED_WEBHOOK_IDS === 'true';
}

/** A webhook ID as a log line may show it: a fingerprint, or in full while exposure is on. */
export function describeWebhookId(value) {
  if (!value) return '(none)';
  if (webhookIdsExposed()) return String(value);
  return `[webhook-id sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 8)}]`;
}

function configuredWebhookIds() {
  const ids = [];
  for (let index = 1; process.env[`WEBHOOK_ID_${index}`]; index += 1) {
    ids.push(...process.env[`WEBHOOK_ID_${index}`].split(','));
  }
  if (process.env.SERVER_API_KEY) ids.push(process.env.SERVER_API_KEY);
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length >= MIN_REDACTED_LENGTH))];
}

const isPlainObject = (value) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * `value` with every ID replaced. Copy on write: an object or array the
 * caller still uses (autoSync sends the very headers object it logs) is
 * never changed in place.
 */
function scrub(value, ids, seen, depth) {
  if (typeof value === 'string') {
    let result = value;
    for (const id of ids) {
      if (result.includes(id)) result = result.split(id).join(describeWebhookId(id));
    }
    return result;
  }
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH || seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    let copy = null;
    value.forEach((item, index) => {
      const next = scrub(item, ids, seen, depth + 1);
      if (next !== item) {
        copy ??= [...value];
        copy[index] = next;
      }
    });
    return copy ?? value;
  }
  if (!isPlainObject(value)) return value;

  let copy = null;
  for (const [key, item] of Object.entries(value)) {
    const next = scrub(item, ids, seen, depth + 1);
    if (next !== item) {
      copy ??= { ...value };
      copy[key] = next;
    }
  }
  return copy ?? value;
}

/**
 * Replaces the configured webhook IDs in a winston record's fields (its own
 * top-level object, so assigning to it is safe). Every transport serializes
 * these fields, so this covers the files, the console and SigNoz.
 */
export function redactWebhookIds(info) {
  if (webhookIdsExposed()) return info;
  const ids = configuredWebhookIds();
  if (ids.length === 0) return info;
  const seen = new WeakSet();
  for (const key of Object.keys(info)) {
    const next = scrub(info[key], ids, seen, 0);
    if (next !== info[key]) info[key] = next;
  }
  return info;
}
