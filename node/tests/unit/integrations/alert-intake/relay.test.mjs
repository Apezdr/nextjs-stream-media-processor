/**
 * The relay's delivery state (integrations/alert-intake/relay.mjs). The
 * Discord client keeps retrying past our response budget, so the state must
 * follow each send's REAL outcome:
 *
 *   - a duplicate that arrives while its send is in flight waits for it and
 *     answers with its result, never an early 200;
 *   - an alert is remembered as sent only when its send settles OK, not when
 *     the response budget runs out;
 *   - a failed send gives its rate-cap tokens back;
 *   - held (rate-capped) alerts never count as delivered;
 *   - after a failure the breaker answers 503 for 30 s without new sends;
 *   - critical alerts skip the per-source cap, not the global one;
 *   - observers see every alert before dedupe and the caps;
 *   - it keeps working when the sink, a late send or the log throws (that
 *     no rejection goes unhandled is checked in a child process:
 *     no-unhandled-rejections.test.mjs).
 *
 * A manual clock and timers drive it; the sink is a stand-in whose sends
 * settle when the test says.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { createIntakeRelay, failureStatus, RELAY_DEFAULTS } from '../../../../integrations/alert-intake/relay.mjs';
import { intakeAlert } from '../../../../integrations/alert-intake/alert.mjs';

let clock;
const now = () => clock;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function manualTimers() {
  let sequence = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      sequence += 1;
      pending.set(sequence, { fn, at: clock + ms });
      return { id: sequence, unref() {} };
    },
    clearTimeout(handle) {
      if (handle) pending.delete(handle.id);
    },
    async advance(ms) {
      const until = clock + ms;
      for (;;) {
        const due = [...pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        clock = Math.max(clock, due[1].at);
        pending.delete(due[0]);
        due[1].fn();
        await flush();
      }
      clock = until;
      await flush();
    },
  };
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** A sink whose sends wait for the test, or settle at once with `auto`. */
function controlledSink() {
  const sends = [];
  return {
    sends,
    auto: null,
    hasTargets: () => true,
    deliver(embeds) {
      const gate = deferred();
      sends.push({ embeds, ...gate });
      if (this.auto) gate.resolve(this.auto);
      return gate.promise;
    },
  };
}

const OK = { ok: true, delivered: 1, failed: 0 };
const FAILED = { ok: false, reason: 'rejected', detail: 'Cannot send messages to this user' };
const quiet = () => {
  const lines = [];
  const keep = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, info: keep('info'), warn: keep('warn'), debug: keep('debug'), error: keep('error') };
};

const alertOf = (overrides = {}) =>
  intakeAlert({ format: 'generic', kind: 'stateful', title: 'Disk almost full', fingerprint: 'disk', severity: 'warning', ...overrides }, clock);

let sink;
let timers;
let log;

function relayWith(overrides = {}) {
  return createIntakeRelay({
    sink,
    processorLabel: 'tower',
    log,
    now,
    timers,
    limits: { sourceBurst: 10, sourcePerHour: 20, globalBurst: 30, globalPerHour: 60, ...overrides.limits },
    ...overrides,
  });
}

beforeEach(() => {
  clock = Date.parse('2026-11-04T09:00:00Z');
  sink = controlledSink();
  timers = manualTimers();
  log = quiet();
});

const context = { source: 'signoz', format: 'generic' };

describe('in-flight duplicates', () => {
  it('wait for the send they duplicate and answer with its success', async () => {
    const relay = relayWith();
    const first = relay.deliver([alertOf()], context);
    await flush();
    const second = relay.deliver([alertOf()], context);
    await flush();
    expect(sink.sends).toHaveLength(1);
    let secondDone = false;
    second.then(() => (secondDone = true));
    await flush();
    expect(secondDone).toBe(false); // no early answer
    sink.sends[0].resolve(OK);
    expect(await first).toMatchObject({ accepted: true, outcome: 'delivered', counts: { delivered: 1 } });
    expect(await second).toMatchObject({ accepted: true, outcome: 'duplicate', counts: { delivered: 0, duplicates: 1 } });
  });

  it('answer with the failure when the send they waited on fails', async () => {
    const relay = relayWith();
    const first = relay.deliver([alertOf()], context);
    await flush();
    const second = relay.deliver([alertOf()], context);
    await flush();
    sink.sends[0].resolve(FAILED);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ accepted: false, outcome: 'failed', reason: 'rejected' });
    expect(b).toMatchObject({ accepted: false, outcome: 'failed', reason: 'rejected' });
    expect(failureStatus(b)).toBe(502);
  });
});

