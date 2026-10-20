/**
 * The log alert rules (lib/alerts/rules.mjs) over a real LogTally driven by a
 * fake clock: when each starter rule fires, and when it is over.
 */

import { describe, it, expect } from '@jest/globals';
import { LogTally } from '../../../lib/alerts/tally.mjs';
import { evaluateRules } from '../../../lib/alerts/rules.mjs';
import { mergeAlertingSettings } from '../../../lib/alerts/settings.mjs';
import { SECRETS_MASKED } from '../../../lib/logSecrets.mjs';

const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 19, 12, 0, 30);
const { rules } = mergeAlertingSettings({});

// Scans keep finishing as the clock moves, so the heartbeat rule stays out of
// the other rules' tests; the heartbeat test turns that off.
function setup({ scans = true } = {}) {
  let now = START;
  const tally = new LogTally({ now: () => now });
  return {
    tally,
    advance: (minutes) => {
      now += minutes * MINUTE;
      if (scans) tally.heartbeat('library-scan');
    },
    log: (level, category, message, times = 1) => {
      for (let i = 0; i < times; i += 1) tally.record({ level, category, message });
    },
    evaluate: ({ active = new Map(), newFingerprints = new Map(), home = { failingSince: null, url: null } } = {}) =>
      evaluateRules({ snapshot: tally.snapshot(), active, newFingerprints, home, rules }),
  };
}

const keys = (firing) => [...firing.keys()];

describe('recurring warning', () => {
  it('fires at 6 in an hour while still happening, and is over after 30 quiet minutes', () => {
    const t = setup();
    for (let i = 0; i < 5; i += 1) {
      t.log('warn', 'session-cache', `Memory pressure detected: 9${i}.1MB used`);
      t.advance(5);
    }
    expect(keys(t.evaluate())).toEqual([]);

    t.log('warn', 'session-cache', 'Memory pressure detected: 99.9MB used');
    const firing = t.evaluate();
    const [alert] = firing.values();
    expect(alert).toMatchObject({ rule: 'recurring', severity: 'warning', category: 'session-cache', area: 'auth', count: 6 });
    expect(alert.title).toBe('session-cache: "Memory pressure detected: #MB used" 6 times in the last 60 minutes');

    t.advance(29);
    expect(keys(t.evaluate({ active: firing }))).toEqual([alert.key]);
    t.advance(2);
    expect(keys(t.evaluate({ active: firing }))).toEqual([]);
  });

  it('keeps an alert carried over a restart until the tally has watched for the quiet window', () => {
    const t = setup();
    const carried = new Map([['recurring:abc', { key: 'recurring:abc', rule: 'recurring', severity: 'warning' }]]);
    t.advance(10);
    expect(keys(t.evaluate({ active: carried }))).toEqual(['recurring:abc']);
    t.advance(21);
    expect(keys(t.evaluate({ active: carried }))).toEqual([]);
  });
});

describe('error burst', () => {
  it('is a warning at 3 errors in 15 minutes and critical at 20, and is over after 30 quiet minutes', () => {
    const t = setup();
    t.log('error', 'ffprobe', 'ffprobe exited 1 for /a/b/c.mkv', 3);
    let firing = t.evaluate();
    expect([...firing.values()][0]).toMatchObject({ rule: 'error-burst', severity: 'warning', count: 3 });

    t.log('error', 'ffprobe', 'ffprobe exited 1 for /a/b/d.mkv', 17);
    firing = t.evaluate({ active: firing });
    expect([...firing.values()][0]).toMatchObject({ severity: 'critical', count: 20 });

    t.advance(20);
    expect(keys(t.evaluate({ active: firing }))).toHaveLength(1);
    t.advance(11);
    expect(keys(t.evaluate({ active: firing }))).toEqual([]);
  });
});

describe('new error', () => {
  it('reports an error fingerprint first seen recently, until it has been quiet for an hour', () => {
    const t = setup();
    const sighting = { level: 'error', category: 'mongoDB', template: 'Connection reset', count: 1, firstSeen: START, lastSeen: START };
    const newFingerprints = new Map([['f00dfacecafe', sighting]]);
    expect([...t.evaluate({ newFingerprints }).values()][0]).toMatchObject({ rule: 'new-error', severity: 'info', fp: 'f00dfacecafe' });
    t.advance(61);
    expect(keys(t.evaluate({ newFingerprints }))).toEqual([]);
  });
});

describe('heartbeat', () => {
  it('is critical when no library scan has finished in 30 minutes, counting from start', () => {
    const t = setup({ scans: false });
    t.advance(29);
    expect(keys(t.evaluate())).toEqual([]);
    t.advance(2);
    expect([...t.evaluate().values()][0]).toMatchObject({ key: 'heartbeat:library-scan', severity: 'critical' });
    t.tally.heartbeat('library-scan');
    expect(keys(t.evaluate())).toEqual([]);
  });
});

describe('fingerprint flood', () => {
  it('warns when one category writes more than 50 different warnings in an hour', () => {
    const t = setup();
    for (let i = 0; i < 51; i += 1) t.log('warn', 'tv-scanner', `No resolvable video source for Show${'x'.repeat(i)} episode, skipping.`);
    expect([...t.evaluate().values()].find((alert) => alert.rule === 'fingerprint-flood')).toMatchObject({
      key: 'fingerprint-flood:tv-scanner',
      count: 51,
    });
  });
});

describe('volume spike', () => {
  it('needs an hour of history, then warns at 10x the usual rate and names the loudest category', () => {
    const t = setup();
    for (let minute = 0; minute < 65; minute += 1) {
      t.log('info', 'main', 'tick', 10);
      t.advance(1);
    }
    expect(keys(t.evaluate())).toEqual([]);
    for (let minute = 0; minute < 5; minute += 1) {
      t.log('info', 'movie-scanner', 'Processing movie', 300);
      t.advance(1);
    }
    const alert = t.evaluate().get('volume-spike');
    expect(alert).toMatchObject({ severity: 'warning', category: 'movie-scanner' });
    expect(alert.title).toMatch(/^Log volume is 30× usual: 300 lines a minute against 10, mostly movie-scanner$/);
  });
});

describe('secret in a log line', () => {
  it('is critical when the logger masked a secret, and over after an hour without another', () => {
    const t = setup();
    t.tally.record({ level: 'info', category: 'admin-routes', message: 'GET /x?apikey=[masked]', [SECRETS_MASKED]: ['query'] });
    expect([...t.evaluate().values()][0]).toMatchObject({ key: 'secret:admin-routes', severity: 'critical' });
    t.advance(61);
    expect(keys(t.evaluate())).toEqual([]);
  });
});

describe('home frontend', () => {
  it('warns once deliveries have failed for 5 minutes', () => {
    const t = setup();
    expect(keys(t.evaluate({ home: { failingSince: START - 2 * MINUTE, url: 'https://home' } }))).toEqual([]);
    expect([...t.evaluate({ home: { failingSince: START - 6 * MINUTE, url: 'https://home' } }).values()][0]).toMatchObject({
      key: 'home-frontend',
      severity: 'warning',
    });
  });
});
