// utils/clipJobs.mjs
//
// One encode per clip, and a bounded number of encodes at a time.
//
// A request that needs a clip nobody has made yet `join`s the job for it. The
// first to arrive creates the job; everyone after shares its promise, so a burst
// of requests for one clip (a player's range requests, a second viewer) runs
// ffmpeg once and they all wait for the same finished file. This replaces a Set
// of in-flight keys that later requests polled the cache directory against —
// and which a request could race past, to be handed a clip still being written.
//
// Jobs run through a queue with a fixed concurrency. That alone would let
// abandoned work block wanted work: hovering across a row of posters asks for a
// clip per poster and gives up on each a moment later. So a job that every
// waiter has left BEFORE it started is dropped instead of run. A job that has
// started always finishes — the clip goes into the cache for the next viewer —
// and killing ffmpeg halfway would throw that work away.

import PQueue from 'p-queue';

/**
 * @typedef {Object} ClipJobTicket
 * @property {Promise<void>} done  - Settles with the job. Rejects if the job
 *   fails, or if it was dropped because every waiter left before it started.
 * @property {() => void} leave    - Call when this waiter stops caring (its
 *   client disconnected). Safe to call more than once.
 */

/**
 * @param {Object} options
 * @param {number} options.concurrency - Jobs allowed to run at once
 */
export function createClipJobRunner({ concurrency }) {
  const queue = new PQueue({ concurrency });
  /** @type {Map<string, { waiters: number, started: boolean, abort: AbortController, done: Promise<void> }>} */
  const jobs = new Map();

  /**
   * Wait for the job that produces `key`, starting it if nobody has.
   *
   * @param {string} key - Identifies the output (the clip's cache key)
   * @param {() => Promise<void>} produce - Does the work; only the first caller's is used
   * @returns {ClipJobTicket}
   */
  function join(key, produce) {
    let job = jobs.get(key);

    if (!job) {
      const abort = new AbortController();
      const created = { waiters: 0, started: false, abort, done: null };

      // p-queue checks the signal when the job reaches the front of the queue,
      // and rejects without calling the function if it has been aborted.
      created.done = queue
        .add(
          () => {
            created.started = true;
            return produce();
          },
          { signal: abort.signal }
        )
        .finally(() => {
          if (jobs.get(key) === created) jobs.delete(key);
        });

      // A dropped job rejects after its last waiter has gone; that rejection
      // has nobody to report to and must not count as unhandled.
      created.done.catch(() => {});

      jobs.set(key, created);
      job = created;
    }

    job.waiters += 1;
    let left = false;

    return {
      done: job.done,
      leave() {
        if (left) return;
        left = true;
        job.waiters -= 1;
        if (job.waiters === 0 && !job.started) {
          // Forget it now, not when the queue gets round to it: a request that
          // arrives in between must start a fresh job, not inherit a dead one.
          if (jobs.get(key) === job) jobs.delete(key);
          job.abort.abort();
        }
      },
    };
  }

  return {
    join,
    /** Jobs waiting for a slot (including dropped ones not yet cleared). */
    get queued() {
      return queue.size;
    },
    /** Jobs running now. */
    get running() {
      return queue.pending;
    },
  };
}
