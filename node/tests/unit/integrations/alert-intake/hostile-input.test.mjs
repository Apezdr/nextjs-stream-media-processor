/**
 * Payloads choose their fields' contents, so no field may cost more than a
 * bounded amount of work. A whitespace regex used to backtrack quadratically
 * over long runs of Unicode whitespace (a 200 KB Alertmanager body blocked
 * the event loop for 7.2 s): cleanText now reads at most max * 4 characters
 * before any regex, and every step after is linear.
 *
 * Each single-line field path (and the multi-line message paths) gets
 * 500 000 no-break spaces, and the same mixed with newlines and other
 * Unicode spaces, through the adapter AND the embed builder, and must finish
 * in under a second. The request is built outside the timer: that is the
 * sender's work.
 *
 * A second is far above the few milliseconds a path takes on an idle machine,
 * and far below what the quadratic regex took at this size (1.6 s for 50 000
 * no-break spaces, so minutes for 500 000). The image build runs every suite
 * at once on a busy machine, where 100 ms was missed by a linear path.
 */

import { describe, it, expect, afterAll } from '@jest/globals';
import { performance } from 'perf_hooks';
import { cleanText } from '../../../../integrations/alert-intake/alert.mjs';
import { ADAPTERS } from '../../../../integrations/alert-intake/adapters/index.mjs';
import { intakeEmbeds } from '../../../../integrations/alert-intake/embeds.mjs';
import { fixtureRequest } from '../../../helpers/alertIntake.mjs';

const LIMIT_MS = 1000;
const SIZE = 500_000;
const HOSTILE = {
  nbsp: ' '.repeat(SIZE),
  'nbsp and newlines': (' '.repeat(9) + '\n').repeat(SIZE / 10),
  'mixed Unicode spaces and newlines': '  　\t  \n '.repeat(SIZE / 8),
};

function timed(run) {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/** Parse with the adapter, then build the embeds, as a request would. */
function throughAdapterAndEmbeds(adapter, request) {
  const parsed = adapter.parse(request);
  if (parsed.ok) {
    for (const alert of parsed.alerts) alert.source = 'hostile';
    intakeEmbeds(parsed.alerts, { source: 'hostile', format: adapter.name, processorLabel: 'tower' });
  }
  return parsed;
}

const viaAdapter = (adapter, fixture, route, mutate, params = {}) => (hostile) => {
  const request = fixtureRequest(fixture, { route, params, mutate: (r) => mutate(r, hostile) });
  return () => throughAdapterAndEmbeds(adapter, request);
};

const PATHS = [
  ['cleanText, single line', (hostile) => () => cleanText(hostile, 256, { singleLine: true })],
  ['cleanText, multi-line', (hostile) => () => cleanText(hostile, 4000)],
  ['alertmanager alertname (title)', viaAdapter(ADAPTERS.alertmanager, 'signoz-firing', 'webhook', (r, t) => (r.body.alerts[0].labels.alertname = t))],
  [
    'alertmanager summary (title fallback and message)',
    viaAdapter(ADAPTERS.alertmanager, 'signoz-firing', 'webhook', (r, t) => {
      delete r.body.alerts[0].labels.alertname;
      r.body.alerts[0].annotations.summary = t;
    }),
  ],
  ['alertmanager description (message)', viaAdapter(ADAPTERS.alertmanager, 'signoz-firing', 'webhook', (r, t) => (r.body.alerts[0].annotations.description = t))],
  [
    'alertmanager label value and name',
    viaAdapter(ADAPTERS.alertmanager, 'signoz-firing', 'webhook', (r, t) => {
      r.body.alerts[0].labels.instance = t;
      r.body.alerts[0].labels[t.slice(0, 1000)] = 'x';
    }),
  ],
  [
    'alertmanager receiver, severity, startsAt',
    viaAdapter(ADAPTERS.alertmanager, 'signoz-firing', 'webhook', (r, t) => {
      r.body.receiver = t;
      r.body.alerts[0].labels.severity = t;
      r.body.alerts[0].startsAt = t;
    }),
  ],
  ['gotify title', viaAdapter(ADAPTERS.gotify, 'gotify-sonarr-health', 'message', (r, t) => (r.body.title = t))],
  [
    'gotify message and priority',
    viaAdapter(ADAPTERS.gotify, 'gotify-sonarr-health', 'message', (r, t) => {
      r.body.message = `x${t}`;
      r.body.priority = t;
    }),
  ],
  ['ntfy title header', viaAdapter(ADAPTERS.ntfy, 'ntfy-shoutrrr-watchtower', 'topic', (r, t) => (r.headers.title = t), { topic: 'w' })],
  ['ntfy text body (message)', viaAdapter(ADAPTERS.ntfy, 'ntfy-shoutrrr-watchtower', 'topic', (r, t) => (r.body = t), { topic: 'w' })],
  [
    'ntfy JSON title, tags and action label',
    viaAdapter(ADAPTERS.ntfy, 'ntfy-uptime-kuma-down', 'root', (r, t) => {
      r.body.title = t;
      r.body.tags = [t, 'x'];
      r.body.actions[0].label = t;
    }),
  ],
  ['ntfy JSON priority', viaAdapter(ADAPTERS.ntfy, 'ntfy-uptime-kuma-down', 'root', (r, t) => (r.body.priority = t))],
  ['generic title', viaAdapter(ADAPTERS.generic, 'generic-transcoder', 'alert', (r, t) => (r.body.title = t))],
  [
    'generic service, field value, link label',
    viaAdapter(ADAPTERS.generic, 'generic-transcoder', 'alert', (r, t) => {
      r.body.service = t;
      r.body.fields.host = t;
      r.body.links = [{ label: t, url: 'https://example.com/' }];
    }),
  ],
];

const slowest = {};
afterAll(() => {
  // For the review record: the slowest path for each input.
  console.log(`slowest field path: ${Object.entries(slowest).map(([kind, { path, ms }]) => `${kind}: ${ms.toFixed(1)} ms (${path})`).join('; ')}`);
});

describe('hostile whitespace', () => {
  for (const [kind, hostile] of Object.entries(HOSTILE)) {
    it(`cleans ${SIZE} characters of ${kind} in under ${LIMIT_MS} ms on every field path`, () => {
      const slow = [];
      for (const [path, make] of PATHS) {
        const run = make(hostile);
        const ms = timed(run);
        if (!slowest[kind] || ms > slowest[kind].ms) slowest[kind] = { path, ms };
        if (ms >= LIMIT_MS) slow.push(`${path}: ${ms.toFixed(1)} ms`);
      }
      expect(slow).toEqual([]);
    });
  }

  it('still reads what a long whitespace run is hiding, and cuts to the field\'s length', () => {
    expect(cleanText(`${' '.repeat(10)}Disk${' \n'.repeat(10)}full`, 256, { singleLine: true })).toBe('Disk full');
    expect(cleanText('a\n\n\n\nb  c', 100)).toBe('a\n\nb c');
    expect(cleanText('x'.repeat(10_000), 256)).toHaveLength(256);
    // A cut never splits a surrogate pair.
    const emoji = cleanText('😀'.repeat(300), 255);
    expect(emoji.endsWith('…')).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji)).toBe(false);
  });
});
