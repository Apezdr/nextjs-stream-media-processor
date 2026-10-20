/**
 * Log fingerprints: one ID per kind of message, not per line.
 *
 * "Memory pressure detected: 97.1MB used" and "…: 98.3MB used" are the same
 * problem, so URLs, long paths, quoted values, hex IDs and numbers are
 * replaced before hashing. Every warn and error record carries its `fp`
 * (lib/logger.mjs), in the files and in SigNoz, and the alert rules count by
 * it (lib/alerts/). A message with a title written into it still gets one
 * fingerprint per title; the "fingerprint flood" rule catches that.
 */

import { createHash } from 'crypto';

const MAX_TEMPLATE_LENGTH = 300;

/** The message with its variable parts replaced: what lines of one kind share. */
export function templateOf(message) {
  return String(message ?? '')
    .replace(/\[webhook-id sha256:[0-9a-f]+\]/g, '<webhook-id>')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/g, '<url>')
    .replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, '<path>')
    // Three or more segments: a file path, not a route like /api/logs.
    .replace(/(?:\/[^\s/"'<>:]+){3,}\/?/g, '<path>')
    // Not an apostrophe inside a word ("doesn't").
    .replace(/"[^"\n]*"|(?<![A-Za-z])'[^'\n]*'(?![A-Za-z])|`[^`\n]*`/g, '"…"')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+(?:[.,:]\d+)*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEMPLATE_LENGTH);
}

/** 12 hex characters naming the kind of message within its category. */
export function fingerprintOf(category, message) {
  return createHash('sha1').update(`${category ?? ''}\n${templateOf(message)}`).digest('hex').slice(0, 12);
}
