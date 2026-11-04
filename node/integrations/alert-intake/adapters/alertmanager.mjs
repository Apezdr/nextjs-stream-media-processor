/**
 * The Prometheus Alertmanager webhook payload (PLAN.md §2.2), which
 * Alertmanager, SigNoz and Grafana send:
 *
 *   POST /api/alert-intake/alertmanager   (Grafana may use PUT)
 *   Authorization: Bearer <key>, or Basic with the key as the password
 *   { version: "4" (Grafana "1"), receiver, status, groupKey, truncatedAlerts, externalURL,
 *     alerts: [{ status, labels, annotations, startsAt, endsAt, generatorURL, fingerprint, … }] }
 *
 * Senders retry a 5xx and give up on a 4xx; they ignore the reply's body.
 * The alerts are stateful: the sender says firing, then resolved, under one
 * fingerprint. vmalert and Prometheus speak Alertmanager's API
 * (/api/v2/alerts) instead, which v1.1 adds.
 */

import {
  MAX_MESSAGE,
  MAX_TITLE,
  chooseFingerprint,
  cleanLinks,
  cleanText,
  cleanTime,
  cleanUrl,
  intakeAlert,
  labelPairs,
  own,
  severityFromLabel,
} from '../alert.mjs';
import { bodyJson, isPlainObject, plainError, reject } from './common.mjs';

export const MAX_ALERTS_READ = 100;

// Labels the embed shows elsewhere, or that only SigNoz's own UI needs.
const HIDDEN_LABELS = new Set(['alertname', 'severity', 'threshold.name', 'ruleId', 'ruleSource', 'testalert']);
const SEVERITY_LABELS = ['severity', 'threshold.name', 'priority', 'level'];

function severityOf(labels) {
  for (const name of SEVERITY_LABELS) {
    const severity = severityFromLabel(own(labels, name));
    if (severity) return severity;
  }
  return 'warning';
}

function statusOf(alert, receivedAt) {
  if (alert.status === 'firing' || alert.status === 'resolved') return alert.status;
  const endsAt = cleanTime(alert.endsAt);
  return endsAt && Date.parse(endsAt) <= receivedAt ? 'resolved' : 'firing';
}

function normalize(alert, payload, receivedAt) {
  const labels = isPlainObject(alert.labels) ? alert.labels : {};
  const annotations = isPlainObject(alert.annotations) ? alert.annotations : {};
  const receiver = cleanText(payload.receiver, 64, { singleLine: true });
  const summary = cleanText(own(annotations, 'summary'), MAX_TITLE, { singleLine: true });
  const title =
    cleanText(own(labels, 'alertname'), MAX_TITLE, { singleLine: true }) ??
    summary ??
    cleanText(own(annotations, 'title'), MAX_TITLE, { singleLine: true }) ??
    `Alert from ${receiver ?? 'Alertmanager'}`;
  const description = cleanText(own(annotations, 'description'), MAX_MESSAGE);
  const message = cleanText([summary && summary !== title ? summary : null, description].filter(Boolean).join('\n\n'), MAX_MESSAGE);
  const status = statusOf(alert, receivedAt);
  const url = cleanUrl(alert.generatorURL) ?? cleanUrl(own(labels, 'ruleSource'));
  const links = cleanLinks(
    [
      { label: 'Rule', url: own(labels, 'ruleSource') },
      { label: 'Logs', url: own(annotations, 'related_logs') },
      { label: 'Traces', url: own(annotations, 'related_traces') },
      { label: 'Runbook', url: own(annotations, 'runbook_url') },
      { label: 'Dashboard', url: alert.dashboardURL },
      { label: 'Panel', url: alert.panelURL },
      { label: 'Silence', url: alert.silenceURL },
    ],
    url
  );
  const test =
    own(labels, 'testalert') === 'true' ||
    (own(labels, 'alertname') === 'TestAlert' && own(annotations, 'summary') === 'Notification test');
  return intakeAlert(
    {
      format: 'alertmanager',
      kind: 'stateful',
      status,
      severity: severityOf(labels),
      title,
      message,
      markdown: false,
      fingerprint: chooseFingerprint(alert.fingerprint, labelPairs(labels)),
      url,
      links,
      labels: labelPairs(labels, (name) => HIDDEN_LABELS.has(name) || name.startsWith('__')),
      subject: receiver,
      startsAt: cleanTime(alert.startsAt),
      endsAt: status === 'resolved' ? cleanTime(alert.endsAt) : null,
      test,
    },
    receivedAt
  );
}

export const alertmanager = {
  name: 'alertmanager',
  routes: [{ methods: ['POST', 'PUT'], path: '/alertmanager', route: 'webhook' }],
  credentials: ['authorization'],
  bodyLimitBytes: 1024 * 1024,

  parse(request) {
    if (request.contentType !== null && request.contentType !== 'application/json') {
      return reject(415, 'media-type', 'send the Alertmanager webhook payload as application/json');
    }
    const parsed = bodyJson(request.body);
    if (!parsed.ok) return parsed;
    const payload = parsed.value;
    if (!isPlainObject(payload) || !Array.isArray(payload.alerts)) {
      return reject(400, 'not-alertmanager', 'not an Alertmanager webhook payload (an object with an alerts array); a custom payload template replaces it');
    }
    const read = payload.alerts.slice(0, MAX_ALERTS_READ);
    const alerts = read.filter((alert) => isPlainObject(alert) && isPlainObject(alert.labels)).map((alert) => normalize(alert, payload, request.receivedAt));
    if (alerts.length === 0) return reject(400, 'no-alerts', 'the payload has no alerts with labels');
    const truncatedAlerts = Number.isInteger(payload.truncatedAlerts) && payload.truncatedAlerts > 0 ? payload.truncatedAlerts : 0;
    return {
      ok: true,
      alerts,
      context: { truncated: truncatedAlerts + (payload.alerts.length - read.length) },
    };
  },

  reply(outcome) {
    return { status: 200, body: outcome.counts };
  },

  replyError(error) {
    return { status: error.status, body: plainError(error) };
  },
};
