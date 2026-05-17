import { describe, it, expect } from '@jest/globals';
import { parseLatestSegmentEndSec } from '../../../lib/whisper.mjs';

describe('parseLatestSegmentEndSec', () => {
  it('returns null when no segments are present', () => {
    expect(parseLatestSegmentEndSec('starting transcription...')).toBeNull();
  });

  it('parses a single completed segment', () => {
    const buf = '[00:00:00.000 --> 00:00:05.250] Hello world';
    expect(parseLatestSegmentEndSec(buf)).toBeCloseTo(5.25, 3);
  });

  it('returns the LATEST segment end time when multiple are present', () => {
    const buf = [
      '[00:00:00.000 --> 00:00:05.000] Hello',
      '[00:00:05.000 --> 00:00:12.500] world',
      '[00:00:12.500 --> 00:00:30.000] more text'
    ].join('\n');
    expect(parseLatestSegmentEndSec(buf)).toBe(30);
  });

  it('handles hours correctly', () => {
    const buf = '[00:00:00.000 --> 01:23:45.678] long episode';
    // 1*3600 + 23*60 + 45 + 0.678 = 5025.678
    expect(parseLatestSegmentEndSec(buf)).toBeCloseTo(5025.678, 3);
  });

  it('ignores partial / malformed segment headers', () => {
    const buf = 'progress: 50%\n[--> 00:00:05.000] (malformed)\n[00:00:01.000 --> 00:00:02.000] real';
    expect(parseLatestSegmentEndSec(buf)).toBe(2);
  });
});
