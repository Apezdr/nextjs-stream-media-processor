/**
 * POST /media/scan and the payload loaders' empty-table scan run as MEDIA_SCAN
 * tasks (lib/libraryScanTask.mjs), on the real task manager:
 *
 *  - neither runs while a BLURHASH or a MEDIA_SCAN task is running: each waits
 *    for it to end, then runs;
 *  - the empty-table scan reads the table again once it has the group, and
 *    enqueues nothing for a table with rows;
 *  - the context: code outside every task (a request) waits for the group;
 *    code inside a task that holds it (that task, or one enqueued from it)
 *    runs the scan in place instead of waiting for itself. A task enqueued
 *    from one that has since ended holds nothing.
 *  - POST /media/scan keeps its answers (200 after the scan, 500 on failure)
 *    and its clear point.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';

const { TaskType, enqueueTask, getTaskStatus, isInsideTaskExcluding } = await import('../../../lib/taskManager.mjs');
const { runInScanGroup, scanIfTableEmpty, createMediaScanHandler } = await import('../../../lib/libraryScanTask.mjs');

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** A task of `type` that runs until release() is called. */
async function blockingTask(type, events, label) {
  const gate = deferred();
  const done = enqueueTask(type, `test blocker ${label}`, async () => {
    events.push(`${label} start`);
    await gate.promise;
    events.push(`${label} end`);
  });
  await tick();
  expect(events).toContain(`${label} start`);
  return { release: () => gate.resolve(), done };
}

/** Rejects if `promise` has not settled within `ms`: a deadlock fails the test instead of hanging it. */
function within(promise, ms = 2000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('did not settle')), ms))]);
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.send = jest.fn((body) => { res.body = body; return res; });
  return res;
}

afterEach(async () => {
  await tick();
  expect(getTaskStatus().activeTasks).toEqual([]);
});

describe('isInsideTaskExcluding', () => {
  it('is false outside every task and true inside a task of the scan group', async () => {
    expect(isInsideTaskExcluding(TaskType.MEDIA_SCAN)).toBe(false);
    for (const type of [TaskType.MEDIA_SCAN, TaskType.BLURHASH, TaskType.METADATA_HASH]) {
      expect(await enqueueTask(type, 'probe', async () => isInsideTaskExcluding(TaskType.MEDIA_SCAN))).toBe(true);
    }
    expect(await enqueueTask(TaskType.API_REQUEST, 'probe', async () => isInsideTaskExcluding(TaskType.MEDIA_SCAN))).toBe(false);
  });

  it('is true in a task enqueued from a scan-group task while that task runs', async () => {
    const inside = await enqueueTask(TaskType.MEDIA_SCAN, 'outer', () =>
      enqueueTask(TaskType.MOVIE_SCAN, 'inner', async () => {
        await tick();
        return isInsideTaskExcluding(TaskType.MEDIA_SCAN);
      })
    );
    expect(inside).toBe(true);
  });

  it('is false in a task enqueued from a scan-group task that has ended', async () => {
    const started = deferred();
    const gate = deferred();
    let inner;
    await enqueueTask(TaskType.MEDIA_SCAN, 'outer', async () => {
      // Not awaited: it starts while the outer task runs and checks after it ended.
      inner = enqueueTask(TaskType.DOWNLOAD, 'inner', async () => {
        started.resolve();
        await gate.promise;
        return isInsideTaskExcluding(TaskType.MEDIA_SCAN);
      });
      await started.promise;
    });
    gate.resolve();
    expect(await inner).toBe(false);
  });

  it('is false in a callback that a request-like context schedules, even while a scan runs', async () => {
    const events = [];
    const blocker = await blockingTask(TaskType.MEDIA_SCAN, events, 'scan');
    const seen = await new Promise((resolve) => setImmediate(() => resolve(isInsideTaskExcluding(TaskType.MEDIA_SCAN))));
    expect(seen).toBe(false);
    blocker.release();
    await blocker.done;
  });
});

