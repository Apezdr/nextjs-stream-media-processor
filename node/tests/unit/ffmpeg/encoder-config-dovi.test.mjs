import { describe, it, expect } from '@jest/globals';
import { libx264, vp9_vaapi, hevc_vaapi, hevc_nvenc } from '../../../ffmpeg/encoderConfig.mjs';

const RESHAPE_1280 =
  'libplacebo=w=1280:h=-2:apply_dolbyvision=1:tonemapping=bt.2390:' +
  'colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p';

describe('dovi_vf (Dolby Vision Profile 5 clips)', () => {
  it('VAAPI encoders: libplacebo at the clip size, then the usual nv12 upload', () => {
    for (const enc of [vp9_vaapi, hevc_vaapi]) {
      expect(enc.dovi_vf({ width: 1280, height: -2 })).toBe(`${RESHAPE_1280},format=nv12,hwupload`);
    }
  });

  it('software and NVENC: libplacebo, then their 8-bit format and even-size padding', () => {
    const pad = 'pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2';
    expect(libx264.dovi_vf({ width: 1280, height: -2 })).toBe(`${RESHAPE_1280},format=yuv420p,${pad}`);
    expect(hevc_nvenc.dovi_vf({ width: 1280, height: -2 })).toBe(`${RESHAPE_1280},format=yuv420p,${pad}`);
  });

  it('replaces both the tone-map and the scale: no zscale or swscale pass of the raw base layer', () => {
    for (const enc of [libx264, vp9_vaapi, hevc_vaapi, hevc_nvenc]) {
      const vf = enc.dovi_vf({ width: 640, height: -2 });
      expect(vf.startsWith('libplacebo=w=640:h=-2:apply_dolbyvision=1:')).toBe(true);
      expect(vf).not.toMatch(/zscale|tonemap=|(^|,)scale=/);
    }
  });

  it('defaults to the same size vf uses when the profile has no scale', () => {
    expect(vp9_vaapi.dovi_vf(undefined)).toBe(`${RESHAPE_1280},format=nv12,hwupload`);
  });

  it('leaves vf and hdr_vf unchanged for every other source', () => {
    expect(vp9_vaapi.vf(false, 'yuv420p')).toBe('zscale=w=1280:h=-2,format=nv12,hwupload');
    expect(vp9_vaapi.hdr_vf(true, 'yuv420p10le')).toContain('tonemap=tonemap=hable');
  });
});
