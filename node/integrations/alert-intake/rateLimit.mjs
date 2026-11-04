/**
 * Token buckets for the relay's rate caps (PLAN.md §6.2): one per source and
 * one for all sources, counted in Discord messages. Tokens refill
 * continuously; a send that fails gives its token back, so a Discord outage
 * doesn't use up a sender's allowance.
 */

/**
 * @param {object} options
 * @param {number} options.capacity  the burst
 * @param {number} options.perHour   the sustained rate
 * @param {() => number} [options.now]
 */
export function createBucket({ capacity, perHour, now = Date.now }) {
  const refillMs = 3_600_000 / perHour;
  let tokens = capacity;
  let updatedAt = now();

  function refill() {
    const at = now();
    tokens = Math.min(capacity, tokens + (at - updatedAt) / refillMs);
    updatedAt = at;
  }

  return {
    /** Takes a token if there is one. */
    take() {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    /** Gives a token back (a send that failed). */
    refund() {
      refill();
      tokens = Math.min(capacity, tokens + 1);
    },
    /** How long until a token is there; 0 when one is. */
    msUntilToken() {
      refill();
      return tokens >= 1 ? 0 : Math.ceil((1 - tokens) * refillMs);
    },
    get tokens() {
      refill();
      return tokens;
    },
  };
}
