/**
 * utils/clipJobs.mjs: one job per clip however many requests want it, a cap on
 * how many run at once, and no work done for a clip nobody is waiting for.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { createClipJobRunner } from '../../../utils/clipJobs.mjs';

/** A job whose completion the test controls. */
function controllable() {
  let release;
  let fail;
  const gate = new Promise((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const produce = jest.fn(() => gate);
  return { produce, release, fail };
}

/** Let queued promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('createClipJobRunner', () => {
  it('runs one job for a key, however many callers join it', async () => {
    const jobs = createClipJobRunner({ concurrency: 2 });
    const first = controllable();
    const second = jest.fn(async () => {});

    const a = jobs.join('clip', first.produce);
    const b = jobs.join('clip', second);
    const c = jobs.join('clip', second);
    await settle();

    expect(first.produce).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    first.release();
    await Promise.all([a.done, b.done, c.done]);
  });

  it('starts a fresh job for a key once the previous one has finished', async () => {
    const jobs = createClipJobRunner({ concurrency: 2 });
    const produce = jest.fn(async () => {});

    await jobs.join('clip', produce).done;
    await jobs.join('clip', produce).done;

    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('runs no more jobs at once than its concurrency', async () => {
    const jobs = createClipJobRunner({ concurrency: 2 });
    const [one, two, three] = [controllable(), controllable(), controllable()];

    const a = jobs.join('one', one.produce);
    const b = jobs.join('two', two.produce);
    const c = jobs.join('three', three.produce);
    await settle();

    expect(one.produce).toHaveBeenCalledTimes(1);
    expect(two.produce).toHaveBeenCalledTimes(1);
    expect(three.produce).not.toHaveBeenCalled();
    expect(jobs.running).toBe(2);
    expect(jobs.queued).toBe(1);

    one.release();
    await a.done;
    await settle();
    expect(three.produce).toHaveBeenCalledTimes(1);

    two.release();
    three.release();
    await Promise.all([b.done, c.done]);
  });

  it('gives every waiter the failure when the job fails, and forgets the job', async () => {
    const jobs = createClipJobRunner({ concurrency: 1 });
    const failing = controllable();

    const a = jobs.join('clip', failing.produce);
    const b = jobs.join('clip', failing.produce);
    failing.fail(new Error('FFmpeg exited with code 1'));

    await expect(a.done).rejects.toThrow('FFmpeg exited with code 1');
    await expect(b.done).rejects.toThrow('FFmpeg exited with code 1');

    // The next request tries again rather than inheriting the failure.
    const retry = jest.fn(async () => {});
    await jobs.join('clip', retry).done;
    expect(retry).toHaveBeenCalledTimes(1);
  });

  describe('when waiters leave', () => {
    it('never runs a queued job that every waiter has left', async () => {
      const jobs = createClipJobRunner({ concurrency: 1 });
      const running = controllable();
      const abandoned = jest.fn(async () => {});

      const a = jobs.join('running', running.produce);
      const b = jobs.join('abandoned', abandoned);
      const b2 = jobs.join('abandoned', abandoned);
      await settle();

      b.leave();
      b2.leave();
      running.release();
      await a.done;

      await expect(b.done).rejects.toMatchObject({ name: 'AbortError' });
      expect(abandoned).not.toHaveBeenCalled();
    });

    it('still runs a queued job while one waiter remains', async () => {
      const jobs = createClipJobRunner({ concurrency: 1 });
      const running = controllable();
      const wanted = jest.fn(async () => {});

      const a = jobs.join('running', running.produce);
      const b = jobs.join('wanted', wanted);
      const b2 = jobs.join('wanted', wanted);
      await settle();

      b.leave();
      running.release();
      await a.done;
      await b2.done;

      expect(wanted).toHaveBeenCalledTimes(1);
    });

    it('finishes a job that has started even if everyone leaves: the clip is still worth caching', async () => {
      const jobs = createClipJobRunner({ concurrency: 1 });
      const started = controllable();

      const a = jobs.join('clip', started.produce);
      await settle();
      expect(started.produce).toHaveBeenCalledTimes(1);

      a.leave();
      started.release('done');
      await expect(a.done).resolves.toBe('done');
    });

    it('starts a fresh job for a request that arrives after the last waiter left', async () => {
      const jobs = createClipJobRunner({ concurrency: 1 });
      const running = controllable();
      const abandoned = jest.fn(async () => {});
      const fresh = jest.fn(async () => {});

      const a = jobs.join('running', running.produce);
      const b = jobs.join('clip', abandoned);
      await settle();
      b.leave();

      // Same key, while the dropped job is still sitting in the queue.
      const c = jobs.join('clip', fresh);
      running.release();
      await a.done;
      await c.done;

      expect(abandoned).not.toHaveBeenCalled();
      expect(fresh).toHaveBeenCalledTimes(1);
    });

    it('counts a waiter once, however many times it leaves', async () => {
      const jobs = createClipJobRunner({ concurrency: 1 });
      const running = controllable();
      const wanted = jest.fn(async () => {});

      const a = jobs.join('running', running.produce);
      const b = jobs.join('wanted', wanted);
      const b2 = jobs.join('wanted', wanted);
      await settle();

      b.leave();
      b.leave();
      b.leave();
      running.release();
      await a.done;
      await b2.done;

      expect(wanted).toHaveBeenCalledTimes(1);
    });

    it('does not turn a dropped job into an unhandled rejection', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const jobs = createClipJobRunner({ concurrency: 1 });
        const running = controllable();

        const a = jobs.join('running', running.produce);
        const b = jobs.join('abandoned', async () => {});
        await settle();
        b.leave(); // and nobody awaits b.done

        running.release();
        await a.done;
        await settle();
        await settle();

        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });
});
