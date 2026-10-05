import { describe, it, expect } from '@jest/globals';
import {
  resolveClipCodec,
  resolveClipEncoderChoice,
  av1EncoderChoiceFromEnvironment,
  CLIP_CODEC_VALUES,
  CLIP_ENCODER_VALUES,
  DEFAULT_AV1_ENCODER_CHOICE,
} from '../../../utils/clipCodec.mjs';

describe('resolveClipCodec (?codec= on /videoClip)', () => {
  it('is H.264 for a request that does not name a codec, and for auto', () => {
    for (const param of [undefined, '', 'auto', 'AUTO', ' auto ']) {
      expect(resolveClipCodec(param)).toBe('h264');
    }
  });

  it('accepts h264 and av1 in any case', () => {
    for (const param of ['h264', 'H264', ' h264 ']) {
      expect(resolveClipCodec(param)).toBe('h264');
    }
    for (const param of ['av1', 'AV1', ' av1 ']) {
      expect(resolveClipCodec(param)).toBe('av1');
    }
  });

  it('rejects unknown values and repeated parameters instead of falling back', () => {
    for (const param of ['vp9', 'h265', 'hevc', 'libx264', 'libsvtav1', ['av1', 'av1'], 42, null]) {
      expect(resolveClipCodec(param)).toBeNull();
    }
  });

  it('advertises exactly what it accepts', () => {
    expect(CLIP_CODEC_VALUES).toEqual(['auto', 'h264', 'av1']);
  });
});

describe('resolveClipEncoderChoice (?encoder= on /videoClip)', () => {
  it('leaves the choice to the server when the URL does not say', () => {
    expect(resolveClipEncoderChoice(undefined)).toBeUndefined();
    expect(resolveClipEncoderChoice('')).toBeUndefined();
  });

  it('accepts software and gpu in any case', () => {
    expect(resolveClipEncoderChoice('software')).toBe('software');
    expect(resolveClipEncoderChoice('GPU')).toBe('gpu');
    expect(resolveClipEncoderChoice(' gpu ')).toBe('gpu');
  });

  it('rejects anything else, encoder names included', () => {
    for (const param of ['hardware', 'qsv', 'av1_qsv', 'libsvtav1', 'auto', 'true', '1', ['gpu', 'gpu'], 1, null]) {
      expect(resolveClipEncoderChoice(param)).toBeNull();
    }
  });

  it('advertises exactly what it accepts', () => {
    expect(CLIP_ENCODER_VALUES).toEqual(['software', 'gpu']);
  });
});

describe('av1EncoderChoiceFromEnvironment (VIDEO_CLIP_AV1_ENCODER)', () => {
  it('is software unless the variable says otherwise: the GPU is opt-in', () => {
    expect(DEFAULT_AV1_ENCODER_CHOICE).toBe('software');
    for (const value of [undefined, '', '   ']) {
      expect(av1EncoderChoiceFromEnvironment(value)).toEqual({ choice: 'software', invalid: false });
    }
  });

  it('reads gpu and software in any case', () => {
    expect(av1EncoderChoiceFromEnvironment('gpu')).toEqual({ choice: 'gpu', invalid: false });
    expect(av1EncoderChoiceFromEnvironment(' GPU ')).toEqual({ choice: 'gpu', invalid: false });
    expect(av1EncoderChoiceFromEnvironment('software')).toEqual({ choice: 'software', invalid: false });
  });

  it('falls back to software for a value it does not know, and says the value was bad', () => {
    for (const value of ['true', '1', 'qsv', 'hardware']) {
      expect(av1EncoderChoiceFromEnvironment(value)).toEqual({ choice: 'software', invalid: true });
    }
  });
});
