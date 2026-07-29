import { describe, it, expect } from '@jest/globals';
import { buildExtractArgs } from '../../../sprite.mjs';

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
