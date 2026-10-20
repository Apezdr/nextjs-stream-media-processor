/**
 * The log alert manager (lib/alerts/manager.mjs) with the real rules and
 * tally, an in-memory store and a notifier that records what it was asked to
 * send: routing by severity, no repeats, escalation, reminders, muted areas,
 * resolves to the channels that had the alert, and restarts.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { LogTally } from '../../../lib/alerts/tally.mjs';
import { evaluateRules } from '../../../lib/alerts/rules.mjs';
import { createAlertManager } from '../../../lib/alerts/manager.mjs';
import { mergeAlertingSettings } from '../../../lib/alerts/settings.mjs';

const MINUTE = 60_000;
const quiet = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function memoryStore() {
  const alerts = new Map();
  const fingerprints = new Map();
  return {
    alerts,
    fingerprints,
    ensureIndexes: async () => {},
    knownFingerprints: async () => new Set(fingerprints.keys()),
    saveFingerprints: async (_id, sightings) => sightings.forEach((sighting) => fingerprints.set(sighting.fp, sighting)),
    firingAlerts: async () => [...alerts.values()].filter((alert) => alert.state === 'firing').map((alert) => structuredClone(alert)),
    saveAlert: async (alert) => alerts.set(alert._id, structuredClone(alert)),
    listAlerts: async () => [...alerts.values()],
  };
}

function recordingNotifier() {
  const sent = [];
  let failingSince = null;
  return {
    sent,
    failFrom: (time) => {
      failingSince = time;
    },
    homeStatus: () => ({ failingSince, url: 'https://home.example' }),
    send: async (alert, transition, channels) => {
      sent.push({ key: alert.key, transition, channels, severity: alert.severity });
      return Object.fromEntries(channels.map((channel) => [channel, true]));
    },
    flush: async () => {},
  };
}

function setup({ store = memoryStore(), settings = {}, start = Date.UTC(2026, 9, 19, 12, 0, 30) } = {}) {
  let now = start;
  const tally = new LogTally({ now: () => now });
  const notifier = recordingNotifier();
  const make = () =>
    createAlertManager({
      tally,
      store,
      notifier,
      loadSettings: async () => mergeAlertingSettings(settings),
      evaluateRules,
      processorId: 'proc-1',
      logger: quiet,
      now: () => now,
    });
  return {
    tally,
    store,
    notifier,
    make,
    advance: (minutes) => {
      now += minutes * MINUTE;
      tally.heartbeat('library-scan');
    },
    log: (level, category, message, times = 1) => {
      for (let i = 0; i < times; i += 1) tally.record({ level, category, message });
    },
  };
}

const sends = (notifier) => notifier.sent.map(({ transition, channels, severity }) => `${transition}:${severity}:${channels.join('+')}`);

describe('log alert manager', () => {
  it('sends a warning to the frontend once, and its resolve to the same channels', async () => {
    const t = setup();
    const manager = t.make();
    await manager.start();

    t.log('warn', 'session-cache', 'Memory pressure detected: 97.1MB used', 6);
    await manager.tick();
    await manager.tick();
    expect(sends(t.notifier)).toEqual(['fired:warning:frontend']);

    t.advance(31);
    await manager.tick();
    expect(sends(t.notifier)).toEqual(['fired:warning:frontend', 'resolved:warning:frontend']);
    expect([...t.store.alerts.values()][0]).toMatchObject({ state: 'resolved', processorId: 'proc-1' });
  });

  it('sends again on escalation to critical, now to Discord too, and reminds on Discord after 6 hours', async () => {
    const t = setup();
    const manager = t.make();
    await manager.start();

    t.log('error', 'ffprobe', 'ffprobe exited 1', 3);
    await manager.tick();
    t.log('error', 'ffprobe', 'ffprobe exited 1', 17);
    await manager.tick();
    expect(sends(t.notifier).filter((s) => !s.startsWith('fired:info'))).toEqual([
      'fired:warning:frontend',
      'fired:critical:discord+frontend',
    ]);

    // Still failing every few minutes for six hours.
    for (let minute = 0; minute < 6 * 60; minute += 5) {
      t.advance(5);
      t.log('error', 'ffprobe', 'ffprobe exited 1', 20);
      await manager.tick();
    }
    expect(sends(t.notifier).filter((s) => s.startsWith('reminder'))).toEqual(['reminder:critical:discord']);
  });

  it('records but does not send alerts from a muted area', async () => {
    const t = setup({ settings: { mutedAreas: ['auth'] } });
    const manager = t.make();
    await manager.start();
    t.log('warn', 'session-cache', 'Memory pressure detected: 97.1MB used', 6);
    await manager.tick();
    expect(t.notifier.sent).toEqual([]);
    expect([...t.store.alerts.values()][0]).toMatchObject({ state: 'firing', muted: true });
  });

  it('reports a new kind of error as info, but not one the registry already knows', async () => {
    const store = memoryStore();
    const t = setup({ store });
    const manager = t.make();
    await manager.start();
    t.log('error', 'mongoDB', 'Connection reset by peer');
    await manager.tick();
    expect(sends(t.notifier)).toEqual(['fired:info:frontend']);

    const later = setup({ store });
    const restarted = later.make();
    await restarted.start();
    later.log('error', 'mongoDB', 'Connection reset by peer');
    await restarted.tick();
    expect(later.notifier.sent).toEqual([]);
  });

  it("tells Discord, not the frontend, when the home frontend won't take alerts", async () => {
    const t = setup();
    const manager = t.make();
    await manager.start();
    t.notifier.failFrom(Date.UTC(2026, 9, 19, 11, 50));
    await manager.tick();
    expect(sends(t.notifier)).toEqual(['fired:warning:discord']);
  });

  it('carries firing alerts over a restart without sending or resolving them early', async () => {
    const store = memoryStore();
    const first = setup({ store });
    const manager = first.make();
    await manager.start();
    first.log('warn', 'session-cache', 'Memory pressure detected: 97.1MB used', 6);
    await manager.tick();
    expect(sends(first.notifier)).toEqual(['fired:warning:frontend']);

    // A new process: empty tally, same Mongo.
    const second = setup({ store, start: Date.UTC(2026, 9, 19, 12, 5) });
    const restarted = second.make();
    await restarted.start();
    await restarted.tick();
    expect(second.notifier.sent).toEqual([]);

    second.advance(31);
    await restarted.tick();
    expect(sends(second.notifier)).toEqual(['resolved:warning:frontend']);
  });

  it('lists firing and recently resolved alerts without internal fields', async () => {
    const t = setup();
    const manager = t.make();
    await manager.start();
    t.log('warn', 'session-cache', 'Memory pressure detected: 97.1MB used', 6);
    await manager.tick();
    const listed = await manager.list();
    expect(listed.processorId).toBe('proc-1');
    expect(listed.active).toHaveLength(1);
    expect(listed.active[0]).not.toHaveProperty('_id');
    expect(listed.active[0]).not.toHaveProperty('notified');
  });
});
