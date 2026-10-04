import { describe, it, expect } from '@jest/globals';
import { resolveClipCodec, CLIP_CODEC_ENCODERS, CLIP_CODEC_VALUES } from '../../../utils/clipCodec.mjs';
import * as encoders from '../../../ffmpeg/encoderConfig.mjs';

describe('resolveClipCodec (?codec= on /videoClip)', () => {
  it('keeps the hardware default when absent, empty or auto', () => {
    for (const param of [undefined, '', 'auto', 'AUTO', ' auto ']) {
      expect(resolveClipCodec(param)).toEqual({ ok: true, encoder: null });
    }
  });

  it('maps h264 to software libx264 (MP4 + AAC), case-insensitively', () => {
    for (const param of ['h264', 'H264', ' h264 ']) {
      expect(resolveClipCodec(param)).toEqual({ ok: true, encoder: 'libx264' });
    }
  });

  it('rejects unknown values and repeated parameters instead of falling back', () => {
    for (const param of ['av1', 'vp8', 'h265', 'libx264', ['h264', 'h264'], 42]) {
      expect(resolveClipCodec(param)).toEqual({ ok: false });
    }
  });

  it('advertises exactly what it accepts, and every encoder it names exists', () => {
    expect(CLIP_CODEC_VALUES).toEqual(['auto', 'h264']);
    for (const encoder of Object.values(CLIP_CODEC_ENCODERS)) {
      expect(encoders[encoder]).toBeDefined();
      expect(encoders[encoder].codec).toBe(encoder);
    }
  });
});