describe('dedupe follows the real outcome', () => {
  it('answers 503 at the response budget, keeps the send in flight, and records it when it lands', async () => {
    const relay = relayWith();
    const first = relay.deliver([alertOf()], context);
    await flush();
    await timers.advance(RELAY_DEFAULTS.responseBudgetMs);
    const timedOut = await first;
    expect(timedOut).toMatchObject({ accepted: false, outcome: 'pending' });
    expect(failureStatus(timedOut)).toBe(503);

    // A retry while it is still in flight waits on the same send.
    const retry = relay.deliver([alertOf()], context);
    await flush();
    expect(sink.sends).toHaveLength(1);
    sink.sends[0].resolve(OK); // the late landing
    expect(await retry).toMatchObject({ accepted: true, outcome: 'duplicate' });

    // And from now on it is a plain duplicate: no new send.
    expect(await relay.deliver([alertOf()], context)).toMatchObject({ accepted: true, outcome: 'duplicate' });
    expect(sink.sends).toHaveLength(1);
  });

  it('leaves a failed alert unsent, so the next try sends it', async () => {
    const relay = relayWith({ breakerMs: 1000 });
    sink.auto = FAILED;
    expect(await relay.deliver([alertOf()], context)).toMatchObject({ outcome: 'failed' });
    await timers.advance(1000);
    sink.auto = OK;
    expect(await relay.deliver([alertOf()], context)).toMatchObject({ outcome: 'delivered' });
    expect(sink.sends).toHaveLength(2);
  });

  it('sends a stateful alert again only when its status changes or the reminder is due', async () => {
    const relay = relayWith();
    sink.auto = OK;
    await relay.deliver([alertOf()], context);
    expect((await relay.deliver([alertOf()], context)).outcome).toBe('duplicate');
    expect((await relay.deliver([alertOf({ status: 'resolved' })], context)).outcome).toBe('delivered');
    expect((await relay.deliver([alertOf({ status: 'resolved' })], context)).outcome).toBe('duplicate');
    expect((await relay.deliver([alertOf()], context)).outcome).toBe('delivered');
    clock += 4 * 3_600_000;
    expect((await relay.deliver([alertOf()], context)).outcome).toBe('delivered');
    expect(sink.sends.at(-1).embeds[0].title).toBe('⚠️ Still warning: Disk almost full');
  });

  it('suppresses an identical event for 10 minutes only, and never a test send', async () => {
    const relay = relayWith();
    sink.auto = OK;
    const event = () => alertOf({ kind: 'event', fingerprint: 'down-msg' });
    await relay.deliver([event()], context);
    expect((await relay.deliver([event()], context)).outcome).toBe('duplicate');
    clock += 10 * 60_000;
    expect((await relay.deliver([event()], context)).outcome).toBe('delivered');
    await relay.deliver([alertOf({ test: true })], context);
    expect((await relay.deliver([alertOf({ test: true })], context)).outcome).toBe('delivered');
  });

  it('gives up on a send that never settles after 5 minutes, and still records it if it lands later', async () => {
    const relay = relayWith();
    relay.deliver([alertOf()], context);
    await flush();
    await timers.advance(RELAY_DEFAULTS.abandonAfterMs);
    expect(log.lines.some((line) => line.includes('had not settled after 5 minutes'))).toBe(true);
    // No longer in flight: past the breaker, a retry starts its own send.
    await timers.advance(RELAY_DEFAULTS.breakerMs);
    sink.auto = OK;
    expect(await relay.deliver([alertOf()], context)).toMatchObject({ outcome: 'delivered' });
    expect(sink.sends).toHaveLength(2);
    // The first send lands late: its alert counts as sent, without undoing the second.
    sink.sends[0].resolve(OK);
    await flush();
    expect((await relay.deliver([alertOf()], context)).outcome).toBe('duplicate');
  });
});

