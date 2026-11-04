/**
 * What the relay remembers about the alerts it has sent, per source, in
 * memory (PLAN.md §6.1). Nothing is persisted: a restart forgets, which costs
 * one repeat DM per alert still firing at its sender's next send.
 *
 * Keyed by the alert's kind and fingerprint. An entry holds the status last
 * DELIVERED and when, and the sends in flight for it, by status. The state
 * follows each send's real outcome: an entry is marked sent only when its
 * send settles OK, and a failed send leaves it as it was, so the sender's
 * retry goes through.
 *
 *   stateful (a sender that tracks state: Alertmanager, generic with a
 *   fingerprint): the same status again is a duplicate until `remindAfterMs`
 *   has passed since the last send; then a firing alert goes out once more,
 *   as a reminder. A new status is always sent.
 *   event (a one-off message: Gotify, ntfy, generic without a fingerprint):
 *   the same message within `eventWindowMs` is a duplicate. A window, not
 *   "until resolved": these formats have no resolve, and a second outage an
 *   hour on must still arrive.
 *   test sends: never deduped; pressing Test twice should DM twice.
 *
 * Bounded: at most `maxEntriesPerSource` entries a source. The oldest settled
 * entry goes first; one with a send in flight is never evicted. Losing an
 * entry can cost a repeat DM, never a lost one.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;

export const DEDUPE_DEFAULTS = Object.freeze({
  remindAfterMs: 4 * HOUR,
  eventWindowMs: 10 * MINUTE,
  maxEntriesPerSource: 2000,
});

// Expired entries swept per insert: enough to keep up, cheap per request.
const SWEEP_PER_INSERT = 8;

const keyOf = (alert) => `${alert.kind}:${alert.fingerprint}`;

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 */
export function createDedupe({ now = Date.now, ...options } = {}) {
  const { remindAfterMs, eventWindowMs, maxEntriesPerSource } = { ...DEDUPE_DEFAULTS, ...options };
  const keepFor = Math.max(remindAfterMs, eventWindowMs);
  const bySource = new Map(); // source → Map(key → { status, lastSentAt, pending: Map(status → promise) })

  const entriesOf = (source) => {
    let entries = bySource.get(source);
    if (!entries) {
      entries = new Map();
      bySource.set(source, entries);
    }
    return entries;
  };

  const settledAndExpired = (entry, at) => entry.pending.size === 0 && (entry.lastSentAt === null || at - entry.lastSentAt > keepFor);

  function makeRoom(entries, at) {
    let swept = 0;
    for (const [key, entry] of entries) {
      if (swept >= SWEEP_PER_INSERT) break;
      if (settledAndExpired(entry, at)) entries.delete(key);
      swept += 1;
    }
    if (entries.size < maxEntriesPerSource) return true;
    for (const [key, entry] of entries) {
      if (entry.pending.size === 0) {
        entries.delete(key);
        return true;
      }
    }
    return false;
  }

  function entryFor(alert, create) {
    const entries = entriesOf(alert.source);
    const key = keyOf(alert);
    let entry = entries.get(key);
    if (!entry && create && makeRoom(entries, now())) {
      entry = { status: null, lastSentAt: null, pending: new Map() };
      entries.set(key, entry);
    }
    return entry ?? null;
  }

  return {
    /**
     * What to do with an alert now.
     * @returns {{ verdict: 'new' | 'reminder' | 'duplicate' | 'inflight', pending?: Promise<object> }}
     */
    classify(alert) {
      if (alert.test) return { verdict: 'new' };
      const entry = entryFor(alert, false);
      if (!entry) return { verdict: 'new' };
      const pending = entry.pending.get(alert.status);
      if (pending) return { verdict: 'inflight', pending };
      if (entry.lastSentAt === null || entry.status !== alert.status) return { verdict: 'new' };
      const age = now() - entry.lastSentAt;
      if (alert.kind === 'event') return age < eventWindowMs ? { verdict: 'duplicate' } : { verdict: 'new' };
      if (age < remindAfterMs) return { verdict: 'duplicate' };
      return { verdict: alert.status === 'firing' ? 'reminder' : 'new' };
    },

    /** A send for `alert` has started; duplicates wait on `promise`. Test sends aren't tracked. */
    begin(alert, promise) {
      if (alert.test) return;
      entryFor(alert, true)?.pending.set(alert.status, promise);
    },

    /**
     * The send `promise` for `alert` settled (or was given up on). Marked sent
     * only when it was delivered. Only that send's in-flight mark is cleared:
     * a retry started after a hung send was given up on keeps its own.
     */
    settle(alert, delivered, promise) {
      if (alert.test) return;
      const entries = entriesOf(alert.source);
      const key = keyOf(alert);
      const entry = entries.get(key);
      if (!entry && !delivered) return;
      const target = entry ?? entryFor(alert, true);
      if (!target) return;
      if (promise === undefined || target.pending.get(alert.status) === promise) target.pending.delete(alert.status);
      if (delivered) {
        target.status = alert.status;
        target.lastSentAt = now();
        // Most recently sent last, so eviction and sweeping start at the oldest.
        entries.delete(key);
        entries.set(key, target);
      } else if (target.pending.size === 0 && target.lastSentAt === null) {
        entries.delete(key);
      }
    },

    /** Entries held for `source` (tests and bounds). */
    size(source) {
      return bySource.get(source)?.size ?? 0;
    },
  };
}
