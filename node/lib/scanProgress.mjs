// lib/scanProgress.mjs
//
// Mirrors a library scan into process_queue, the table behind GET /processes
// and the admin panel's Active Processes card. Scans run through the task
// manager, which only tracks them in memory, so without this they never show.
//
// One row per library under a fixed key (library_scan_movies,
// library_scan_tv), overwritten by every tick, so the table does not grow. A
// restart mid-scan leaves the row 'interrupted' (markInProgressAsInterrupted)
// until the next tick overwrites it.
//
// Progress writes are throttled: a tick where nothing changed walks every
// title in seconds. They are also chained, so a slow progress write can never
// land after the final one and put a finished scan back to 'in-progress'.
// Tracking never fails a scan: a failed write is logged and dropped.

import { createCategoryLogger } from './logger.mjs';
import { createOrUpdateProcessQueue, getProcessTrackingDb } from '../sqlite/processTracking.mjs';

const logger = createCategoryLogger('scanProgress');

export const LIBRARY_SCAN_PROCESS_TYPE = 'library-scan';
export const SCAN_PROGRESS_INTERVAL_MS = 2000;

const UNITS = { movies: 'movies', tv: 'shows' };

async function writeProcessRow(fileKey, { totalSteps, currentStep, status, message }) {
  const db = await getProcessTrackingDb();
  await createOrUpdateProcessQueue(
    db, fileKey, LIBRARY_SCAN_PROCESS_TYPE, totalSteps, currentStep, status, message
  );
}

/**
 * "12s", "2m 14s", "1h 12m".
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Starts tracking one library scan.
 *
 * Pass `onProgress` to the scanner; it calls it as each title starts. Then
 * call `complete(summary)` with what the scanner returned, or `fail(error)`
 * if it threw.
 *
 * @param {'movies'|'tv'} library
 * @param {object} [options]
 * @param {Function} [options.write] - (fileKey, row) => Promise; the process_queue upsert.
 * @param {Function} [options.now] - clock, in ms.
 * @param {number} [options.intervalMs] - minimum gap between progress writes.
 */
export function createLibraryScanProgress(library, {
  write = writeProcessRow,
  now = Date.now,
  intervalMs = SCAN_PROGRESS_INTERVAL_MS,
} = {}) {
  const fileKey = `library_scan_${library}`;
  const unit = UNITS[library] ?? library;
  const startedAt = now();
  let lastWriteAt = null;
  let current = null; // the last title reported: { position, total, name }
  let writes = Promise.resolve();

  const enqueue = (row) => {
    writes = writes
      .then(() => write(fileKey, row))
      .catch((error) => {
        logger.warn(`Could not record ${library} scan progress: ${error.message}`);
      });
    return writes;
  };

  const where = () => current
    ? `${current.name} (${current.position} of ${current.total} ${unit})`
    : 'the start';

  const stopped = (prefix, error) => enqueue({
    totalSteps: current?.total ?? 0,
    currentStep: current ? current.position - 1 : 0,
    status: 'error',
    message: `${prefix} ${where()}: ${error?.message ?? error}`,
  });

  return {
    /**
     * Called by the scanner as each title starts. Never throws.
     * @param {{position: number, total: number, name: string}} progress - position is 1-based.
     */
    onProgress({ position, total, name }) {
      current = { position, total, name };
      const at = now();
      if (lastWriteAt !== null && at - lastWriteAt < intervalMs) return;
      lastWriteAt = at;
      enqueue({
        totalSteps: total,
        currentStep: position - 1,
        status: 'in-progress',
        message: where(),
      });
    },

    /**
     * Records the finished scan. A summary carrying `error` (the TV scanner
     * catches its own failures) is recorded as one.
     * @param {{titles?: number, reprocessed?: number, error?: Error|null}} [summary]
     */
    complete(summary = {}) {
      if (summary.error) return stopped('Stopped at', summary.error);
      const titles = summary.titles ?? current?.total ?? 0;
      return enqueue({
        totalSteps: titles,
        currentStep: titles,
        status: 'completed',
        message: `${titles} ${unit}, ${summary.reprocessed ?? 0} reprocessed, ` +
          `${formatDuration(now() - startedAt)}`,
      });
    },

    /**
     * Records a scan that threw.
     * @param {Error} error
     */
    fail(error) {
      return stopped('Failed at', error);
    },
  };
}
