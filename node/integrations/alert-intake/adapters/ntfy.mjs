/**
 * ntfy's publish API (PLAN.md §2.4). Users type a base URL; clients post to
 * a topic under it, or JSON to the base itself:
 *
 *   POST|PUT /api/alert-intake/ntfy/<topic>   the body is the message (Watchtower via
 *            shoutrrr, curl); params as headers or query (Sonarr sends them all as
 *            query parameters with an empty body)
 *   POST|PUT /api/alert-intake/ntfy           JSON { topic, message, title, priority,
 *            tags, click, actions, markdown } (Uptime Kuma, Healthchecks)
 *   key: ?auth= (the whole Authorization value, base64) wins over the
 *        Authorization header, Bearer or Basic, as in ntfy
 *
 * Params are read as ntfy reads them: header first, then query, under each of
 * its aliases. Header values may be RFC 2047 encoded; raw UTF-8 bytes, which
 * Node reads as latin1, are read again as UTF-8.
 *
 * Success is 200 with the message as JSON (shoutrrr fails on anything that
 * isn't JSON). Errors are ntfy's { code, http, error }.
 *
 * One-off events. "Resolved" is read from the tags: Uptime Kuma and
 * Healthchecks tag an Up with green_circle.
 */

import { randomInt } from 'crypto';
import {
  MAX_MESSAGE,
  MAX_TITLE,
  cleanLinks,
  cleanText,
  cleanUrl,
  fingerprintOf,
  intakeAlert,
  severityFromNtfyPriority,
} from '../alert.mjs';
import { bodyJson, bodyText, isPlainObject, reject, utf8Header } from './common.mjs';

const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
const RESOLVED_TAGS = new Set(['green_circle', 'white_check_mark', 'heavy_check_mark', 'ballot_box_with_check', 'resolved']);
const PRIORITY_WORDS = new Map([
  ['1', 1], ['min', 1],
  ['2', 2], ['low', 2],
  ['3', 3], ['default', 3],
  ['4', 4], ['high', 4],
  ['5', 5], ['max', 5], ['urgent', 5],
]);
const MAX_TAGS = 10;
const MAX_ACTION_LINKS = 3;
// A message kept for 12 hours, as ntfy.sh does by default.
const EXPIRES_AFTER_SECONDS = 12 * 3600;

const PARAMS = {
  title: ['x-title', 'title', 'ti', 't'],
  priority: ['x-priority', 'priority', 'prio', 'p'],
  tags: ['x-tags', 'tags', 'tag', 'ta'],
  click: ['x-click', 'click'],
  markdown: ['x-markdown', 'markdown', 'md'],
  message: ['x-message', 'message', 'm'],
};

/** An RFC 2047 encoded-word (=?UTF-8?B?…?= or ?Q?), decoded; anything else as it is. */
export function decodeEncodedWord(value) {
  const match = /^=\?([A-Za-z0-9_-]{1,20})\?([BbQq])\?([^?]*)\?=$/.exec(value);
  if (!match || !['utf-8', 'utf8', 'us-ascii'].includes(match[1].toLowerCase())) return value;
  const [, , encoding, text] = match;
  if (encoding.toLowerCase() === 'b') return Buffer.from(text, 'base64').toString('utf8');
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '_') bytes.push(0x20);
    else if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** A param, header first then query, as ntfy's readParam. */
