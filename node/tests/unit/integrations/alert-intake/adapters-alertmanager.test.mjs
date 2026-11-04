/**
 * The Alertmanager webhook payload (adapters/alertmanager.mjs), from the
 * SigNoz, Grafana and Alertmanager fixtures.
 */

import { describe, it, expect } from '@jest/globals';
import { alertmanager, MAX_ALERTS_READ } from '../../../../integrations/alert-intake/adapters/alertmanager.mjs';
import { fixtureRequest } from '../../../helpers/alertIntake.mjs';

const parse = (name, mutate) => alertmanager.parse(fixtureRequest(name, { route: 'webhook', mutate }));

describe('alertmanager adapter', () => {
  it('reads a SigNoz firing alert: title from alertname, links, hidden labels, no private annotations', () => {
    const parsed = parse('signoz-firing');
    expect(parsed.ok).toBe(true);
    expect(parsed.context).toEqual({ truncated: 0 });
    const [alert] = parsed.alerts;
    expect(alert).toMatchObject({
      format: 'alertmanager',
      kind: 'stateful',
      status: 'firing',
      severity: 'warning',
      title: 'media-processor file-generation failures',
      fingerprint: '6f1c3b2a9d8e7f60',
      subject: 'processor-intake',
      url: 'https://signoz.example.com/alerts/edit?ruleId=01a07f64-0000-7000-8000-000000000001',
      startsAt: '2026-11-04T09:12:00.000Z',
      endsAt: null,
      test: false,
    });
    expect(alert.message).toBe(
      'The rule threshold is set to 2, and the observed metric value is 7\n\nError-level lines from the file-producing categories exceed 2 in a rolling 15-minute window.'
    );
    expect(alert.labels).toEqual([['category', 'sprite-route'], ['service', 'nextjs-stream-media-processor']]);
    // ruleSource equals the url, so it isn't repeated as a link.
    expect(alert.links.map((link) => link.label)).toEqual(['Logs']);
    expect(JSON.stringify(alert)).not.toContain('_title_template');
  });

  it('reads the resolve, keeping the fingerprint, and a Test send', () => {
    const [resolved] = parse('signoz-resolved').alerts;
    expect(resolved).toMatchObject({ status: 'resolved', fingerprint: '6f1c3b2a9d8e7f60', endsAt: '2026-11-04T09:41:00.000Z' });
    const [test] = parse('signoz-firing', (r) => (r.body.alerts[0].labels.testalert = 'true')).alerts;
    expect(test.test).toBe(true);
  });

  it('reads Grafana: both alerts, empty URLs skipped, Silence and Dashboard links, its test send', () => {
    const { alerts } = parse('grafana-mixed');
    expect(alerts.map((alert) => [alert.status, alert.severity, alert.fingerprint])).toEqual([
      ['firing', 'critical', 'a3f9c2d1e8b74560'],
      ['resolved', 'critical', '0b1d2c3e4f5a6978'],
    ]);
    expect(alerts[0].links.map((link) => link.label)).toEqual(['Runbook', 'Dashboard', 'Panel', 'Silence']);
    expect(alerts[1].links.map((link) => link.label)).toEqual(['Silence']);
    expect(alerts[0].message).toBe('/mnt/media on nas-01 is 96% full\n\nFree space dropped below 4% (182 GiB left).');
    const [test] = parse('grafana-mixed', (r) => {
      r.body.alerts = [{ ...r.body.alerts[0], labels: { alertname: 'TestAlert', instance: 'Grafana' }, annotations: { summary: 'Notification test' } }];
    }).alerts;
    expect(test.test).toBe(true);
  });

  it('reads an Alertmanager group with three severities', () => {
    const { alerts } = parse('alertmanager-group');
    expect(alerts.map((alert) => [alert.title, alert.severity, alert.status])).toEqual([
      ['HostDown', 'critical', 'firing'],
      ['HighLoad', 'warning', 'firing'],
      ['ClockSkew', 'info', 'resolved'],
    ]);
    expect(alerts[0].labels).toEqual([['instance', '192.0.2.10:9100'], ['job', 'node']]);
  });

  it('maps severity words by the table, falling back through threshold.name to a warning', () => {
    const severityFor = (labels) =>
      parse('alertmanager-group', (r) => (r.body.alerts = [{ ...r.body.alerts[0], labels: { alertname: 'A', ...labels } }])).alerts[0].severity;
    expect(severityFor({ severity: 'ERROR' })).toBe('critical');
    expect(severityFor({ severity: 'high' })).toBe('critical');
    expect(severityFor({ severity: 'P3' })).toBe('warning');
    expect(severityFor({ severity: 'notice' })).toBe('info');
    expect(severityFor({ severity: 'whatever' })).toBe('warning');
    expect(severityFor({ 'threshold.name': 'critical' })).toBe('critical');
    expect(severityFor({})).toBe('warning');
  });

  it('derives the status from endsAt when a sender leaves it out, and its own fingerprint from the labels', () => {
    const [alert] = parse('alertmanager-group', (r) => {
      r.body.alerts = [{ labels: { alertname: 'X', b: '2', a: '1' }, endsAt: '2026-11-04T09:00:00Z' }];
    }).alerts;
    expect(alert.status).toBe('resolved');
    expect(alert.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const [again] = parse('alertmanager-group', (r) => {
      r.body.alerts = [{ labels: { a: '1', alertname: 'X', b: '2' }, endsAt: '2026-11-04T10:00:00Z' }];
    }).alerts;
    expect(again.fingerprint).toBe(alert.fingerprint);
    expect(again.status).toBe('firing');
  });

  it('reads at most 100 alerts and counts the rest with truncatedAlerts', () => {
    const parsed = parse('alertmanager-group', (r) => {
      r.body.truncatedAlerts = 5;
      r.body.alerts = Array.from({ length: 130 }, (_, i) => ({ status: 'firing', labels: { alertname: `A${i}` }, fingerprint: `fp-${i}` }));
    });
    expect(parsed.alerts).toHaveLength(MAX_ALERTS_READ);
    expect(parsed.context.truncated).toBe(35);
  });

  it('refuses what is not a webhook payload, and drops a malformed URL rather than passing it to Discord', () => {
    expect(parse('signoz-firing', (r) => (r.body = { text: 'custom template' }))).toMatchObject({ ok: false, status: 400, code: 'not-alertmanager' });
    expect(parse('signoz-firing', (r) => (r.body.alerts = [{ nolabels: true }]))).toMatchObject({ ok: false, code: 'no-alerts' });
    expect(parse('signoz-firing', (r) => (r.headers['content-type'] = 'text/xml'))).toMatchObject({ ok: false, status: 415 });
    const [alert] = parse('signoz-firing', (r) => {
      r.body.alerts[0].generatorURL = 'javascript:alert(1)';
      r.body.alerts[0].labels.ruleSource = 'not a url';
    }).alerts;
    expect(alert.url).toBeNull();
  });

  it('replies with the counts; errors in the plain shape', () => {
    const counts = { received: 3, delivered: 2, duplicates: 1, held: 0 };
    expect(alertmanager.reply({ counts })).toEqual({ status: 200, body: counts });
    expect(alertmanager.replyError({ status: 503, code: 'breaker', reason: 'paused' })).toEqual({
      status: 503,
      body: { error: 'Service Unavailable', message: 'paused' },
    });
  });
});
