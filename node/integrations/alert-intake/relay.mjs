/**
 * From a request's normalized alerts to one Discord message (PLAN.md §6):
 * observers, dedupe, rate caps, embeds, the send, and what the request
 * answers.
 *
 * Delivery state follows each send's REAL outcome. The Discord client keeps
 * retrying past any deadline of ours (@discordjs/rest: 15 s a try, 3
 * retries), so a request that stops waiting has not seen a failure:
 *
 *   - A request waits for its send at most `responseBudgetMs`. Past it the
 *     answer is 503 ("still in progress, retry"), never an early 200, and the
 *     send carries on.
 *   - A duplicate that arrives while the same alert's send is in flight waits
 *     for that send and answers with its result.
 *   - An alert is remembered as sent only when its send settles OK. A failed
 *     send leaves the memory as it was and gives its rate-cap tokens back.
 *   - Held (rate-capped) alerts are never remembered as sent; the summary
 *     embed reports them.
 *   - After a send that called Discord and failed (refused, threw, or never
 *     settled) the breaker opens for `breakerMs`: new alerts answer 503
 *     without starting a send, so a Discord outage isn't hammered by every
 *     sender's retries. "No target" and "bot not ready" don't open it.
 *
 * Nothing here may reject unhandled: every send, timer and late settlement is
 * caught. An unhandled rejection shuts the processor down (app.mjs).
 *
 * Logs only through the `log` it is given (the alert-intake category, never
 * fingerprinted: lib/alerts/tally.mjs UNALERTED_CATEGORIES), and repeated
 * failures at most once a minute.
 */

import { createDedupe } from './dedupe.mjs';
import { createBucket } from './rateLimit.mjs';
import { intakeEmbeds, heldSummaryEmbed } from './embeds.mjs';
import { SEVERITY_RANK } from './alert.mjs';
import { createLogThrottle, foldedText } from './logThrottle.mjs';
import { DEFAULT_LIMITS } from './config.mjs';

export const RELAY_DEFAULTS = Object.freeze({
  responseBudgetMs: 10_000,
  breakerMs: 30_000,
  // A send that hasn't settled by now (a hung promise) stops holding its
  // alerts: duplicates no longer wait on it and a retry starts a new send.
  abandonAfterMs: 5 * 60_000,
  summarySamples: 5,
  summaryKeys: 500,
  minSummaryDelayMs: 1000,
});

/**
 * Which alerts skip the per-source cap. They still need a global token.
 * The decision of 2026-11-04 is critical ones; change it here.
 */
export const skipsSourceCap = (alert) => alert.severity === 'critical';

const TIMED_OUT = Symbol('timed out');

const REASON_TEXT = {
  'no-target': 'no Discord channel is configured',
  'not-ready': 'the Discord bot is not ready',
  rejected: 'Discord refused it',
  error: 'the send failed',
  abandoned: 'the send had not settled after 5 minutes',
};

/**
 * The failures that mean Discord was called and it went wrong. Only these
 * open the breaker: "no target" and "not ready" made no Discord call, and at
 * startup a breaker on them would turn a missed ready wait into 30 s more of
 * 503s, which Uptime Kuma and the *arr apps (no retries) lose.
 */
const DISCORD_FAILURES = new Set(['rejected', 'error', 'abandoned']);

/** The HTTP status of a request the relay didn't accept. */
export function failureStatus(outcome) {
  return DISCORD_FAILURES.has(outcome.reason) ? 502 : 503;
}

const describeFailure = (result) => {
  const detail = result.detail ? `: ${String(result.detail).slice(0, 160)}` : '';
  return `${REASON_TEXT[result.reason] ?? result.reason}${detail}`;
};

/**
 * @param {object} options
 * @param {{ deliver(embeds: object[]): Promise<{ ok: boolean, reason?: string, detail?: string, delivered?: number, failed?: number }> }} options.sink
 * @param {typeof DEFAULT_LIMITS} [options.limits]
 * @param {string} options.processorLabel
 * @param {{ info: Function, warn: Function, debug: Function }} options.log
 * @param {((batch: { alerts: object[], source: string, format: string }) => void)[]} [options.observers]
 *   v2's seam: called with every request's alerts BEFORE dedupe and the caps,
 *   so storage sees duplicates and held alerts too
 */
