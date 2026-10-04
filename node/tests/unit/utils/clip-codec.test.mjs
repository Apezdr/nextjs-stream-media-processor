import { describe, it, expect } from '@jest/globals';
import { isAcceptedClipCodec, CLIP_CODEC_VALUES } from '../../../utils/clipCodec.mjs';

describe('isAcceptedClipCodec (?codec= on /videoClip)', () => {
  it('accepts a request that does not name a codec', () => {
    for (const param of [undefined, '']) {
      expect(isAcceptedClipCodec(param)).toBe(true);
    }
  });

  it('accepts auto and h264 in any case: both name the one clip there is', () => {
    for (const param of ['auto', 'AUTO', ' auto ', 'h264', 'H264', ' h264 ']) {
      expect(isAcceptedClipCodec(param)).toBe(true);
    }
  });

  it('rejects unknown values and repeated parameters instead of falling back', () => {
    for (const param of ['av1', 'vp9', 'h265', 'libx264', ['h264', 'h264'], 42, null]) {
      expect(isAcceptedClipCodec(param)).toBe(false);
    }
  });

  it('advertises exactly what it accepts', () => {
    expect(CLIP_CODEC_VALUES).toEqual(['auto', 'h264']);
  });
});
