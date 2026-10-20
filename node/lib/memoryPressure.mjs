/**
 * Whether this process is short of heap, measured against V8's heap limit.
 *
 * The session cache used to compare heapUsed with heapTotal. heapTotal is
 * only the heap V8 has grown to so far, and V8 keeps it 80-95% full in a
 * healthy process, so "pressure" switched on every few minutes at ~100 MB of
 * a ~4 GB limit, and each time the cache was emptied and switched off.
 *
 * Pressure starts above PRESSURE_STARTS of the limit and ends below
 * PRESSURE_ENDS, so it doesn't flap at the line.
 */

import v8 from 'v8';

export const PRESSURE_STARTS = 0.8;
export const PRESSURE_ENDS = 0.7;

/** @param {{ heapUsed: number, heapLimit: number }} heap */
export function underHeapPressure({ heapUsed, heapLimit }, wasUnderPressure) {
  const share = heapUsed / heapLimit;
  return wasUnderPressure ? share >= PRESSURE_ENDS : share > PRESSURE_STARTS;
}

export function readHeap() {
  return { heapUsed: process.memoryUsage().heapUsed, heapLimit: v8.getHeapStatistics().heap_size_limit };
}

/** "3.4 GB of a 4.2 GB heap limit (81%)" */
export function describeHeap({ heapUsed, heapLimit }) {
  const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);
  return `${gb(heapUsed)} GB of a ${gb(heapLimit)} GB heap limit (${Math.round((heapUsed / heapLimit) * 100)}%)`;
}
