import { describe, it, expect } from '@jest/globals';
import { planFrameTimestamps } from '../../../sprite.mjs';

describe('planFrameTimestamps', () => {
  it('produces one timestamp per interval from 0 through floor(duration)', () => {
    expect(planFrameTimestamps(61, 5)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]);
  });

  it('matches the frame count the sprite grid is sized for', () => {
    for (const duration of [0.4, 3.2, 42.7, 61, 300, 5400.04, 7213.5]) {
      const interval = 5;
      const totalFrames = Math.floor(Math.floor(duration) / interval) + 1;
      expect(planFrameTimestamps(duration, interval)).toHaveLength(totalFrames);
    }
  });

  it('pulls the last timestamp back when it would land at/past the end of the video', () => {
    // duration exactly on an interval boundary: seeking to 60.0 of a 60.0s file yields no frame
    const timestamps = planFrameTimestamps(60.0, 5);
    expect(timestamps[timestamps.length - 1]).toBeCloseTo(59.5);
    // all timestamps stay strictly inside the video
    for (const t of timestamps) {
      expect(t).toBeLessThan(60.0);
    }
  });

  it('keeps exact timestamps when the video extends past the last interval', () => {
    const timestamps = planFrameTimestamps(62.8, 5);
    expect(timestamps[timestamps.length - 1]).toBe(60);
  });

  it('never goes negative on very short videos', () => {
    expect(planFrameTimestamps(0.4, 5)).toEqual([0]);
  });

  it('timestamps are ascending', () => {
    const timestamps = planFrameTimestamps(7213.5, 5);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
  });
});