export function createIntakeRelay({
  sink,
  limits = DEFAULT_LIMITS,
  processorLabel,
  log,
  observers = [],
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  skips = skipsSourceCap,
  dedupeOptions = {},
  ...overrides
}) {
  const options = { ...RELAY_DEFAULTS, ...overrides };
  const dedupe = createDedupe({ now, ...dedupeOptions });
  const throttled = createLogThrottle({ now });
  const sourceBuckets = new Map();
  const globalBucket = createBucket({ capacity: limits.globalBurst, perHour: limits.globalPerHour, now });
  const summaries = new Map(); // source → held-alert summary
  const inflight = new Set(); // every send and summary send not yet settled, for drain()
  let breakerUntil = 0;

  const sourceBucket = (source) => {
    let bucket = sourceBuckets.get(source);
    if (!bucket) {
      bucket = createBucket({ capacity: limits.sourceBurst, perHour: limits.sourcePerHour, now });
      sourceBuckets.set(source, bucket);
    }
    return bucket;
  };

  const breakerOpen = () => now() < breakerUntil;
  const breakerSeconds = () => Math.max(1, Math.ceil((breakerUntil - now()) / 1000));

  /** Opens the breaker for a failure that called Discord; others leave it as it is. */
  function tripBreaker(reason) {
    if (DISCORD_FAILURES.has(reason)) breakerUntil = now() + options.breakerMs;
  }

  /** A log call that can't throw into the relay. */
  const safely = (write) => {
    try {
      write();
    } catch {
      // logging must never break the relay
    }
  };

  function track(promise) {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise)).catch(() => {});
    return promise;
  }

  function observe(batch) {
    for (const observer of observers) {
      try {
        observer(batch);
      } catch (error) {
        safely(() =>
          throttled('observer', 'error', (folded) => log.warn(`An alert intake observer threw: ${String(error?.message ?? error).slice(0, 160)}${foldedText(folded)}`))
        );
      }
    }
  }

  /** One throttled line for a failed send; `paused` when it opened the breaker. */
  function noteFailure(source, result, paused) {
    const pause = paused ? `; new sends pause for ${Math.round(options.breakerMs / 1000)} s` : '';
    safely(() =>
      throttled(`relay-failed:${source}`, result.reason, (folded) =>
        log.warn(`Relay to Discord failed for ${source}: ${describeFailure(result)}${pause}${foldedText(folded)}`)
      )
    );
  }

  /** Splits fresh alerts into those that go now and those held at a cap; takes the tokens. */
  function takeTokens(source, fresh) {
    const bucket = sourceBucket(source);
    const capped = fresh.filter((alert) => !skips(alert));
    let sending = fresh.filter((alert) => skips(alert));
    let sourceToken = false;
    const held = [];
    if (capped.length) {
      if (bucket.take()) {
        sourceToken = true;
        sending = fresh;
      } else {
        held.push(...capped);
      }
    }
    if (sending.length && !globalBucket.take()) {
      if (sourceToken) bucket.refund();
      sourceToken = false;
      held.push(...sending);
      sending = [];
    }
    return { sending, held, refund: () => {
      if (sourceToken) bucket.refund();
      if (sending.length) globalBucket.refund();
    } };
  }

  function startSend({ source, format, alerts, reminders, truncated, refund }) {
    const embeds = intakeEmbeds(alerts, { source, format, processorLabel, reminders, truncated });
    let refunded = false;
    let settled = false;
    let abandoned = false;
    let abandonTimer = null;
    const giveBack = () => {
      if (refunded) return;
      refunded = true;
      refund();
    };

    let promise;
    const onSettled = (result) => {
      settled = true;
      if (abandonTimer) timers.clearTimeout(abandonTimer);
      for (const alert of alerts) dedupe.settle(alert, result.ok, promise);
      if (result.ok) {
        safely(() => log.info(`Relayed ${alerts.length} alert${alerts.length === 1 ? '' : 's'} from ${source} (${format}) to ${result.delivered ?? 1} Discord target(s)`));
        if (result.failed) {
          safely(() =>
            throttled(`relay-partial:${source}`, 'partial', (folded) =>
              log.warn(`Relay to Discord for ${source} reached ${result.delivered} target(s), ${result.failed} refused it${foldedText(folded)}`)
            )
          );
        }
      } else {
        giveBack();
        // A send given up on already opened the breaker when it was abandoned;
        // its failure landing minutes later must not pause the relay again.
        const pauses = !abandoned && DISCORD_FAILURES.has(result.reason);
        if (pauses) tripBreaker(result.reason);
        noteFailure(source, result, pauses);
      }
    };

    promise = track(
      Promise.resolve()
        .then(() => sink.deliver(embeds))
        .catch((error) => ({ ok: false, reason: 'error', detail: error?.message ?? String(error) }))
        .then((raw) => {
          const result = raw?.ok
            ? { ok: true, delivered: raw.delivered, failed: raw.failed }
            : { ok: false, reason: raw?.reason ?? 'error', detail: raw?.detail };
          try {
            onSettled(result);
          } catch {
            // a bookkeeping slip must not leave the promise rejected
          }
          return result;
        })
    );
    for (const alert of alerts) dedupe.begin(alert, promise);

    abandonTimer = timers.setTimeout(() => {
      if (settled) return;
      abandoned = true;
      try {
        for (const alert of alerts) dedupe.settle(alert, false, promise);
        giveBack();
        tripBreaker('abandoned');
        noteFailure(source, { reason: 'abandoned' }, true);
      } catch {
        // as above
      }
    }, options.abandonAfterMs);
    abandonTimer?.unref?.();
    return { promise, alerts };
  }

  async function withinBudget(promise) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve(TIMED_OUT), options.responseBudgetMs);
      timer?.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  // Held-alert summaries: one per source, sent when the source has a token again.

  function hold(source, alerts) {
    const at = now();
    let summary = summaries.get(source);
    if (!summary) {
      summary = { count: 0, keys: new Set(), bySeverity: {}, firstAt: at, lastAt: at, samples: [], timer: null };
      summaries.set(source, summary);
    }
    for (const alert of alerts) {
      const key = `${alert.kind}:${alert.fingerprint}:${alert.status}`;
      if (summary.keys.has(key)) continue;
      if (summary.keys.size < options.summaryKeys) summary.keys.add(key);
      summary.count += 1;
      summary.bySeverity[alert.severity] = (summary.bySeverity[alert.severity] ?? 0) + 1;
      summary.lastAt = at;
      summary.samples.push({ severity: alert.severity, title: alert.title, at });
      summary.samples.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.at - a.at);
      summary.samples.length = Math.min(summary.samples.length, options.summarySamples);
    }
    safely(() => log.debug(`Held ${alerts.length} alert(s) from ${source} at the rate cap`));
    if (!summary.timer) scheduleSummary(source, sourceBucket(source).msUntilToken());
  }

  function scheduleSummary(source, delayMs) {
    const summary = summaries.get(source);
    if (!summary) return;
    summary.timer = timers.setTimeout(() => {
      summary.timer = null;
      track(sendSummary(source)).catch(() => {});
    }, Math.max(options.minSummaryDelayMs, delayMs));
    summary.timer?.unref?.();
  }

  function mergeBack(source, summary) {
    const current = summaries.get(source);
    if (!current) {
      summaries.set(source, { ...summary, timer: null });
      return;
    }
    current.count += summary.count;
    for (const [severity, count] of Object.entries(summary.bySeverity)) current.bySeverity[severity] = (current.bySeverity[severity] ?? 0) + count;
    current.firstAt = Math.min(current.firstAt, summary.firstAt);
    current.samples = [...current.samples, ...summary.samples]
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.at - a.at)
      .slice(0, options.summarySamples);
  }

  async function sendSummary(source) {
    try {
      const summary = summaries.get(source);
      if (!summary || summary.count === 0) {
        summaries.delete(source);
        return;
      }
      if (breakerOpen()) {
        scheduleSummary(source, breakerUntil - now());
        return;
      }
      const bucket = sourceBucket(source);
      if (!bucket.take()) {
        scheduleSummary(source, bucket.msUntilToken());
        return;
      }
      // Holds from here on start the next summary.
      summaries.delete(source);
      const embed = heldSummaryEmbed(summary, { source, perHour: limits.sourcePerHour, processorLabel });
      let result;
      try {
        result = await sink.deliver([embed]);
      } catch (error) {
        result = { ok: false, reason: 'error', detail: error?.message ?? String(error) };
      }
      if (result?.ok) {
        safely(() => log.info(`Sent the rate-cap summary for ${source}: ${summary.count} alert(s) held back`));
        return;
      }
      const failure = { reason: result?.reason ?? 'error', detail: result?.detail };
      bucket.refund();
      tripBreaker(failure.reason);
      noteFailure(source, failure, DISCORD_FAILURES.has(failure.reason));
      mergeBack(source, summary);
      const current = summaries.get(source);
      if (current && !current.timer) scheduleSummary(source, options.breakerMs);
    } catch (error) {
      safely(() => log.warn(`The rate-cap summary for ${source} failed: ${String(error?.message ?? error).slice(0, 160)}`));
    }
  }

  return {
    /**
     * Relay one request's alerts and say what the request should answer.
     * @param {object[]} alerts
     * @param {{ source: string, format: string, truncated?: number }} context
     * @returns {Promise<{ accepted: boolean, outcome: 'delivered'|'duplicate'|'held'|'failed'|'pending'|'breaker', reason: string|null,
     *   counts: { received: number, delivered: number, duplicates: number, held: number }, retryAfterSec: number|null }>}
     */
    async deliver(alerts, { source, format, truncated = 0 }) {
      for (const alert of alerts) alert.source = source;
      observe({ alerts, source, format });

      const counts = { received: alerts.length, delivered: 0, duplicates: 0, held: 0 };
      const fresh = [];
      const reminders = new Set();
      const waits = new Set();
      let waiting = 0;
      for (const alert of alerts) {
        const { verdict, pending } = dedupe.classify(alert);
        if (verdict === 'duplicate') counts.duplicates += 1;
        else if (verdict === 'inflight') {
          waits.add(pending);
          waiting += 1;
        } else {
          fresh.push(alert);
          if (verdict === 'reminder') reminders.add(alert.id);
        }
      }

      let own = null;
      if (fresh.length) {
        if (breakerOpen()) {
          safely(() => log.debug(`Refused ${fresh.length} alert(s) from ${source} while relaying is paused`));
          return { accepted: false, outcome: 'breaker', reason: 'breaker', counts, retryAfterSec: breakerSeconds() };
        }
        const { sending, held, refund } = takeTokens(source, fresh);
        if (held.length) {
          counts.held = held.length;
          hold(source, held);
        }
        if (sending.length) {
          own = startSend({ source, format, alerts: sending, reminders, truncated, refund });
          waits.add(own.promise);
        }
      }

      if (waits.size === 0) {
        if (counts.duplicates) safely(() => log.debug(`Dropped ${counts.duplicates} duplicate alert(s) from ${source}`));
        return { accepted: true, outcome: counts.duplicates ? 'duplicate' : 'held', reason: null, counts, retryAfterSec: null };
      }

      const results = await withinBudget(Promise.all(waits));
      if (results === TIMED_OUT) {
        return { accepted: false, outcome: 'pending', reason: 'pending', counts, retryAfterSec: Math.ceil(options.breakerMs / 1000) };
      }
      const failure = results.find((result) => !result.ok);
      if (failure) {
        return { accepted: false, outcome: 'failed', reason: failure.reason, counts, retryAfterSec: breakerOpen() ? breakerSeconds() : null };
      }
      if (own) counts.delivered = own.alerts.length;
      counts.duplicates += waiting;
      return { accepted: true, outcome: counts.delivered ? 'delivered' : counts.duplicates ? 'duplicate' : 'held', reason: null, counts, retryAfterSec: null };
    },

    /** Resolves once every send and summary send started so far has settled (tests, shutdown). */
    async drain() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },

    /** The held-alert summary waiting for a source, if any (tests). */
    heldSummary: (source) => summaries.get(source) ?? null,
  };
}
