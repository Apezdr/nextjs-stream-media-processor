// lib/libraryScanTask.mjs
//
// The two library scans that are not the scan tick's: POST /media/scan, and the
// scan the /media/tv and /media/movies payload loaders run when their table is
// empty. Both run as MEDIA_SCAN tasks, so the task manager never runs them
// beside a scan tick or the startup blurhash healing pass (one exclusive
// group): each waits until the group is free, then runs.
// They used to call the scanners directly, so they could overlap any of those.
//
// WHERE THEY ARE CALLED FROM. Both are reached from an HTTP request, never from
// inside a task. POST /media/scan is a route. The payload loader runs inside
// MediaPayloadCache.get(), and only the /media/{tv,movies} list, manifest and
// entries handlers call that. A request is not a task, so it can wait for the
// group. Called from code inside a task that holds the group (that task's own
// code, or a task enqueued from it), waiting would never end: the group frees
// only when that task ends, and the task would be waiting for this scan.
// runInScanGroup runs the scan in place there instead, under the group that
// task already holds (taskManager's isInsideTaskExcluding).
//
// One path the task manager cannot see crosses the network: the scan tick holds
// the group while its Auto Sync POSTs to the frontend, and the frontend's sync
// then reads /media/tv and /media/movies. That does not deadlock because the
// frontend answers the POST (202) before its sync reads anything; a frontend
// that answered only after its sync would make an empty-table read wait for a
// tick that waits for it.

import { TaskType, enqueueTask, isInsideTaskExcluding } from './taskManager.mjs';

/**
 * Run `scan` as a MEDIA_SCAN task and resolve with what it returns, or in
 * place when the calling code is inside a task that holds the scan group.
 *
 * @template T
 * @param {string} name - The task's name in the task status
 * @param {() => Promise<T>} scan
 * @returns {Promise<T>}
 */
export function runInScanGroup(name, scan) {
  if (isInsideTaskExcluding(TaskType.MEDIA_SCAN)) return scan();
  return enqueueTask(TaskType.MEDIA_SCAN, name, scan);
}

/**
 * The payload loader's scan of an empty table. Reads the table first and
 * enqueues nothing when it has rows. When it is empty the scan runs in the
 * scan group, after the table is read again there: a scan this one waited
 * behind may have filled it.
 *
 * @param {Object} params
 * @param {string} params.name - The task's name
 * @param {() => Promise<boolean>} params.isEmpty - isDatabaseEmpty for the table
 * @param {() => Promise<unknown>} params.scan
 * @returns {Promise<boolean>} whether the scan ran
 */
export async function scanIfTableEmpty({ name, isEmpty, scan }) {
  if (!(await isEmpty())) return false;
  return runInScanGroup(name, async () => {
    if (!(await isEmpty())) return false;
    await scan();
    return true;
  });
}

/**
 * The POST /media/scan handler: the movie scan in the scan group, then the
 * payload clear point. Answers 200 once the scan is done, which may be after a
 * running scan tick has finished, and 500 when it fails. Inside the task it
 * does what the route did before, in the same order.
 *
 * @param {Object} deps
 * @param {() => Promise<Object>} deps.openDatabase - initializeDatabase
 * @param {(db: Object) => Promise<unknown>} deps.scanMovies - The movie scan
 * @param {(db: Object) => Promise<void>} deps.releaseDatabase
 * @param {(reason: string, options: {failed: boolean}) => void} deps.clearPayloads
 *   clearMediaPayloads: called after the scan whether it failed or not
 * @param {{error: Function}} deps.logger
 * @returns {(req: Object, res: Object) => Promise<void>}
 */
export function createMediaScanHandler({ openDatabase, scanMovies, releaseDatabase, clearPayloads, logger }) {
  return async (req, res) => {
    try {
      await runInScanGroup('Movie List Generation (POST /media/scan)', async () => {
        const db = await openDatabase();
        let scanFailed = true;
        try {
          await scanMovies(db);
          scanFailed = false;
        } finally {
          // A scan that failed part-way may still have written rows.
          clearPayloads('POST /media/scan', { failed: scanFailed });
        }
        await releaseDatabase(db);
      });
      res.status(200).send('Library scan completed');
    } catch (error) {
      logger.error(`Error scanning library: ${error}`);
      res.status(500).send('Internal server error');
    }
  };
}
