/**
 * ntfy's publish API (adapters/ntfy.mjs), from the Uptime Kuma, Healthchecks,
 * Sonarr and shoutrrr fixtures: topic and root publishing, ntfy's param
 * aliases, header decoding, resolved from tags, and ntfy's reply shapes.
 */

import { describe, it, expect } from '@jest/globals';
import { ntfy, decodeEncodedWord } from '../../../../integrations/alert-intake/adapters/ntfy.mjs';
import { severityFromNtfyPriority } from '../../../../integrations/alert-intake/alert.mjs';
import { fixtureRequest } from '../../../helpers/alertIntake.mjs';

const root = (name, mutate) => ntfy.parse(fixtureRequest(name, { route: 'root', mutate }));
const topic = (name, topicName, mutate) => ntfy.parse(fixtureRequest(name, { route: 'topic', params: { topic: topicName }, mutate }));

describe('ntfy adapter', () => {
  it('reads Uptime Kuma\'s JSON publish to the root: Down, priority 5, a view action', () => {
    const [alert] = root('ntfy-uptime-kuma-down').alerts;
    expect(alert).toMatchObject({
      format: 'ntfy',
      kind: 'event',
      status: 'firing',
      severity: 'critical',
      title: 'jellyfin Down [Uptime-Kuma]',
      message: 'connect ECONNREFUSED 192.0.2.20:8096',
      subject: 'uptime',
    });
    expect(alert.links).toEqual([{ label: 'Open jellyfin', url: 'http://192.0.2.20:8096/' }]);
    expect(alert.labels).toEqual([['tags', 'red_circle, media']]);
  });

  it('reads Healthchecks\' Up as resolved, with markdown', () => {
    const [alert] = root('ntfy-healthchecks-up').alerts;
    expect(alert).toMatchObject({ status: 'resolved', severity: 'info', markdown: true, title: 'nightly-backup is UP', subject: 'cron' });
    expect(alert.endsAt).toBe('2026-11-04T09:15:00.000Z');
    expect(alert.labels).toEqual([]);
  });

  it('reads Sonarr\'s query-parameter publish with an empty body', () => {
    const parsed = topic('ntfy-sonarr-query', 'sonarr');
    expect(parsed.alerts[0]).toMatchObject({
      title: 'Sonarr - Health Check Failure',
      message: 'Indexers unavailable due to failures for more than 6 hours: indexer-a',
      severity: 'warning',
      subject: 'sonarr',
    });
    expect(parsed.context).toMatchObject({ topic: 'sonarr', priority: 4, tags: ['warning'] });
  });

  it('reads shoutrrr\'s text body with Title and a priority name in headers', () => {
    const [alert] = topic('ntfy-shoutrrr-watchtower', 'watchtower').alerts;
    expect(alert).toMatchObject({ title: 'Watchtower updates on docker-01', severity: 'warning', status: 'firing' });
    expect(alert.message).toContain('port is already allocated');
  });

  it('prefers a header to the query, and the message param to the body; reads every alias', () => {
    const parsed = topic('ntfy-sonarr-query', 'sonarr', (r) => {
      r.headers['x-title'] = 'from the header';
      r.headers.p = '5';
      r.body = 'from the body';
    });
    expect(parsed.alerts[0]).toMatchObject({ title: 'from the header', severity: 'critical', message: 'Indexers unavailable due to failures for more than 6 hours: indexer-a' });
    const bodyOnly = topic('ntfy-shoutrrr-watchtower', 'watchtower', (r) => {
      r.headers = { t: 'short alias', ta: 'a,b', 'content-type': 'text/markdown' };
      r.body = '**bold**';
    });
    expect(bodyOnly.alerts[0]).toMatchObject({ title: 'short alias', message: '**bold**', markdown: true, labels: [['tags', 'a, b']] });
    const empty = topic('ntfy-shoutrrr-watchtower', 'watchtower', (r) => {
      r.headers = {};
      r.body = '';
    });
    expect(empty.alerts[0]).toMatchObject({ title: 'watchtower', message: 'triggered', severity: 'info' });
  });

  it('decodes RFC 2047 headers and raw UTF-8 header bytes', () => {
    expect(decodeEncodedWord(`=?UTF-8?B?${Buffer.from('Sauvegarde échouée').toString('base64')}?=`)).toBe('Sauvegarde échouée');
    expect(decodeEncodedWord('=?utf-8?Q?caf=C3=A9_ouvert?=')).toBe('café ouvert');
    expect(decodeEncodedWord('=?ISO-8859-1?Q?caf=E9?=')).toBe('=?ISO-8859-1?Q?caf=E9?=');
    expect(decodeEncodedWord('plain')).toBe('plain');
    // Node hands a header's raw bytes over as latin1.
    const latin1 = Buffer.from('Mise à jour ✓', 'utf8').toString('latin1');
    const [alert] = topic('ntfy-shoutrrr-watchtower', 'watchtower', (r) => (r.headers.title = latin1)).alerts;
    expect(alert.title).toBe('Mise à jour ✓');
  });

  it('maps priorities 1 to 5 and their names, and refuses anything else as ntfy does (40007)', () => {
    expect([null, 1, 2, 3, 4, 5].map(severityFromNtfyPriority)).toEqual(['info', 'info', 'info', 'info', 'warning', 'critical']);
    for (const [value, severity] of [['min', 'info'], ['default', 'info'], ['HIGH', 'warning'], ['urgent', 'critical'], ['max', 'critical']]) {
      expect(topic('ntfy-shoutrrr-watchtower', 'w', (r) => (r.headers.priority = value)).alerts[0].severity).toBe(severity);
    }
    const bad = topic('ntfy-shoutrrr-watchtower', 'w', (r) => (r.headers.priority = 'extreme'));
    expect(bad).toMatchObject({ ok: false, status: 400, code: 'bad-priority' });
    expect(ntfy.replyError(bad).body).toEqual({ code: 40007, http: 400, error: 'invalid priority parameter' });
    expect(root('ntfy-uptime-kuma-down', (r) => (r.body.priority = 'high')).alerts[0].severity).toBe('warning');
    expect(root('ntfy-uptime-kuma-down', (r) => (r.body.priority = 9))).toMatchObject({ ok: false, code: 'bad-priority' });
  });

  it('refuses a bad topic (40009), bad JSON at the root (40024) and a non-UTF-8 body', () => {
    expect(topic('ntfy-shoutrrr-watchtower', 'has space')).toMatchObject({ ok: false, code: 'bad-topic' });
    expect(topic('ntfy-shoutrrr-watchtower', 'x'.repeat(65))).toMatchObject({ ok: false, code: 'bad-topic' });
    expect(root('ntfy-uptime-kuma-down', (r) => delete r.body.topic)).toMatchObject({ ok: false, code: 'bad-topic' });
    expect(ntfy.replyError(root('ntfy-uptime-kuma-down', (r) => (r.body = 'not json'))).body.code).toBe(40024);
    expect(root('ntfy-uptime-kuma-down', (r) => (r.body.tags = 'red_circle'))).toMatchObject({ ok: false, code: 'bad-json' });
    const latin1 = fixtureRequest('ntfy-shoutrrr-watchtower', { route: 'topic', params: { topic: 'w' } });
    latin1.body = Buffer.from([0xff, 0xfe, 0x41]);
    expect(ntfy.parse(latin1)).toMatchObject({ ok: false, code: 'not-utf8' });
  });

  it('replies with the message as ntfy does, and errors in its shape', () => {
    const parsed = root('ntfy-uptime-kuma-down');
    const now = Date.parse('2026-11-04T09:15:00Z');
    const { status, body } = ntfy.reply({}, parsed.context, { now: () => now });
    expect(status).toBe(200);
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9A-Za-z]{12}$/),
      time: now / 1000,
      expires: now / 1000 + 43200,
      event: 'message',
      topic: 'uptime',
      message: 'connect ECONNREFUSED 192.0.2.20:8096',
      title: 'jellyfin Down [Uptime-Kuma]',
      priority: 5,
      tags: ['red_circle', 'media'],
    });
    expect(ntfy.replyError({ status: 401, code: 'unauthorized', reason: 'a valid alert intake key is required' }).body).toEqual({ code: 40101, http: 401, error: 'unauthorized' });
    expect(ntfy.replyError({ status: 413, code: 'too-large', reason: 'too big' }).body.code).toBe(41303);
  });
});
