/**
 * The log alert rules: from the tally (lib/alerts/tally.mjs) and a little
 * state the manager keeps, which alerts should be firing right now.
 *
 * Pure: no clock, no I/O. Each rule both starts alerts and decides when an
 * active one is over, so an alert's key stays in the result until the
 * condition has cleared (for fingerprint rules: none in the quiet window).
 * After a restart the tally is empty; an alert carried over from Mongo is
 * kept until the tally has watched for a full quiet window, so a restart
 * doesn't read as "resolved".
 *
 * Starter thresholds, to be reviewed against what they catch (owner,
 * 2026-10-19); settings (lib/alerts/settings.mjs) can override each one.
 */

import { areaOf } from '../logAreas.mjs';

const MINUTE = 60_000;

const lastMinutes = (snapshot, count) => snapshot.minutes.slice(-count);
const completeMinutes = (snapshot) => snapshot.minutes.slice(0, -1);
const isoMinute = (minute) => new Date(minute * MINUTE).toISOString();

/** Per fingerprint over these minutes: count, level, category, template, first and last minute. */
function fingerprintsIn(minutes) {
  const totals = new Map();
  for (const bucket of minutes) {
    for (const [fp, seen] of bucket.fingerprints) {
      const total = totals.get(fp);
      if (total) {
        total.count += seen.count;
        total.lastMinute = bucket.minute;
      } else {
        totals.set(fp, { ...seen, firstMinute: bucket.minute, lastMinute: bucket.minute });
      }
    }
  }
  return totals;
}

function alertOf({ key, rule, severity, title, category = null, fp = null, template = null, count = null, windowMinutes = null, firstSeen = null, lastSeen = null }) {
  return { key, rule, severity, title, category, area: areaOf(category), fp, template, count, windowMinutes, firstSeen, lastSeen };
}

const activeOfRule = (active, rule) => [...active.values()].filter((alert) => alert.rule === rule);

/** Warnings of one kind, over and over. */
function recurring({ snapshot, active, observedMinutes }, config, firing) {
  const window = fingerprintsIn(lastMinutes(snapshot, config.windowMinutes));
  const quiet = fingerprintsIn(lastMinutes(snapshot, config.quietMinutes));
  const describe = (fp, seen) =>
    alertOf({
      key: `recurring:${fp}`,
      rule: 'recurring',
      severity: 'warning',
      title: `${seen.category ?? 'uncategorized'}: "${seen.template}" ${seen.count} times in the last ${config.windowMinutes} minutes`,
      category: seen.category,
      fp,
      template: seen.template,
      count: seen.count,
      windowMinutes: config.windowMinutes,
      firstSeen: isoMinute(seen.firstMinute),
      lastSeen: isoMinute(seen.lastMinute),
    });

  for (const [fp, seen] of window) {
    if (seen.level !== 'warn') continue;
    const key = `recurring:${fp}`;
    // Starts while it is still happening; over once it has been quiet for the quiet window.
    const recent = quiet.has(fp);
    if (recent && (active.has(key) || seen.count >= config.count)) firing.set(key, describe(fp, seen));
  }
  for (const alert of activeOfRule(active, 'recurring')) {
    if (!firing.has(alert.key) && observedMinutes < config.quietMinutes) firing.set(alert.key, alert);
  }
}

/** Errors of one kind in a short window; many of them is critical. */
function errorBurst({ snapshot, active, observedMinutes }, config, firing) {
  const window = fingerprintsIn(lastMinutes(snapshot, config.windowMinutes));
  // The quiet window is the longer one: an active burst is over only once it has been quiet that long.
  const quiet = fingerprintsIn(lastMinutes(snapshot, config.quietMinutes));
  for (const [fp, seenQuiet] of quiet) {
    if (seenQuiet.level !== 'error') continue;
    const key = `error-burst:${fp}`;
    const inWindow = window.get(fp)?.count ?? 0;
    if (!active.has(key) && inWindow < config.count) continue;
    const seen = inWindow > 0 ? window.get(fp) : seenQuiet;
    firing.set(
      key,
      alertOf({
        key,
        rule: 'error-burst',
        severity: inWindow >= config.criticalCount ? 'critical' : 'warning',
        title: `${seen.category ?? 'uncategorized'}: ${seen.count} errors in ${inWindow > 0 ? config.windowMinutes : config.quietMinutes} minutes: "${seen.template}"`,
        category: seen.category,
        fp,
        template: seen.template,
        count: seen.count,
        windowMinutes: inWindow > 0 ? config.windowMinutes : config.quietMinutes,
        firstSeen: isoMinute(seen.firstMinute),
        lastSeen: isoMinute(seen.lastMinute),
      })
    );
  }
  for (const alert of activeOfRule(active, 'error-burst')) {
    if (!firing.has(alert.key) && observedMinutes < config.quietMinutes) firing.set(alert.key, alert);
  }
}

