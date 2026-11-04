/**
 * Our own small JSON format (PLAN.md §2.5), for this project's services (the
 * transcoder, the frontend, the desktop app) and for curl from cron or
 * systemd. One alert per request:
 *
 *   POST /api/alert-intake/generic   Authorization: Bearer <key>   Content-Type: application/json
 *   { "title": "…", "message": "…", "severity": "critical|warning|info", "status": "firing|resolved",
 *     "fingerprint": "…", "service": "…", "url": "https://…", "links": [{ "label", "url" }],
 *     "fields": { "host": "…" }, "markdown": false, "startsAt": "<ISO>", "test": false }
 *
 * Only title is required. Strict, as our own contract: an unknown field or a
 * known field of the wrong shape is a 400 naming the field (never its value).
 * With a fingerprint the alert is stateful (deduped until its status
 * changes); without one it is a one-off event.
 */

import {
  MAX_MESSAGE,
  MAX_TITLE,
  SEVERITIES,
  cleanLinks,
  cleanText,
  cleanTime,
  cleanUrl,
  fingerprintOf,
  intakeAlert,
  labelPairs,
} from '../alert.mjs';
import { bodyJson, isPlainObject, plainError, reject } from './common.mjs';

const FIELDS = new Set(['title', 'message', 'severity', 'status', 'fingerprint', 'service', 'url', 'links', 'fields', 'markdown', 'startsAt', 'test']);
const FINGERPRINT = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_LINKS = 5;
const MAX_FIELDS = 10;

const field = (name, rule) => reject(400, 'bad-field', `${name} ${rule}`);

export const generic = {
  name: 'generic',
  routes: [{ methods: ['POST'], path: '/generic', route: 'alert' }],
  credentials: ['authorization'],
  bodyLimitBytes: 64 * 1024,

  parse(request) {
    if (request.contentType !== 'application/json') return reject(415, 'media-type', 'send the alert as application/json');
    const parsed = bodyJson(request.body);
    if (!parsed.ok) return parsed;
    const body = parsed.value;
    if (!isPlainObject(body)) return reject(400, 'bad-body', 'the body must be a JSON object');
    const unknown = Object.keys(body).filter((name) => !FIELDS.has(name));
    if (unknown.length) return reject(400, 'unknown-field', `unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.slice(0, 5).map((name) => JSON.stringify(name.slice(0, 40))).join(', ')}`);

    if (typeof body.title !== 'string' || body.title.trim() === '') return field('title', 'is required: a string of 1 to 256 characters');
    if (body.title.length > MAX_TITLE) return field('title', 'must be at most 256 characters');
    if (body.message !== undefined && (typeof body.message !== 'string' || body.message.length > MAX_MESSAGE)) return field('message', 'must be a string of at most 4000 characters');
    if (body.severity !== undefined && !SEVERITIES.includes(body.severity)) return field('severity', 'must be critical, warning or info');
    if (body.status !== undefined && body.status !== 'firing' && body.status !== 'resolved') return field('status', 'must be firing or resolved');
    if (body.fingerprint !== undefined && (typeof body.fingerprint !== 'string' || !FINGERPRINT.test(body.fingerprint))) return field('fingerprint', 'must be 1 to 128 of A-Z, a-z, 0-9, ".", "_", ":" and "-"');
    if (body.service !== undefined && (typeof body.service !== 'string' || body.service.trim() === '' || body.service.length > 64)) return field('service', 'must be a string of 1 to 64 characters');
    let url = null;
    if (body.url !== undefined) {
      url = cleanUrl(body.url);
      if (!url) return field('url', 'must be an http or https URL of at most 2048 characters');
    }
    let links = [];
    if (body.links !== undefined) {
      if (!Array.isArray(body.links) || body.links.length > MAX_LINKS || !body.links.every((link) => isPlainObject(link) && typeof link.label === 'string' && cleanUrl(link.url))) {
        return field('links', `must be at most ${MAX_LINKS} objects with a label and an http or https url`);
      }
      links = cleanLinks(body.links, url);
    }
    let labels = [];
    if (body.fields !== undefined) {
      const entries = isPlainObject(body.fields) ? Object.entries(body.fields) : null;
      if (!entries || entries.length > MAX_FIELDS || !entries.every(([, value]) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) {
        return field('fields', `must be an object of at most ${MAX_FIELDS} string or number values`);
      }
      labels = labelPairs(body.fields);
    }
    for (const flag of ['markdown', 'test']) {
      if (body[flag] !== undefined && typeof body[flag] !== 'boolean') return field(flag, 'must be true or false');
    }
    let startsAt = null;
    if (body.startsAt !== undefined) {
      startsAt = cleanTime(body.startsAt);
      if (!startsAt) return field('startsAt', 'must be an ISO 8601 time');
    }

    const severity = body.severity ?? 'warning';
    const title = cleanText(body.title, MAX_TITLE);
    const message = body.message === undefined ? null : cleanText(body.message, MAX_MESSAGE);
    const service = body.service === undefined ? null : cleanText(body.service, 64, { singleLine: true });
    const alert = intakeAlert(
      {
        format: 'generic',
        kind: body.fingerprint ? 'stateful' : 'event',
        status: body.status ?? 'firing',
        severity,
        title,
        message,
        markdown: body.markdown ?? false,
        fingerprint: body.fingerprint ?? fingerprintOf(['generic', service, title, message, severity, body.status ?? 'firing']),
        url,
        links,
        labels,
        subject: service,
        startsAt,
        endsAt: body.status === 'resolved' ? new Date(request.receivedAt).toISOString() : null,
        test: body.test ?? false,
      },
      request.receivedAt
    );
    return { ok: true, alerts: [alert], context: {} };
  },

  reply(outcome) {
    return { status: 200, body: { ok: true, outcome: outcome.outcome, ...outcome.counts } };
  },

  replyError(error) {
    return { status: error.status, body: { ok: false, ...plainError(error) } };
  },
};