describe('rate caps', () => {
  it('give a failed send its tokens back', async () => {
    const relay = relayWith({ limits: { sourceBurst: 1, sourcePerHour: 1 }, breakerMs: 1000 });
    sink.auto = FAILED;
    await relay.deliver([alertOf()], context);
    await timers.advance(1000);
    sink.auto = OK;
    // With the token spent, this would be held; it goes, because the failure refunded it.
    expect(await relay.deliver([alertOf({ fingerprint: 'other' })], context)).toMatchObject({ outcome: 'delivered' });
  });

  it('never count held alerts as delivered: a held alert is sent once the cap allows', async () => {
    const relay = relayWith({ limits: { sourceBurst: 1, sourcePerHour: 1 } });
    sink.auto = OK;
    await relay.deliver([alertOf({ fingerprint: 'a' })], context);
    const held = await relay.deliver([alertOf({ fingerprint: 'b' })], context);
    expect(held).toMatchObject({ accepted: true, outcome: 'held', counts: { held: 1, delivered: 0 } });
    expect(sink.sends).toHaveLength(1);
    // The held-alert summary goes when the source has a token again (an hour)...
    await timers.advance(3_600_000);
    await relay.drain();
    expect(sink.sends).toHaveLength(2);
    expect(sink.sends[1].embeds[0].title).toBe('⚠️ Rate cap: 1 alert from signoz held back');
    // ...and b itself was never marked sent: sent when it comes again.
    clock += 3_600_000;
    expect(await relay.deliver([alertOf({ fingerprint: 'b' })], context)).toMatchObject({ outcome: 'delivered' });
  });

  it('let critical alerts skip the per-source cap but not the global one', async () => {
    const relay = relayWith({ limits: { sourceBurst: 1, sourcePerHour: 1, globalBurst: 2, globalPerHour: 1 } });
    sink.auto = OK;
    await relay.deliver([alertOf({ fingerprint: 'w1' })], context);
    expect(await relay.deliver([alertOf({ fingerprint: 'w2' })], context)).toMatchObject({ outcome: 'held' });
    expect(await relay.deliver([alertOf({ fingerprint: 'c1', severity: 'critical' })], context)).toMatchObject({ outcome: 'delivered' });
    // The global bucket (2) is now empty: a critical alert is held too.
    expect(await relay.deliver([alertOf({ fingerprint: 'c2', severity: 'critical' })], context)).toMatchObject({ outcome: 'held' });
    // A mixed batch over the source cap sends its critical alerts and holds the rest.
    const relay2 = relayWith({ limits: { sourceBurst: 1, sourcePerHour: 1 } });
    await relay2.deliver([alertOf({ fingerprint: 'x' })], context);
    const mixed = await relay2.deliver([alertOf({ fingerprint: 'y' }), alertOf({ fingerprint: 'z', severity: 'critical' })], context);
    expect(mixed).toMatchObject({ outcome: 'delivered', counts: { delivered: 1, held: 1 } });
  });

  it('keep a summary that failed to send, and send it after the breaker', async () => {
    const relay = relayWith({ limits: { sourceBurst: 1, sourcePerHour: 60 } });
    sink.auto = OK;
    await relay.deliver([alertOf({ fingerprint: 'a' })], context);
    await relay.deliver([alertOf({ fingerprint: 'b' })], context);
    sink.auto = FAILED;
    await timers.advance(60_000);
    await relay.drain();
    expect(relay.heldSummary('signoz')).toMatchObject({ count: 1 });
    sink.auto = OK;
    await timers.advance(RELAY_DEFAULTS.breakerMs + 60_000);
    await relay.drain();
    expect(relay.heldSummary('signoz')).toBeNull();
    expect(sink.sends.at(-1).embeds[0].title).toContain('Rate cap: 1 alert');
  });
});