/** An error this processor has never logged before (the manager's Mongo registry decides "never"). */
function newError({ snapshot, active, newFingerprints }, config, firing) {
  for (const [fp, seen] of newFingerprints) {
    if (seen.level !== 'error') continue;
    if (snapshot.now - seen.lastSeen >= config.quietMinutes * MINUTE) continue;
    firing.set(
      `new-error:${fp}`,
      alertOf({
        key: `new-error:${fp}`,
        rule: 'new-error',
        severity: 'info',
        title: `${seen.category ?? 'uncategorized'}: a new kind of error: "${seen.template}"`,
        category: seen.category,
        fp,
        template: seen.template,
        count: seen.count,
        firstSeen: new Date(seen.firstSeen).toISOString(),
        lastSeen: new Date(seen.lastSeen).toISOString(),
      })
    );
  }
  // An alert carried over a restart: the new process doesn't know the
  // fingerprint as new any more, so go by when it was last seen.
  const sinceStart = fingerprintsIn(lastMinutes(snapshot, config.quietMinutes));
  for (const alert of activeOfRule(active, 'new-error')) {
    if (firing.has(alert.key)) continue;
    const seenAgain = alert.fp ? sinceStart.get(alert.fp) : null;
    const lastSeen = Math.max(Date.parse(alert.lastSeen) || 0, seenAgain ? seenAgain.lastMinute * MINUTE : 0);
    if (snapshot.now - lastSeen < config.quietMinutes * MINUTE) {
      firing.set(alert.key, { ...alert, lastSeen: new Date(lastSeen).toISOString() });
    }
  }
}

/** Something that should happen regularly (a library scan finishing) hasn't. */
function heartbeats({ snapshot }, config, firing) {
  for (const [name, { minutes, label }] of Object.entries(config)) {
    const last = snapshot.heartbeats.get(name) ?? snapshot.startedAt;
    const silentFor = snapshot.now - last;
    if (silentFor <= minutes * MINUTE) continue;
    firing.set(
      `heartbeat:${name}`,
      alertOf({
        key: `heartbeat:${name}`,
        rule: 'heartbeat',
        severity: 'critical',
        title: `No ${label} has finished in ${Math.round(silentFor / MINUTE)} minutes`,
        lastSeen: snapshot.heartbeats.has(name) ? new Date(last).toISOString() : null,
      })
    );
  }
}