describe('the payload loader\'s empty-table scan', () => {
  it.each([
    ['BLURHASH', TaskType.BLURHASH],
    ['MEDIA_SCAN', TaskType.MEDIA_SCAN],
  ])('waits while a %s task runs, then runs', async (label, type) => {
    const events = [];
    const blocker = await blockingTask(type, events, label);
    const scan = jest.fn(async () => { events.push('scan'); });

    const ran = scanIfTableEmpty({ name: 'test empty-table scan', isEmpty: async () => true, scan });
    await tick();
    expect(scan).not.toHaveBeenCalled();

    blocker.release();
    expect(await within(ran)).toBe(true);
    expect(events).toEqual([`${label} start`, `${label} end`, 'scan']);
  });

  it('runs as a MEDIA_SCAN task: a BLURHASH task waits for it', async () => {
    const events = [];
    const gate = deferred();
    const ran = scanIfTableEmpty({
      name: 'test empty-table scan',
      isEmpty: async () => true,
      scan: async () => { events.push('scan start'); await gate.promise; events.push('scan end'); },
    });
    await tick();
    expect(getTaskStatus().activeTasks.map((t) => [t.type, t.name])).toEqual([[TaskType.MEDIA_SCAN, 'test empty-table scan']]);
    const healing = enqueueTask(TaskType.BLURHASH, 'test healing', async () => { events.push('healing'); });
    await tick();
    expect(events).toEqual(['scan start']);
    gate.resolve();
    await within(Promise.all([ran, healing]));
    expect(events).toEqual(['scan start', 'scan end', 'healing']);
  });

  it('enqueues nothing for a table with rows, and does not scan one a waited-for scan filled', async () => {
    const scan = jest.fn(async () => {});
    expect(await scanIfTableEmpty({ name: 'test', isEmpty: async () => false, scan })).toBe(false);
    expect(getTaskStatus().activeTasks).toEqual([]);

    const events = [];
    const blocker = await blockingTask(TaskType.MEDIA_SCAN, events, 'tick');
    let empty = true;
    const ran = scanIfTableEmpty({ name: 'test', isEmpty: async () => empty, scan });
    await tick();
    empty = false; // the tick it waited behind wrote rows
    blocker.release();
    expect(await within(ran)).toBe(false);
    expect(scan).not.toHaveBeenCalled();
  });

  it.each([
    ['a MEDIA_SCAN task', TaskType.MEDIA_SCAN],
    ['a BLURHASH task', TaskType.BLURHASH],
  ])('called from inside %s, runs in place instead of waiting for itself', async (label, type) => {
    const scan = jest.fn(async () => {});
    const ran = enqueueTask(type, 'holder', () =>
      scanIfTableEmpty({ name: 'test nested', isEmpty: async () => true, scan })
    );
    expect(await within(ran)).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('called from a task the scan tick enqueued (MOVIE_SCAN inside MEDIA_SCAN), runs in place', async () => {
    const scan = jest.fn(async () => {});
    const ran = enqueueTask(TaskType.MEDIA_SCAN, 'tick', () =>
      enqueueTask(TaskType.MOVIE_SCAN, 'movies', () =>
        scanIfTableEmpty({ name: 'test nested', isEmpty: async () => true, scan })
      )
    );
    expect(await within(ran)).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('a request-like caller is outside every task: it waits for the group', async () => {
    const events = [];
    const blocker = await blockingTask(TaskType.MEDIA_SCAN, events, 'tick');
    const scan = jest.fn(async () => { events.push('scan'); });
    // The payload loader runs in MediaPayloadCache.get(), called from a route
    // handler: a callback with no task around it.
    const { ran } = await new Promise((resolve) =>
      setImmediate(() => resolve({ ran: scanIfTableEmpty({ name: 'test', isEmpty: async () => true, scan }) }))
    );
    await tick();
    expect(scan).not.toHaveBeenCalled();
    blocker.release();
    expect(await within(ran)).toBe(true);
    expect(events).toEqual(['tick start', 'tick end', 'scan']);
  });
});

describe('POST /media/scan', () => {
  const handler = (overrides = {}) => {
    const deps = {
      openDatabase: jest.fn(async () => ({ db: true })),
      scanMovies: jest.fn(async () => {}),
      releaseDatabase: jest.fn(async () => {}),
      clearPayloads: jest.fn(),
      logger: { error: jest.fn() },
      ...overrides,
    };
    return { deps, handle: createMediaScanHandler(deps) };
  };

  it.each([
    ['BLURHASH', TaskType.BLURHASH],
    ['MEDIA_SCAN', TaskType.MEDIA_SCAN],
  ])('waits while a %s task runs, then scans and answers 200', async (label, type) => {
    const events = [];
    const blocker = await blockingTask(type, events, label);
    const { deps, handle } = handler({ scanMovies: jest.fn(async () => { events.push('scan'); }) });
    const res = fakeRes();

    const answered = handle({}, res);
    await tick();
    expect(deps.scanMovies).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();

    blocker.release();
    await within(answered);
    expect(events).toEqual([`${label} start`, `${label} end`, 'scan']);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('Library scan completed');
    expect(deps.scanMovies).toHaveBeenCalledWith({ db: true });
    expect(deps.clearPayloads).toHaveBeenCalledWith('POST /media/scan', { failed: false });
    expect(deps.releaseDatabase).toHaveBeenCalledWith({ db: true });
  });

  it('runs as a MEDIA_SCAN task named for the route', async () => {
    const gate = deferred();
    const { handle } = handler({ scanMovies: () => gate.promise });
    const answered = handle({}, fakeRes());
    await tick();
    expect(getTaskStatus().activeTasks.map((t) => [t.type, t.name])).toEqual([
      [TaskType.MEDIA_SCAN, 'Movie List Generation (POST /media/scan)'],
    ]);
    gate.resolve();
    await within(answered);
  });

  it('answers 500 when the scan fails, after clearing every payload', async () => {
    const { deps, handle } = handler({ scanMovies: jest.fn(async () => { throw new Error('disk gone'); }) });
    const res = fakeRes();
    await within(handle({}, res));
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe('Internal server error');
    expect(deps.clearPayloads).toHaveBeenCalledWith('POST /media/scan', { failed: true });
    expect(deps.releaseDatabase).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining('disk gone'));
  });

  it('answers 500 without a clear when the database cannot be opened, as before', async () => {
    const { deps, handle } = handler({ openDatabase: jest.fn(async () => { throw new Error('no db'); }) });
    const res = fakeRes();
    await within(handle({}, res));
    expect(res.statusCode).toBe(500);
    expect(deps.scanMovies).not.toHaveBeenCalled();
    expect(deps.clearPayloads).not.toHaveBeenCalled();
  });
});

describe('runInScanGroup', () => {
  it('resolves with what the scan returns and rejects with what it throws', async () => {
    expect(await runInScanGroup('test', async () => 42)).toBe(42);
    await expect(runInScanGroup('test', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
