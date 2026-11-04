/**
 * Gotify's push API (adapters/gotify.mjs), from the Sonarr, Proxmox and
 * Uptime Kuma fixtures, and the reply shapes Gotify clients parse.
 */

import { describe, it, expect } from '@jest/globals';
import { gotify } from '../../../../integrations/alert-intake/adapters/gotify.mjs';
import { severityFromGotifyPriority } from '../../../../integrations/alert-intake/alert.mjs';
import { fixtureRequest } from '../../../helpers/alertIntake.mjs';

const parse = (name, mutate) => gotify.parse(fixtureRequest(name, { route: 'message', mutate }));

describe('gotify adapter', () => {
  it('reads Sonarr\'s health message', () => {
    const parsed = parse('gotify-sonarr-health');
    const [alert] = parsed.alerts;
    expect(alert).toMatchObject({
      format: 'gotify',
      kind: 'event',
      status: 'firing',
      severity: 'warning',
      title: 'Health Check Failure',
      message: 'Indexers unavailable due to failures for more than 6 hours: indexer-a',
      markdown: false,
      url: null,
    });
    expect(parsed.context).toMatchObject({ title: 'Health Check Failure', priority: 5, extras: { 'client::display': { contentType: 'text/plain' } } });
  });

  it('reads Proxmox (markdown, priority 9) and Uptime Kuma (fixed title, priority 8)', () => {
    const [proxmox] = parse('gotify-proxmox').alerts;
    expect(proxmox).toMatchObject({ severity: 'critical', markdown: true, title: 'vzdump backup status (pve1.example.com): backup failed' });
    const [kuma] = parse('gotify-uptime-kuma').alerts;
    expect(kuma).toMatchObject({ severity: 'critical', title: 'Uptime-Kuma', message: '[jellyfin] [🔴 Down] connect ECONNREFUSED 192.0.2.20:8096' });
  });

  it('maps priorities as Gotify\'s client does', () => {
    expect([null, -2, 0, 3, 4, 7, 8, 10].map(severityFromGotifyPriority)).toEqual(['info', 'info', 'info', 'info', 'warning', 'warning', 'critical', 'critical']);
  });

  it('takes a click URL from extras, and the same content always fingerprints the same', () => {
    const withClick = (r) => (r.body.extras['client::notification'] = { click: { url: 'https://sonarr.example.com/system/status' } });
    expect(parse('gotify-sonarr-health', withClick).alerts[0].url).toBe('https://sonarr.example.com/system/status');
    const a = parse('gotify-sonarr-health').alerts[0].fingerprint;
    expect(parse('gotify-sonarr-health').alerts[0].fingerprint).toBe(a);
    expect(parse('gotify-sonarr-health', (r) => (r.body.message = 'other')).alerts[0].fingerprint).not.toBe(a);
  });

  it('reads urlencoded bodies and query fields, as gin binds them', () => {
    const form = parse('gotify-sonarr-health', (r) => {
      r.headers['content-type'] = 'application/x-www-form-urlencoded';
      r.body = 'title=cron&message=disk+full&priority=6';
    });
    expect(form.alerts[0]).toMatchObject({ title: 'cron', message: 'disk full', severity: 'warning' });
    const query = parse('gotify-sonarr-health', (r) => {
      delete r.headers['content-type'];
      r.body = '';
      r.query = { token: 'x', message: 'from the query', priority: '9' };
    });
    expect(query.alerts[0]).toMatchObject({ title: 'Gotify message', message: 'from the query', severity: 'critical' });
  });

  it('refuses multipart with a hint, a missing message, and a bad priority', () => {
    expect(parse('gotify-sonarr-health', (r) => (r.headers['content-type'] = 'multipart/form-data; boundary=x'))).toMatchObject({ ok: false, status: 415 });
    expect(parse('gotify-sonarr-health', (r) => delete r.body.message)).toMatchObject({ ok: false, status: 400, code: 'no-message' });
    expect(parse('gotify-sonarr-health', (r) => (r.body.priority = 'high'))).toMatchObject({ ok: false, status: 400, code: 'bad-priority' });
    expect(parse('gotify-sonarr-health', (r) => (r.body = '{"message": broken'))).toMatchObject({ ok: false, code: 'bad-json' });
  });

  it('replies with the created message as Gotify does, and errors in Gotify\'s shape', () => {
    const parsed = parse('gotify-sonarr-health');
    const { status, body } = gotify.reply({ outcome: 'delivered' }, parsed.context, { sourceIndex: 2, nextId: () => 41, now: () => Date.parse('2026-11-04T09:15:00Z') });
    expect(status).toBe(200);
    expect(body).toEqual({
      id: 41,
      appid: 3,
      message: 'Indexers unavailable due to failures for more than 6 hours: indexer-a',
      title: 'Health Check Failure',
      priority: 5,
      extras: { 'client::display': { contentType: 'text/plain' } },
      date: '2026-11-04T09:15:00.000Z',
    });
    // Without a priority, as Gotify's app default.
    const noPriority = parse('gotify-uptime-kuma', (r) => delete r.body.priority);
    expect(gotify.reply({}, noPriority.context, { sourceIndex: 0, nextId: () => 1, now: Date.now }).body.priority).toBe(0);
    expect(gotify.replyError({ status: 401, code: 'unauthorized', reason: 'a valid alert intake key is required' })).toEqual({
      status: 401,
      body: { error: 'Unauthorized', errorCode: 401, errorDescription: 'a valid alert intake key is required' },
    });
  });
});