/** One category producing many different warning/error messages: usually a log call with titles or IDs in it. */
function fingerprintFlood({ snapshot }, config, firing) {
  const perCategory = new Map();
  for (const [, seen] of fingerprintsIn(lastMinutes(snapshot, config.windowMinutes))) {
    perCategory.set(seen.category, (perCategory.get(seen.category) ?? 0) + 1);
  }
  for (const [category, distinct] of perCategory) {
    if (distinct <= config.count) continue;
    const key = `fingerprint-flood:${category ?? ''}`;
    firing.set(
      key,
      alertOf({
        key,
        rule: 'fingerprint-flood',
        severity: 'warning',
        title: `${category ?? 'uncategorized'}: ${distinct} different warning or error messages in ${config.windowMinutes} minutes (a log call is probably writing titles or IDs into its message)`,
        category,
        count: distinct,
        windowMinutes: config.windowMinutes,
      })
    );
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Many more lines a minute than this log's usual. Needs an hour of history for "usual". */
function volumeSpike({ snapshot, active }, config, firing) {
  const complete = completeMinutes(snapshot);
  if (complete.length < config.baselineMinutes + config.windowMinutes) return;
  const recentMinutes = complete.slice(-config.windowMinutes);
  const baselineMinutes = complete.slice(-(config.baselineMinutes + config.windowMinutes), -config.windowMinutes);
  const recent = recentMinutes.reduce((sum, bucket) => sum + bucket.total, 0) / config.windowMinutes;
  const baseline = Math.max(median(baselineMinutes.map((bucket) => bucket.total)), 1);

  const key = 'volume-spike';
  const started = recent >= config.minPerMinute && recent > config.factor * baseline;
  // Over once it is back under half the trigger, so it doesn't flap at the line.
  const ongoing = active.has(key) && recent > (config.factor / 2) * baseline;
  if (!started && !ongoing) return;

  const byCategory = new Map();
  for (const bucket of recentMinutes) {
    for (const [category, lines] of bucket.categories) byCategory.set(category, (byCategory.get(category) ?? 0) + lines);
  }
  const [loudest] = [...byCategory].sort((a, b) => b[1] - a[1]);
  firing.set(
    key,
    alertOf({
      key,
      rule: 'volume-spike',
      severity: 'warning',
      title: `Log volume is ${Math.round(recent / baseline)}× usual: ${Math.round(recent)} lines a minute against ${Math.round(baseline)}${loudest ? `, mostly ${loudest[0] ?? 'uncategorized'}` : ''}`,
      category: loudest?.[0] ?? null,
      count: Math.round(recent),
      windowMinutes: config.windowMinutes,
    })
  );
}

/** The logger masked a secret-shaped value: the line is safe, the log call needs fixing. */
function secrets({ snapshot }, config, firing) {
  const latest = new Map();
  for (const bucket of lastMinutes(snapshot, config.quietMinutes)) {
    for (const found of bucket.secrets) {
      const seen = latest.get(found.category);
      latest.set(found.category, {
        at: found.at,
        firstAt: seen?.firstAt ?? found.at,
        count: (seen?.count ?? 0) + 1,
        kinds: [...new Set([...(seen?.kinds ?? []), ...found.kinds])],
      });
    }
  }
  for (const [category, seen] of latest) {
    const key = `secret:${category ?? ''}`;
    firing.set(
      key,
      alertOf({
        key,
        rule: 'secret',
        severity: 'critical',
        title: `${category ?? 'uncategorized'}: a secret-shaped value (${seen.kinds.join(', ')}) was written to the log and masked; fix the log call`,
        category,
        count: seen.count,
        windowMinutes: config.quietMinutes,
        firstSeen: new Date(seen.firstAt).toISOString(),
        lastSeen: new Date(seen.at).toISOString(),
      })
    );
  }
}

/** The home frontend has been refusing alert deliveries for a while. */
function homeFrontend({ snapshot, home }, config, firing) {
  if (!home?.failingSince || snapshot.now - home.failingSince < config.minutes * MINUTE) return;
  firing.set(
    'home-frontend',
    alertOf({
      key: 'home-frontend',
      rule: 'home-frontend',
      severity: 'warning',
      title: `The home frontend (${home.url ?? 'FRONT_END_1'}) hasn't accepted alerts for ${Math.round((snapshot.now - home.failingSince) / MINUTE)} minutes`,
      firstSeen: new Date(home.failingSince).toISOString(),
    })
  );
}

/**
 * @param {object} input
 * @param {ReturnType<import('./tally.mjs').LogTally['snapshot']>} input.snapshot
 * @param {Map<string, object>} input.active the alerts firing now, by key
 * @param {Map<string, object>} input.newFingerprints fingerprints first seen by this processor recently
 * @param {{ failingSince: number | null, url: string | null }} input.home alert delivery to the home frontend
 * @param {object} input.rules thresholds (lib/alerts/settings.mjs DEFAULT_ALERTING.rules)
 * @returns {Map<string, object>} the alerts that should be firing, by key
 */
export function evaluateRules({ snapshot, active, newFingerprints, home, rules }) {
  const context = {
    snapshot,
    active,
    newFingerprints,
    home,
    observedMinutes: (snapshot.now - snapshot.startedAt) / MINUTE,
  };
  const firing = new Map();
  recurring(context, rules.recurring, firing);
  errorBurst(context, rules.errorBurst, firing);
  newError(context, rules.newError, firing);
  heartbeats(context, rules.heartbeats, firing);
  fingerprintFlood(context, rules.fingerprintFlood, firing);
  volumeSpike(context, rules.volumeSpike, firing);
  secrets(context, rules.secret, firing);
  homeFrontend(context, rules.homeFrontend, firing);
  return firing;
}
