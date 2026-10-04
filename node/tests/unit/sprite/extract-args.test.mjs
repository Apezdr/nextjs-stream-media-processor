import { describe, it, expect } from '@jest/globals';
import { buildExtractArgs, buildFrameFilters } from '../../../sprite.mjs';

describe('buildExtractArgs', () => {
  it('input-seeks before -i so ffmpeg uses the container index instead of a linear read', () => {
    const args = buildExtractArgs('/v.mkv', 125, 'scale=320:-1', '/out.png', null, false, false);
    expect(args.indexOf('-ss')).toBeGreaterThan(-1);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('125.000');
    expect(args).toContain('-frames:v');
  });

  it('software decode adds no hwaccel flags', () => {
    const args = buildExtractArgs('/v.mkv', 5, 'scale=320:-1', '/out.png', null, false, false);
    expect(args).not.toContain('-hwaccel');
    expect(args).not.toContain('-hwaccel_output_format');
  });

  it('vaapi decode passes -hwaccel without forcing an output format (frames download automatically)', () => {
    const args = buildExtractArgs('/v.mkv', 5, 'scale=320:-1', '/out.png', 'vaapi', false, false);
    expect(args[args.indexOf('-hwaccel') + 1]).toBe('vaapi');
    expect(args).not.toContain('-hwaccel_output_format');
  });

  it('qsv decode downloads frames to system memory (bare -hwaccel qsv leaves them on the GPU)', () => {
    const args = buildExtractArgs('/v.mkv', 5, 'scale=320:-1', '/out.png', 'qsv', false, false);
    expect(args[args.indexOf('-hwaccel') + 1]).toBe('qsv');
    expect(args[args.indexOf('-hwaccel_output_format') + 1]).toBe('nv12');
  });

  it('qsv + HDR downloads as 10-bit so the tonemap chain keeps full depth', () => {
    const args = buildExtractArgs('/v.mkv', 5, 'zscale=...,scale=320:-1', '/out.png', 'qsv', false, true);
    expect(args[args.indexOf('-hwaccel_output_format') + 1]).toBe('p010le');
  });

  it('fast seek prepends -noaccurate_seek before the input seek', () => {
    const args = buildExtractArgs('/v.mkv', 5, 'scale=320:-1', '/out.png', null, true, false);
    expect(args.indexOf('-noaccurate_seek')).toBeGreaterThan(-1);
    expect(args.indexOf('-noaccurate_seek')).toBeLessThan(args.indexOf('-ss'));
  });
});

describe('Dolby Vision reshape (Profile 5)', () => {
  it('adds the Vulkan device before the input and forces software decode, even when hwaccel is set', () => {
    const args = buildExtractArgs('/v.mkv', 5, 'libplacebo=...', '/out.png', 'qsv', false, false, true);
    expect(args[args.indexOf('-init_hw_device') + 1]).toBe('vulkan');
    expect(args.indexOf('-init_hw_device')).toBeLessThan(args.indexOf('-i'));
    // hevc_qsv drops the RPU, so libplacebo would get nothing to apply.
    expect(args).not.toContain('-hwaccel');
    expect(args).not.toContain('-hwaccel_output_format');
  });

  it('leaves every other source untouched', () => {
    const args = buildExtractArgs('/v.mkv', 5, 'scale=320:-1', '/out.png', 'qsv', false, false);
    expect(args).not.toContain('-init_hw_device');
    expect(args[args.indexOf('-hwaccel') + 1]).toBe('qsv');
  });

  it('reshapes with libplacebo instead of either the SDR or the HDR chain', () => {
    const vf = buildFrameFilters(false, true);
    expect(vf.startsWith('libplacebo=w=320:h=-2:apply_dolbyvision=1:')).toBe(true);
    expect(vf).toContain('color_trc=bt709');
    expect(vf).not.toContain('zscale');
    // The HDR flag cannot pull a reshape source onto the forced-BT.2020 zscale chain.
    expect(buildFrameFilters(true, true)).toBe(vf);
  });

  it('keeps the existing chains for non-reshape sources', () => {
    expect(buildFrameFilters(false)).toBe('scale=320:-1');
    expect(buildFrameFilters(true)).toContain('zscale=transfer=smpte2084');
  });
});
