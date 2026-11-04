/**
 * The one shape every format's adapter turns its payload into, and the
 * cleaning it goes through on the way (PLAN.md §2). Pure.
 *
 * JSON-serializable on purpose: v2 stores these and shows them in the
 * frontend's admin alerts.
 *
 * @typedef {object} IntakeAlert
 * @property {string} id            random UUID, per alert per request
 * @property {string} source        set by the relay from the matched key, never from the payload
 * @property {'alertmanager'|'gotify'|'ntfy'|'generic'} format
 * @property {'stateful'|'event'} kind  stateful: the sender tracks state (a fingerprint
 *                                      that goes firing then resolved); event: a one-off
 *                                      message. Chooses the dedupe policy (dedupe.mjs)
 * @property {'firing'|'resolved'} status
 * @property {'critical'|'warning'|'info'} severity
 * @property {string} title         plain text, 1..256
 * @property {string|null} message  ≤ 4000
 * @property {boolean} markdown     false: the embed escapes Discord markdown
 * @property {string} fingerprint   stable for this alert within its source
 * @property {string|null} url      primary link, http or https
 * @property {{ label: string, url: string }[]} links
 * @property {[string, string][]} labels
 * @property {string|null} subject  shown beside the source: receiver, topic or service
 * @property {string|null} startsAt ISO
 * @property {string|null} endsAt   ISO, resolved only
 * @property {boolean} test         a sender's Test button, where it can be told
 * @property {string} receivedAt    ISO
 */

import { createHash, randomUUID } from 'crypto';
import { redactUrlCredentials } from '../../lib/spanRedaction.mjs';

export const SEVERITIES = ['critical', 'warning', 'info'];
export const SEVERITY_RANK = Object.freeze({ info: 0, warning: 1, critical: 2 });

export const MAX_TITLE = 256;
export const MAX_MESSAGE = 4000;
export const MAX_LINKS = 6;
export const MAX_LABELS = 12;
const MAX_LABEL_TEXT = 200;
const MAX_URL = 2048;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Control characters but tab and newline.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
// Whitespace but the newline (Unicode's too): one character class, so linear.
const HORIZONTAL_SPACE = /[^\S\n]+/g;

/** Severity words in Alertmanager-style labels, lowercased (PLAN.md §2.1). */
const LABEL_SEVERITY = new Map([
  ...['critical', 'crit', 'fatal', 'emergency', 'emerg', 'alert', 'page', 'disaster', 'p1', 'sev1', 'error', 'err', 'high', 'major'].map((word) => [word, 'critical']),
  ...['warning', 'warn', 'medium', 'average', 'minor', 'p2', 'p3', 'sev2', 'sev3'].map((word) => [word, 'warning']),
  ...['info', 'informational', 'notice', 'low', 'none', 'ok', 'debug', 'p4', 'p5', 'sev4', 'sev5'].map((word) => [word, 'info']),
]);

/** A severity from a label value; anything unrecognized is a warning. */
export function severityFromLabel(value) {
  if (typeof value !== 'string') return null;
  // No severity word is longer; a megabyte label is just "unrecognized".
  return LABEL_SEVERITY.get(value.slice(0, 64).trim().toLowerCase()) ?? 'warning';
}

/** Gotify priorities follow its Android client: 8 and up pop up, 4 to 7 sound, 0 to 3 are quiet. */
export function severityFromGotifyPriority(priority) {
  if (priority === null || priority === undefined) return 'info';
  if (priority >= 8) return 'critical';
  if (priority >= 4) return 'warning';
  return 'info';
}

/** ntfy priorities, 1 min to 5 max. */
export function severityFromNtfyPriority(priority) {
  if (priority === null || priority === undefined) return 'info';
  if (priority >= 5) return 'critical';
  if (priority === 4) return 'warning';
  return 'info';
}

// How much of a field is read before cleaning: enough that collapsing
// whitespace still leaves `max` characters, and a bound on the work.
const READ_FACTOR = 4;

