/**
 * Gotify's push API (PLAN.md §2.3), which Sonarr, Radarr, Prowlarr, Uptime
 * Kuma, Proxmox VE, Healthchecks, Diun, Jellyseerr and shoutrrr (Watchtower,
 * Beszel) speak. Their users type a base URL and the client adds /message:
 *
 *   POST /api/alert-intake/gotify/message
 *   key: ?token=<key>, else X-Gotify-Key, else Authorization: Bearer (Gotify's order)
 *   body: JSON { title, message, priority, extras }, or urlencoded, or the
 *         same fields as query parameters (Gotify binds all three)
 *
 * Success is exactly 200 with the created message as JSON: Diun accepts
 * nothing else, and shoutrrr fails on a reply that isn't JSON. Errors are
 * Gotify's { error, errorCode, errorDescription }.
 *
 * One-off events: Gotify has no resolved state and no fingerprint.
 */

import { STATUS_CODES } from 'http';
import { MAX_MESSAGE, MAX_TITLE, cleanText, cleanUrl, fingerprintOf, intakeAlert, severityFromGotifyPriority } from '../alert.mjs';
import { bodyJson, isPlainObject, reject } from './common.mjs';

function priorityOf(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value === 'number' && Number.isInteger(value)) return { ok: true, value };
  // A priority is a few digits: anything long is refused unread.
  if (typeof value === 'string' && value.length <= 16 && /^-?\d{1,4}$/.test(value.trim())) return { ok: true, value: Number(value.trim()) };
  return reject(400, 'bad-priority', 'priority must be an integer');
}

/** The message fields: from the body (JSON or urlencoded), else from the query, as gin's Bind reads them. */
function fieldsOf(request) {
  let body = {};
  if (request.body.length > 0) {
    if (request.contentType === 'application/json') {
      const parsed = bodyJson(request.body);
      if (!parsed.ok) return parsed;
      if (!isPlainObject(parsed.value)) return reject(400, 'bad-body', 'the body must be a JSON object');
      body = parsed.value;
    } else if (request.contentType === 'application/x-www-form-urlencoded') {
      body = Object.fromEntries(new URLSearchParams(request.body.toString('utf8')));
    } else if (request.contentType === 'multipart/form-data') {
      return reject(415, 'media-type', 'multipart forms are not supported: send JSON (curl --json) or urlencoded fields (curl -d)');
    } else {
      return reject(415, 'media-type', 'send the message as application/json or application/x-www-form-urlencoded');
    }
  }
  const pick = (name) => (Object.hasOwn(body, name) ? body[name] : typeof request.query?.[name] === 'string' ? request.query[name] : undefined);
  return { ok: true, fields: { title: pick('title'), message: pick('message'), priority: pick('priority'), extras: isPlainObject(body.extras) ? body.extras : null } };
}

export const gotify = {
  name: 'gotify',
  routes: [{ methods: ['POST'], path: '/gotify/message', route: 'message' }],
  credentials: ['gotify-token', 'gotify-header', 'bearer'],
  bodyLimitBytes: 64 * 1024,

  parse(request) {
    const read = fieldsOf(request);
    if (!read.ok) return read;
    const { fields } = read;
    if (typeof fields.message !== 'string' || fields.message.trim() === '') return reject(400, 'no-message', 'message is required');
    const priority = priorityOf(fields.priority);
    if (!priority.ok) return priority;
    if (fields.title !== undefined && fields.title !== null && typeof fields.title !== 'string') return reject(400, 'bad-title', 'title must be a string');

    const title = cleanText(fields.title, MAX_TITLE, { singleLine: true }) ?? 'Gotify message';
    const message = cleanText(fields.message, MAX_MESSAGE);
    const display = fields.extras?.['client::display'];
    const click = fields.extras?.['client::notification']?.click;
    const alert = intakeAlert(
      {
        format: 'gotify',
        kind: 'event',
        status: 'firing',
        severity: severityFromGotifyPriority(priority.value),
        title,
        message,
        markdown: isPlainObject(display) && display.contentType === 'text/markdown',
        fingerprint: fingerprintOf(['gotify', title, message, priority.value]),
        url: isPlainObject(click) ? cleanUrl(click.url) : null,
      },
      request.receivedAt
    );
    return {
      ok: true,
      alerts: [alert],
      // The created message Gotify would answer with.
      context: { title, message: fields.message, priority: priority.value, extras: fields.extras },
    };
  },

  reply(outcome, context, { sourceIndex, nextId, now }) {
    const body = {
      id: nextId(),
      appid: sourceIndex + 1,
      message: context.message,
      title: context.title,
      priority: context.priority ?? 0,
      date: new Date(now()).toISOString(),
    };
    if (context.extras) body.extras = context.extras;
    return { status: 200, body };
  },

  replyError(error) {
    return { status: error.status, body: { error: STATUS_CODES[error.status] ?? 'Error', errorCode: error.status, errorDescription: error.reason } };
  },
};

