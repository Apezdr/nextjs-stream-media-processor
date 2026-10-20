/**
 * The log alert manager: once a minute it records new fingerprints, runs the
 * rules (lib/alerts/rules.mjs) over the tally, and turns the difference
 * between "should be firing" and "is firing" into transitions:
 *   fired      a new alert, or one whose severity went up
 *   reminder   a Discord alert still firing after discordReminderHours
 *   resolved   the condition cleared (auto-resolve only, no dismissal)
 * Each transition is saved (lib/alerts/store.mjs), written to the log as a
 * structured line (category log-alerts, for SigNoz if it is there) and sent
 * by severity (settings.routing), except for muted areas. A resolve goes only
 * to the channels that had the alert.
 *
 * Firing alerts are loaded back from Mongo at start, so a restart neither
 * re-sends them nor drops them before the tally has had time to see.
 */

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };
const HOUR = 3_600_000;
// New fingerprints one category may add to the registry per hour; past it
// they are still counted, just not stored (the flood rule reports it).
const NEW_FINGERPRINTS_PER_CATEGORY_PER_HOUR = 50;

/** An alert as the API and the frontend see it. */
export function publicAlert(alert) {
  const { _id, notified, lastReminderAt, expiresAt, ...shown } = alert;
  return shown;
}

/**
 * @param {object} options
 * @param {import('./tally.mjs').LogTally} options.tally
 * @param {ReturnType<import('./store.mjs').createAlertStore>} options.store
 * @param {ReturnType<import('./notifier.mjs').createAlertNotifier>} options.notifier
 * @param {() => Promise<object>} options.loadSettings
 * @param {(input: object) => Map<string, object>} options.evaluateRules
 * @param {string} options.processorId
 * @param {{ info: Function, warn: Function, error: Function }} options.logger
 */
export function createAlertManager({ tally, store, notifier, loadSettings, evaluateRules, processorId, logger, now = () => Date.now() }) {
  let active = new Map();
  let known = new Set();
  const newFingerprints = new Map(); // fp → sighting, for the new-error rule
  const addedPerCategory = new Map(); // category → timestamps of fingerprints added, for the cap
  let running = false;

  function underCap(category, at) {
    const recent = (addedPerCategory.get(category) ?? []).filter((time) => at - time < HOUR);
    if (recent.length >= NEW_FINGERPRINTS_PER_CATEGORY_PER_HOUR) {
      addedPerCategory.set(category, recent);
      return false;
    }
    recent.push(at);
    addedPerCategory.set(category, recent);
    return true;
  }

  async function recordFingerprints(at, settings) {
    const toSave = [];
    for (const sighting of tally.drainFingerprints()) {
      if (known.has(sighting.fp)) {
        const fresh = newFingerprints.get(sighting.fp);
        if (fresh) {
          fresh.lastSeen = Math.max(fresh.lastSeen, sighting.lastSeen);
          fresh.count += sighting.count;
        }
        toSave.push(sighting);
      } else if (underCap(sighting.category, at)) {
        known.add(sighting.fp);
        newFingerprints.set(sighting.fp, { ...sighting });
        toSave.push(sighting);
      }
    }
    const keepFor = settings.rules.newError.quietMinutes * 60_000;
    for (const [fp, sighting] of newFingerprints) {
      if (at - sighting.lastSeen > keepFor) newFingerprints.delete(fp);
    }
    await store.saveFingerprints(processorId, toSave);
  }

  function channelsFor(alert, settings) {
    if (alert.muted) return [];
    // The home frontend can't be told it is unreachable.
    if (alert.rule === 'home-frontend') return ['discord'];
    return settings.routing[alert.severity] ?? [];
  }

  async function deliver(alert, transition, channels) {
    logger.info(`log alert ${transition}: ${alert.title}`, {
      alertKey: alert.key,
      rule: alert.rule,
      severity: alert.severity,
      alertState: alert.state,
      alertFp: alert.fp,
    });
    if (channels.length === 0) return;
    const delivered = await notifier.send(publicAlert(alert), transition, channels);
    const at = new Date(now()).toISOString();
    for (const channel of channels) {
      if (delivered[channel]) alert.notified[channel] = at;
    }
  }

  async function fire(current, settings, at) {
    const alert = {
      _id: `${processorId}:${current.key}`,
      processorId,
      ...current,
      state: 'firing',
      firedAt: new Date(at).toISOString(),
      updatedAt: new Date(at).toISOString(),
      resolvedAt: null,
      muted: settings.mutedAreas.includes(current.area),
      notified: {},
      lastReminderAt: null,
    };
    active.set(alert.key, alert);
    await deliver(alert, 'fired', channelsFor(alert, settings));
    await store.saveAlert(alert);
  }

  async function update(previous, current, settings, at) {
    const escalated = SEVERITY_RANK[current.severity] > SEVERITY_RANK[previous.severity];
    const alert = {
      ...previous,
      ...current,
      // Severity only goes up while an alert fires.
      severity: escalated ? current.severity : previous.severity,
      muted: settings.mutedAreas.includes(current.area),
      updatedAt: new Date(at).toISOString(),
    };
    active.set(alert.key, alert);
    if (escalated) {
      await deliver(alert, 'fired', channelsFor(alert, settings));
    } else if (alert.notified.discord && channelsFor(alert, settings).includes('discord')) {
      const lastSent = Date.parse(alert.lastReminderAt ?? alert.notified.discord);
      if (at - lastSent >= settings.discordReminderHours * HOUR) {
        await deliver(alert, 'reminder', ['discord']);
        alert.lastReminderAt = new Date(at).toISOString();
      }
    }
    await store.saveAlert(alert);
  }

  async function resolve(previous, at) {
    const alert = { ...previous, state: 'resolved', resolvedAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString() };
    active.delete(alert.key);
    await deliver(alert, 'resolved', Object.keys(previous.notified ?? {}).filter((channel) => previous.notified[channel]));
    await store.saveAlert(alert);
  }

  return {
    async start() {
      await store.ensureIndexes();
      known = await store.knownFingerprints(processorId);
      active = new Map((await store.firingAlerts(processorId)).map((alert) => [alert.key, alert]));
    },

    async tick() {
      if (running) return;
      running = true;
      try {
        const settings = await loadSettings();
        if (!settings.enabled) return;
        const at = now();
        await notifier.flush();
        await recordFingerprints(at, settings);
        const firing = evaluateRules({
          snapshot: tally.snapshot(),
          active,
          newFingerprints,
          home: notifier.homeStatus(),
          rules: settings.rules,
        });
        for (const [key, current] of firing) {
          const previous = active.get(key);
          if (previous) await update(previous, current, settings, at);
          else await fire(current, settings, at);
        }
        for (const [key, previous] of [...active]) {
          if (!firing.has(key)) await resolve(previous, at);
        }
      } finally {
        running = false;
      }
    },

    /** Firing alerts and those resolved in the last day, for GET /api/alerts. */
    async list() {
      const docs = await store.listAlerts(processorId, { resolvedSince: new Date(now() - 24 * HOUR) });
      const alerts = docs.map(publicAlert);
      return {
        processorId,
        active: alerts.filter((alert) => alert.state === 'firing'),
        recent: alerts.filter((alert) => alert.state === 'resolved'),
        checkedAt: new Date(now()).toISOString(),
      };
    },
  };
}