/** The first `length` UTF-16 units of `text`, not cutting a surrogate pair in two. */
export function headOf(text, length) {
  if (text.length <= length) return text;
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

/**
 * `value` as display text: strings only (numbers where `allowNumbers`),
 * control characters dropped, runs of horizontal whitespace (Unicode's too)
 * collapsed to one space, each line trimmed, at most one blank line in a row
 * (or one line, `singleLine`), trimmed, and cut to `max`. null when nothing
 * is left.
 *
 * Bounded first: only the first `max * 4` characters are read, before any
 * regex runs, and every step after is linear. A regex with a newline between
 * two optional whitespace runs backtracks quadratically over a long run of
 * whitespace with no newline in it (500 000 no-break spaces took seconds),
 * and a payload chooses its fields.
 */
export function cleanText(value, max, { allowNumbers = false, singleLine = false } = {}) {
  let text;
  if (typeof value === 'string') text = value;
  else if (allowNumbers && typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else return null;
  text = headOf(text, max * READ_FACTOR).replace(CONTROL, '');
  const lines = text.split('\n').map((line) => line.replace(HORIZONTAL_SPACE, ' ').trim());
  if (singleLine) {
    text = lines.filter(Boolean).join(' ');
  } else {
    const kept = [];
    for (const line of lines) {
      if (line === '' && kept.length && kept[kept.length - 1] === '') continue;
      kept.push(line);
    }
    text = kept.join('\n');
  }
  text = text.trim();
  if (text === '') return null;
  return text.length > max ? `${headOf(text, max - 1)}…` : text;
}

/**
 * A link Discord will accept and a reader can trust to say where it goes:
 * http or https, at most 2048 characters, credentials in it redacted. null
 * otherwise (an invalid URL in an embed makes Discord refuse the message).
 */
export function cleanUrl(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_URL) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return redactUrlCredentials(url.href);
}

/** An ISO time from a string, or null for none, garbage and Go's zero time. */
export function cleanTime(value) {
  // An RFC 3339 time with nanoseconds and an offset is 35 characters.
  if (typeof value !== 'string' || value.length > 64 || value.startsWith('0001-01-01')) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

// Labels read from one map: real ones have a dozen; a payload can send 100 000.
const MAX_LABEL_KEYS = 200;

/**
 * A label map's string values as sorted [name, value] pairs, skipping names
 * that could reach an object's prototype and any in `skip`. Reads at most the
 * first 200 names.
 */
export function labelPairs(map, skip = () => false) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const pairs = [];
  for (const name of Object.keys(map).slice(0, MAX_LABEL_KEYS)) {
    if (UNSAFE_KEYS.has(name) || skip(name)) continue;
    const value = cleanText(map[name], MAX_LABEL_TEXT, { allowNumbers: true, singleLine: true });
    const label = cleanText(name, 64, { singleLine: true });
    if (value !== null && label !== null) pairs.push([label, value]);
  }
  return pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A map's own value for `name`, never one inherited from a prototype. */
export function own(map, name) {
  return map && typeof map === 'object' && Object.hasOwn(map, name) ? map[name] : undefined;
}

/** 16 hex characters naming `parts`. */
export function fingerprintOf(parts) {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** A sender's fingerprint if it is one we can key on, else ours over `fallbackParts`. */
export function chooseFingerprint(given, fallbackParts) {
  return typeof given === 'string' && FINGERPRINT_PATTERN.test(given) ? given : fingerprintOf(fallbackParts);
}

/**
 * An IntakeAlert with the defaults filled in. `source` is left for the relay
 * to set from the key.
 */
export function intakeAlert(fields, receivedAt) {
  return {
    id: randomUUID(),
    source: null,
    format: fields.format,
    kind: fields.kind,
    status: fields.status ?? 'firing',
    severity: fields.severity ?? 'warning',
    title: fields.title,
    message: fields.message ?? null,
    markdown: fields.markdown ?? false,
    fingerprint: fields.fingerprint,
    url: fields.url ?? null,
    links: (fields.links ?? []).slice(0, MAX_LINKS),
    labels: (fields.labels ?? []).slice(0, MAX_LABELS),
    subject: fields.subject ?? null,
    startsAt: fields.startsAt ?? null,
    endsAt: fields.status === 'resolved' ? (fields.endsAt ?? null) : null,
    test: fields.test ?? false,
    receivedAt: new Date(receivedAt).toISOString(),
  };
}

/** Links with clean URLs and labels, duplicates of `exclude` or each other dropped. */
export function cleanLinks(candidates, exclude = null) {
  const links = [];
  const seen = new Set(exclude ? [exclude] : []);
  for (const { label, url } of candidates) {
    const href = cleanUrl(url);
    const text = cleanText(label, 40, { singleLine: true });
    if (!href || !text || seen.has(href)) continue;
    seen.add(href);
    links.push({ label: text, url: href });
  }
  return links.slice(0, MAX_LINKS);
}