function readParam(request, names) {
  for (const name of names) {
    const value = request.headers[name];
    if (typeof value === 'string' && value.trim() !== '') return decodeEncodedWord(utf8Header(value).trim());
  }
  for (const name of names) {
    const value = request.query?.[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function priorityOf(value) {
  if (value === null || value === undefined || value === 0) return { ok: true, value: null };
  if (typeof value === 'number' && PRIORITY_WORDS.has(String(value))) return { ok: true, value };
  // A priority is a short word: anything long is refused unread.
  const word = typeof value === 'string' && value.length <= 16 ? value.trim().toLowerCase() : null;
  if (word !== null && PRIORITY_WORDS.has(word)) return { ok: true, value: PRIORITY_WORDS.get(word) };
  return reject(400, 'bad-priority', 'invalid priority parameter');
}

const truthy = (value) => value === true || (typeof value === 'string' && ['1', 'yes', 'true'].includes(value.toLowerCase()));

function tagsOf(raw) {
  // Only the first few are read: a payload can send thousands.
  return raw
    .slice(0, MAX_TAGS * 2)
    .map((tag) => cleanText(tag, 64, { singleLine: true }))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}

function toAlert({ topic, title, message, priority, tags, click, actions, markdown }, receivedAt) {
  const resolved = tags.some((tag) => RESOLVED_TAGS.has(tag.toLowerCase()));
  const shownTitle = cleanText(title, MAX_TITLE, { singleLine: true }) ?? topic;
  const shownMessage = cleanText(message, MAX_MESSAGE) ?? 'triggered';
  const url = cleanUrl(click);
  const links = cleanLinks(
    actions
      .slice(0, MAX_ACTION_LINKS * 4)
      .filter((action) => isPlainObject(action) && action.action === 'view')
      .slice(0, MAX_ACTION_LINKS)
      .map((action) => ({ label: action.label, url: action.url })),
    url
  );
  const otherTags = tags.filter((tag) => !RESOLVED_TAGS.has(tag.toLowerCase()));
  return intakeAlert(
    {
      format: 'ntfy',
      kind: 'event',
      status: resolved ? 'resolved' : 'firing',
      severity: severityFromNtfyPriority(priority),
      title: shownTitle,
      message: shownMessage,
      markdown,
      fingerprint: fingerprintOf(['ntfy', topic, shownTitle, shownMessage, priority, [...tags].sort()]),
      url,
      links,
      labels: otherTags.length ? [['tags', otherTags.join(', ')]] : [],
      subject: topic,
      endsAt: resolved ? new Date(receivedAt).toISOString() : null,
    },
    receivedAt
  );
}

function parseTopic(request) {
  const topic = request.params.topic;
  if (typeof topic !== 'string' || !TOPIC.test(topic)) return reject(400, 'bad-topic', 'invalid request: topic invalid');
  const priority = priorityOf(readParam(request, PARAMS.priority));
  if (!priority.ok) return priority;
  let message = readParam(request, PARAMS.message);
  if (message === null && request.body.length > 0) {
    const decoded = bodyText(request.body);
    if (!decoded.ok) return decoded;
    message = decoded.text;
  }
  const tagParam = readParam(request, PARAMS.tags);
  const fields = {
    topic,
    title: readParam(request, PARAMS.title),
    message,
    priority: priority.value,
    tags: tagsOf(tagParam ? tagParam.split(',') : []),
    click: readParam(request, PARAMS.click),
    actions: [],
    markdown: truthy(readParam(request, PARAMS.markdown)) || request.contentType === 'text/markdown',
  };
  return { ok: true, fields };
}

function parseRoot(request) {
  if (request.body.length === 0) return reject(400, 'bad-json', 'invalid request: request body must be valid JSON');
  const parsed = bodyJson(request.body);
  if (!parsed.ok) return reject(400, 'bad-json', 'invalid request: request body must be valid JSON');
  const body = parsed.value;
  if (!isPlainObject(body)) return reject(400, 'bad-json', 'invalid request: request body must be valid JSON');
  if (typeof body.topic !== 'string' || !TOPIC.test(body.topic)) return reject(400, 'bad-topic', 'invalid request: topic invalid');
  const priority = priorityOf(body.priority);
  if (!priority.ok) return priority;
  for (const name of ['message', 'title', 'click']) {
    if (body[name] !== undefined && body[name] !== null && typeof body[name] !== 'string') return reject(400, 'bad-json', 'invalid request: request body must be valid JSON');
  }
  if (body.tags !== undefined && !(Array.isArray(body.tags) && body.tags.every((tag) => typeof tag === 'string'))) {
    return reject(400, 'bad-json', 'invalid request: request body must be valid JSON');
  }
  const fields = {
    topic: body.topic,
    title: body.title ?? null,
    message: body.message ?? null,
    priority: priority.value,
    tags: tagsOf(body.tags ?? []),
    click: body.click ?? null,
    actions: Array.isArray(body.actions) ? body.actions : [],
    markdown: body.markdown === true,
  };
  return { ok: true, fields };
}

const NTFY_CODES = { 'bad-priority': 40007, 'bad-topic': 40009, 'bad-json': 40024, 'not-utf8': 40024 };

export const ntfy = {
  name: 'ntfy',
  routes: [
    { methods: ['POST', 'PUT'], path: '/ntfy', route: 'root' },
    { methods: ['POST', 'PUT'], path: '/ntfy/:topic', route: 'topic' },
  ],
  credentials: ['ntfy-auth', 'authorization'],
  bodyLimitBytes: 64 * 1024,

  parse(request) {
    const read = request.route === 'root' ? parseRoot(request) : parseTopic(request);
    if (!read.ok) return read;
    const alert = toAlert(read.fields, request.receivedAt);
    return {
      ok: true,
      alerts: [alert],
      // The message ntfy would answer with.
      context: {
        topic: read.fields.topic,
        title: read.fields.title,
        message: read.fields.message ?? 'triggered',
        priority: read.fields.priority,
        tags: read.fields.tags,
        click: read.fields.click,
      },
    };
  },

  reply(outcome, context, { now }) {
    const time = Math.floor(now() / 1000);
    const id = Array.from({ length: 12 }, () => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[randomInt(62)]).join('');
    const body = { id, time, expires: time + EXPIRES_AFTER_SECONDS, event: 'message', topic: context.topic, message: context.message };
    if (context.title) body.title = context.title;
    if (context.priority) body.priority = context.priority;
    if (context.tags.length) body.tags = context.tags;
    if (context.click) body.click = context.click;
    return { status: 200, body };
  },

  replyError(error) {
    const code = error.status === 401 ? 40101 : error.status === 413 ? 41303 : NTFY_CODES[error.code] ?? error.status * 100 + 1;
    return { status: error.status, body: { code, http: error.status, error: error.status === 401 ? 'unauthorized' : error.reason } };
  },
};
