/**
 * The session cache's memory-pressure test (lib/memoryPressure.mjs) is
 * measured against V8's heap limit. Against heapTotal it fired every few
 * minutes in prod at ~97 MB used (94% of a ~103 MB heapTotal, 2% of the
 * 4288 MB limit), emptying the session cache and switching it off each time.
 */

import { describe, it, expect } from '@jest/globals';
import { describeHeap, readHeap, underHeapPressure } from '../../../lib/memoryPressure.mjs';

const MB = 1024 ** 2;
const LIMIT = 4288 * MB;

describe('heap pressure', () => {
  it('is not pressure at the prod numbers that used to trip it', () => {
    expect(underHeapPressure({ heapUsed: 97.1 * MB, heapLimit: LIMIT }, false)).toBe(false);
    expect(underHeapPressure({ heapUsed: 510 * MB, heapLimit: LIMIT }, false)).toBe(false);
  });

  it('starts above 80% of the limit and ends only below 70%', () => {
    expect(underHeapPressure({ heapUsed: 0.79 * LIMIT, heapLimit: LIMIT }, false)).toBe(false);
    expect(underHeapPressure({ heapUsed: 0.81 * LIMIT, heapLimit: LIMIT }, false)).toBe(true);
    expect(underHeapPressure({ heapUsed: 0.75 * LIMIT, heapLimit: LIMIT }, true)).toBe(true);
    expect(underHeapPressure({ heapUsed: 0.69 * LIMIT, heapLimit: LIMIT }, true)).toBe(false);
  });

  it('reads this process\'s heap and says it plainly', () => {
    const heap = readHeap();
    expect(heap.heapLimit).toBeGreaterThan(heap.heapUsed);
    expect(describeHeap({ heapUsed: 3.4 * 1024 ** 3, heapLimit: 4.2 * 1024 ** 3 })).toBe('3.4 GB of a 4.2 GB heap limit (81%)');
  });
});
