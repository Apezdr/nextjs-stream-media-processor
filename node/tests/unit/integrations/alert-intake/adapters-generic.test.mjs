/**
 * Our own generic JSON format (integrations/alert-intake/adapters/generic.mjs):
 * strict, as our own contract. Built from the transcoder fixture.
 */

import { describe, it, expect } from '@jest/globals';
import { generic } from '../../../../integrations/alert-intake/adapters/generic.mjs';
import { fixtureRequest } from '../../../helpers/alertIntake.mjs';

const request = (mutate) => fixtureRequest('generic-transcoder', { route: 'alert', mutate });
const withBody = (body) => request((r) => (r.body = body));
const SENTINEL = 'SENTINEL-6d1f';

describe('generic adapter', () => {
  it('reads the transcoder fixture into one stateful alert', () => {
    const parsed = generic.parse(request());
    expect(parsed.ok).toBe(true);
    const [alert] = parsed.alerts;
    expect(alert).toMatchObject({
      format: 'generic',
      kind: 'stateful',
      status: 'firing',
      severity: 'critical',
      title: 'GPU encoder unavailable',
      fingerprint: 'gpu-encoder-unavailable',
      subject: 'jit-transcoder',
      url: 'https://signoz.example.com/logs/logs-explorer?q=renderD128',
      startsAt: '2026-11-04T09:30:00.000Z',
      markdown: false,
      test: false,
    });
    expect(alert.labels).toEqual([['device', '/dev/dri/renderD128'], ['host', 'media-01']]);
    expect(alert.source).toBeNull();
  });

  it('defaults to a warning, firing event when only a title is sent', () => {
    const [alert] = generic.parse(withBody({ title: 'backup failed' })).alerts;
    expect(alert).toMatchObject({ kind: 'event', status: 'firing', severity: 'warning', message: null, subject: null });
    // The same content fingerprints the same; other content doesn't.
    expect(generic.parse(withBody({ title: 'backup failed' })).alerts[0].fingerprint).toBe(alert.fingerprint);
    expect(generic.parse(withBody({ title: 'backup failed', message: 'disk full' })).alerts[0].fingerprint).not.toBe(alert.fingerprint);
  });

  it('stamps a resolved alert with its end', () => {
    const [alert] = generic.parse(withBody({ title: 't', status: 'resolved', fingerprint: 'f' })).alerts;
    expect(alert.status).toBe('resolved');
    expect(alert.endsAt).toBe('2026-11-04T09:15:00.000Z');
  });

  it('rejects unknown fields and every wrong field by name, never by value', () => {
    const cases = [
      [{ title: 't', extra: SENTINEL }, 'unknown field: "extra"'],
      [{}, 'title is required'],
      [{ title: 'x'.repeat(257) }, 'title must be at most 256'],
      [{ title: 't', severity: SENTINEL }, 'severity must be'],
      [{ title: 't', status: SENTINEL }, 'status must be'],
      [{ title: 't', fingerprint: `${SENTINEL} with spaces` }, 'fingerprint must be'],
      [{ title: 't', url: `javascript:${SENTINEL}` }, 'url must be'],
      [{ title: 't', links: [{ label: 'x', url: `ftp://${SENTINEL}` }] }, 'links must be'],
      [{ title: 't', fields: { a: { nested: SENTINEL } } }, 'fields must be'],
      [{ title: 't', markdown: 'yes' }, 'markdown must be'],
      [{ title: 't', startsAt: SENTINEL }, 'startsAt must be'],
      [{ title: 't', message: 3 }, 'message must be'],
    ];
    for (const [body, reason] of cases) {
      const parsed = generic.parse(withBody(body));
      expect({ body, ok: parsed.ok, status: parsed.status }).toEqual({ body, ok: false, status: 400 });
      expect(parsed.reason).toContain(reason);
      expect(parsed.reason).not.toContain(SENTINEL);
    }
  });

  it('needs JSON: another media type is 415, a broken body 400 without quoting it', () => {
    expect(generic.parse(request((r) => (r.headers['content-type'] = 'text/plain'))).status).toBe(415);
    const broken = generic.parse(withBody(`{"title": "${SENTINEL}", oops`));
    expect(broken).toMatchObject({ ok: false, status: 400, code: 'bad-json' });
    expect(broken.reason).not.toContain(SENTINEL);
    expect(generic.parse(withBody('[1,2]')).reason).toBe('the body must be a JSON object');
  });

  it('does not let a field name reach an object prototype', () => {
    const parsed = generic.parse(withBody('{"title":"t","fields":{"__proto__":"x","constructor":"y","ok":"z"}}'));
    expect(parsed.alerts[0].labels).toEqual([['ok', 'z']]);
    expect({}.x).toBeUndefined();
  });

  it('replies with the outcome and counts, and errors in its plain shape', () => {
    expect(generic.reply({ outcome: 'delivered', counts: { received: 1, delivered: 1, duplicates: 0, held: 0 } })).toEqual({
      status: 200,
      body: { ok: true, outcome: 'delivered', received: 1, delivered: 1, duplicates: 0, held: 0 },
    });
    expect(generic.replyError({ status: 401, code: 'unauthorized', reason: 'a valid alert intake key is required' })).toEqual({
      status: 401,
      body: { ok: false, error: 'Unauthorized', message: 'a valid alert intake key is required' },
    });
  });
});