describe('the breaker', () => {
  it('answers 503 for 30 s after a failure without starting a send, then sends again', async () => {
    const relay = relayWith();
    sink.auto = FAILED;
    await relay.deliver([alertOf()], context);
    const refused = await relay.deliver([alertOf({ fingerprint: 'other' })], context);
    expect(refused).toMatchObject({ accepted: false, outcome: 'breaker', retryAfterSec: 30 });
    expect(failureStatus(refused)).toBe(503);
    expect(sink.sends).toHaveLength(1);
    // A duplicate of something already delivered still answers 200 meanwhile.
    await timers.advance(RELAY_DEFAULTS.breakerMs);
    sink.auto = OK;
    expect(await relay.deliver([alertOf({ fingerprint: 'other' })], context)).toMatchObject({ outcome: 'delivered' });
    sink.auto = FAILED;
    await relay.deliver([alertOf({ fingerprint: 'third' })], context);
    expect(await relay.deliver([alertOf({ fingerprint: 'other' })], context)).toMatchObject({ outcome: 'duplicate' });
  });

  it('stays closed after a failure that made no Discord call (no target, bot not ready)', async () => {
    for (const reason of ['not-ready', 'no-target']) {
      const relay = relayWith();
      sink.auto = { ok: false, reason };
      const failed = await relay.deliver([alertOf({ fingerprint: `first-${reason}` })], context);
      expect(failed).toMatchObject({ outcome: 'failed', reason, retryAfterSec: null });
      expect(failureStatus(failed)).toBe(503);
      // The very next alert is sent, not refused by a breaker.
      sink.auto = OK;
      const before = sink.sends.length;
      expect(await relay.deliver([alertOf({ fingerprint: `next-${reason}` })], context)).toMatchObject({ outcome: 'delivered' });
      expect(sink.sends.length).toBe(before + 1);
      expect(log.lines.some((line) => line.includes('new sends pause'))).toBe(false);
    }
  });

  it('is not opened again when an abandoned send fails minutes later', async () => {
    const relay = relayWith();
    relay.deliver([alertOf({ fingerprint: 'hung' })], context);
    await flush();
    await timers.advance(RELAY_DEFAULTS.abandonAfterMs); // abandoned: the breaker opens once
    await timers.advance(RELAY_DEFAULTS.breakerMs); // and closes
    sink.sends[0].resolve({ ok: false, reason: 'rejected' }); // the hung send fails at last
    await flush();
    sink.auto = OK;
    expect(await relay.deliver([alertOf({ fingerprint: 'after' })], context)).toMatchObject({ outcome: 'delivered' });
  });
});

describe('observers', () => {
  it('see every alert before dedupe and the caps, duplicates and held ones too', async () => {
    const seen = [];
    const relay = relayWith({ limits: { sourceBurst: 1, sourcePerHour: 1 }, observers: [({ alerts, source }) => seen.push(...alerts.map((a) => `${source}:${a.fingerprint}`))] });
    sink.auto = OK;
    await relay.deliver([alertOf({ fingerprint: 'a' })], context);
    await relay.deliver([alertOf({ fingerprint: 'a' })], context); // duplicate
    await relay.deliver([alertOf({ fingerprint: 'b' })], context); // held
    expect(seen).toEqual(['signoz:a', 'signoz:a', 'signoz:b']);
  });

  it('can throw without breaking the relay', async () => {
    const relay = relayWith({ observers: [() => { throw new Error('storage down'); }] });
    sink.auto = OK;
    expect(await relay.deliver([alertOf()], context)).toMatchObject({ outcome: 'delivered' });
  });
});

describe('failures inside the relay', () => {
  it('leave it working when the sink throws, a send settles late, a summary send throws, or the log throws', async () => {
    const throwingLog = { info() { throw new Error('log down'); }, warn() { throw new Error('log down'); }, debug() { throw new Error('log down'); } };
    const relay = relayWith({ log: throwingLog, limits: { sourceBurst: 1, sourcePerHour: 60 }, breakerMs: 1000 });
    sink.deliver = () => Promise.reject(new Error('discord.js exploded'));
    expect(await relay.deliver([alertOf()], context)).toMatchObject({ outcome: 'failed', reason: 'error' });
    await timers.advance(1000);

    // A late settlement after the response budget, then a throwing summary send.
    const gate = deferred();
    sink.deliver = () => gate.promise;
    const late = relay.deliver([alertOf({ fingerprint: 'late' })], context);
    await flush();
    await timers.advance(RELAY_DEFAULTS.responseBudgetMs);
    expect((await late).outcome).toBe('pending');
    gate.reject(new Error('late failure'));
    await flush();
    sink.deliver = () => {
      throw new Error('summary sink threw');
    };
    await timers.advance(1000);
    await relay.deliver([alertOf({ fingerprint: 'held-1' })], context);
    await relay.deliver([alertOf({ fingerprint: 'held-2' })], context);
    await timers.advance(120_000);
    await relay.drain();
    sink.deliver = () => Promise.resolve(OK);
    await timers.advance(RELAY_DEFAULTS.breakerMs);
    expect(await relay.deliver([alertOf({ fingerprint: 'after', severity: 'critical' })], context)).toMatchObject({ outcome: 'delivered' });
  });
});
