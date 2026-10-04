import { describe, it, expect } from '@jest/globals';
import { doviReshapeRequired, doviReshapeFilter, DOVI_RESHAPE_INPUT_ARGS } from '../../../ffmpeg/dolbyVision.mjs';

const dovi = (colorTransfer, record) => ({
  color_transfer: colorTransfer,
  side_data_list: [{ side_data_type: 'DOVI configuration record', ...record }],
});

describe('doviReshapeRequired', () => {
  it('is true for Profile 5, whose base layer has no standard signal', () => {
    // The Chair Company S01E01 (HBO WEB-DL): compat 0, every color field unknown.
    expect(doviReshapeRequired(dovi('unknown', { dv_profile: 5, dv_bl_signal_compatibility_id: 0 }))).toBe(true);
    // compat 0 decides it even if a muxer stamped a PQ transfer on the stream.
    expect(doviReshapeRequired(dovi('smpte2084', { dv_profile: 5, dv_bl_signal_compatibility_id: 0 }))).toBe(true);
  });

  it('is false for base layers the ordinary filters read correctly', () => {
    for (const [trc, compat] of [['smpte2084', 1], ['smpte2084', 6], ['arib-std-b67', 4], ['bt709', 2]]) {
      expect(doviReshapeRequired(dovi(trc, { dv_profile: 8, dv_bl_signal_compatibility_id: compat }))).toBe(false);
    }
  });

  it('falls back on the transfer when the record has no compat id', () => {
    expect(doviReshapeRequired(dovi('unknown', { dv_profile: 5 }))).toBe(true);
    expect(doviReshapeRequired(dovi('smpte2084', { dv_profile: 8 }))).toBe(false);
  });

  it('is false for anything that is not Dolby Vision', () => {
    expect(doviReshapeRequired({ color_transfer: 'smpte2084' })).toBe(false);
    expect(doviReshapeRequired({ color_transfer: 'unknown', side_data_list: [] })).toBe(false);
    // A record without a profile is not treated as DV (matches the transcoder).
    expect(doviReshapeRequired(dovi('unknown', { dv_bl_signal_compatibility_id: 0 }))).toBe(false);
    expect(doviReshapeRequired(undefined)).toBe(false);
  });
});

describe('doviReshapeFilter', () => {
  it('applies the RPU and tone-maps to limited-range BT.709 for SDR output', () => {
    expect(doviReshapeFilter({ width: 320, height: -2, output: 'sdr' })).toBe(
      'libplacebo=w=320:h=-2:apply_dolbyvision=1:tonemapping=bt.2390:' +
      'colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p'
    );
  });

  it('writes 10-bit BT.2020 PQ for HDR output', () => {
    expect(doviReshapeFilter({ width: -2, height: 140, output: 'pq' })).toBe(
      'libplacebo=w=-2:h=140:apply_dolbyvision=1:tonemapping=bt.2390:' +
      'colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084:range=tv:format=yuv420p10le'
    );
  });

  it('runs on a Vulkan device', () => {
    expect([...DOVI_RESHAPE_INPUT_ARGS]).toEqual(['-init_hw_device', 'vulkan']);
  });
});
