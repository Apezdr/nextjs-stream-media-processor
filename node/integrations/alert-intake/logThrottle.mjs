/**
 * At most one log line a minute per kind of event, with a count of the ones
 * folded into it, so a failing relay or a stream of refused requests writes
 * a bounded number of lines (PLAN.md §7). The first of a kind is written at
 * once; repeats inside the window are counted, by reason, and reported with
 * the next line written for that kind.
 */

const MINUTE = 60_000;
const MAX_KINDS = 200;

/**
 * @param {{ now?: () => number, windowMs?: number }} [options]
 * @returns {(kind: string, reason: string, write: (folded: { total: number, byReason: Record<string, number> }) => void) => boolean}
 *   whether a line was written
 */
export function createLogThrottle({ now = Date.now, windowMs = MINUTE } = {}) {
  const kinds = new Map(); // kind → { at, total, byReason }
  return function throttled(kind, reason, write) {
    const at = now();
    const state = kinds.get(kind);
    if (state && at - state.at < windowMs) {
      state.total += 1;
      state.byReason[reason] = (state.byReason[reason] ?? 0) + 1;
      return false;
    }
    if (!state && kinds.size >= MAX_KINDS) kinds.delete(kinds.keys().next().value);
    kinds.delete(kind);
    kinds.set(kind, { at, total: 0, byReason: {} });
    write({ total: state?.total ?? 0, byReason: state?.byReason ?? {} });
    return true;
  };
}

/** " (and 3 more since the last line: wrong key 2, no key 1)", or "" for none. */
export function foldedText({ total, byReason }) {
  if (!total) return '';
  const reasons = Object.entries(byReason)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  return ` (and ${total} more since the last line${reasons ? `: ${reasons}` : ''})`;
}
