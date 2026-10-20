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
import { mapRecordStrings } from './recordWalk.mjs';

// Shorter values are too likely to occur by chance in a log line.
const MIN_REDACTED_LENGTH = 8;

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

/**
 * Replaces the configured webhook IDs in a winston record's fields. Every
 * transport serializes these fields, so this covers the files, the console
 * and SigNoz.
 */
export function redactWebhookIds(info) {
  if (webhookIdsExposed()) return info;
  const ids = configuredWebhookIds();
  if (ids.length === 0) return info;
  return mapRecordStrings(info, (text) => {
    let result = text;
    for (const id of ids) {
      if (result.includes(id)) result = result.split(id).join(describeWebhookId(id));
    }
    return result;
  });
}
