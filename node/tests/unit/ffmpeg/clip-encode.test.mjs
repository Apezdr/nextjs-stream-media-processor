/**
 * The pure half of ffmpeg/clipEncode.mjs: reading a probe, choosing a filter
 * chain, and the exact ffmpeg command lines. These strings are what was run
 * against production titles, so a change here is a change in what every clip
 * is made of — bump VIDEO_CLIP_VERSION in videoHandler.mjs when one is meant.
 *
 * Running ffmpeg for real is tests/integration/video-clip-real-binary.test.mjs.
 */

import { describe, it, expect } from '@jest/globals';
import {
  describeClipSource,
  selectColorPipeline,
  buildClipVideoFilter,
  buildTranscodeArgs,
  buildOriginalArgs,
  canCopyOriginal,
  planOriginalCopy,
  resolveClipQuality,
  CLIP_QUALITIES,
  CLIP_QUALITY_VALUES,
  DEFAULT_CLIP_QUALITY,
  CLIP_ENCODERS,
} from '../../../ffmpeg/clipEncode.mjs';

const videoStream = (overrides = {}) => ({
  codec_type: 'video',
  codec_name: 'h264',
  pix_fmt: 'yuv420p',
  disposition: { attached_pic: 0 },
  ...overrides,
});
const audioStream = { codec_type: 'audio', codec_name: 'aac' };
const probe = (streams, format = { duration: '5400.000000', start_time: '0.000000' }) => ({ streams, format });

const SDR = describeClipSource(probe([videoStream(), audioStream]));
const HDR10 = describeClipSource(probe([
  videoStream({ codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc' }),
]));
const HLG = describeClipSource(probe([
  videoStream({ codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'arib-std-b67', color_primaries: 'bt2020', color_space: 'bt2020nc' }),
]));
const DOVI_P5 = describeClipSource(probe([
  videoStream({
    codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'unknown', color_space: 'unknown',
    side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: 5, dv_bl_signal_compatibility_id: 0 }],
  }),
]));

const FIT = "w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
const LIBPLACEBO =
  `libplacebo=${FIT}:apply_dolbyvision=1:tonemapping=bt.2390:` +
  'colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p';

describe('describeClipSource', () => {
  it('reads an ordinary SDR source', () => {
    expect(SDR).toEqual({
      codec: 'h264',
      pixFmt: 'yuv420p',
      transfer: 'sdr',
      assumedPq: false,
      wideGamut: false,
      dovi: false,
      duration: 5400,
      startTime: 0,
    });
  });

  it('recognises PQ and HLG by their transfer', () => {
    expect(HDR10).toMatchObject({ codec: 'hevc', pixFmt: 'yuv420p10le', transfer: 'pq', assumedPq: false });
    expect(HLG).toMatchObject({ transfer: 'hlg', assumedPq: false });
  });

  it('reads BT.2020 with no transfer tag as PQ, and says it assumed so', () => {
    for (const untagged of [undefined, 'unknown', 'unspecified']) {
      const source = describeClipSource(probe([videoStream({ color_space: 'bt2020nc', color_transfer: untagged })]));
      expect(source).toMatchObject({ transfer: 'pq', assumedPq: true, wideGamut: false });
    }
  });

  it('believes a transfer that is tagged: BT.2020 primaries with an SDR transfer is wide-gamut SDR', () => {
    const source = describeClipSource(probe([videoStream({ color_primaries: 'bt2020', color_transfer: 'bt709' })]));
    expect(source).toMatchObject({ transfer: 'sdr', assumedPq: false, wideGamut: true });
  });

  it('flags Dolby Vision that needs its RPU, which reads as SDR by its tags', () => {
    expect(DOVI_P5).toMatchObject({ transfer: 'sdr', assumedPq: false, dovi: true });
  });

  it('describes the stream -map 0:V:0 selects: cover art is skipped even when it comes first', () => {
    const source = describeClipSource(probe([
      videoStream({ codec_name: 'mjpeg', pix_fmt: 'yuvj444p', disposition: { attached_pic: 1 } }),
      videoStream({ codec_name: 'hevc', pix_fmt: 'yuv420p10le' }),
      audioStream,
    ]));
    expect(source).toMatchObject({ codec: 'hevc', pixFmt: 'yuv420p10le' });
  });

  it('returns null when there is no video to clip', () => {
    expect(describeClipSource(probe([audioStream]))).toBeNull();
    expect(describeClipSource(probe([videoStream({ disposition: { attached_pic: 1 } })]))).toBeNull();
    expect(describeClipSource({})).toBeNull();
  });

  it('keeps the container start time, and has no duration rather than a made-up one', () => {
    expect(describeClipSource(probe([videoStream()], { duration: '12.001000', start_time: '-0.006000' })))
      .toMatchObject({ duration: 12.001, startTime: -0.006 });
    expect(describeClipSource(probe([videoStream()], {}))).toMatchObject({ duration: null, startTime: 0 });
    expect(describeClipSource(probe([videoStream()], { duration: 'N/A' }))).toMatchObject({ duration: null });
  });
});

describe('selectColorPipeline', () => {
  it('leaves an SDR source alone, with or without libplacebo', () => {
    expect(selectColorPipeline(SDR, { libplacebo: true })).toBe('none');
    expect(selectColorPipeline(SDR, { libplacebo: false })).toBe('none');
  });

  it('sends every kind of HDR through libplacebo when the host has it', () => {
    const wideGamut = describeClipSource(probe([videoStream({ color_primaries: 'bt2020', color_transfer: 'bt709' })]));
    for (const source of [HDR10, HLG, DOVI_P5, wideGamut]) {
      expect(selectColorPipeline(source, { libplacebo: true })).toBe('libplacebo');
    }
  });

  it('falls back to the CPU tone-map for PQ and HLG without it', () => {
    expect(selectColorPipeline(HDR10, { libplacebo: false })).toBe('zscale');
    expect(selectColorPipeline(HLG, { libplacebo: false })).toBe('zscale');
  });

  it('has nothing that can apply an RPU without it, so Profile 5 is only scaled', () => {
    expect(selectColorPipeline(DOVI_P5, { libplacebo: false })).toBe('none');
  });
});

describe('buildClipVideoFilter', () => {
  it('fits an SDR source inside 1280x720, never enlarging it, as 8-bit 4:2:0', () => {
    expect(buildClipVideoFilter(SDR, 'none')).toBe(`scale=${FIT},format=yuv420p`);
  });

  it('tone-maps and scales in one libplacebo pass', () => {
    expect(buildClipVideoFilter(HDR10, 'libplacebo')).toBe(LIBPLACEBO);
    expect(buildClipVideoFilter(DOVI_P5, 'libplacebo')).toBe(LIBPLACEBO);
  });

  it('tells libplacebo what an untagged BT.2020 source is', () => {
    const untagged = describeClipSource(probe([videoStream({ color_space: 'bt2020nc' })]));
    expect(buildClipVideoFilter(untagged, 'libplacebo')).toBe(
      `setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,${LIBPLACEBO}`
    );
  });

  it('builds the CPU tone-map: tags first, then scale, then the float chain', () => {
    expect(buildClipVideoFilter(HDR10, 'zscale')).toBe(
      'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,' +
      `scale=${FIT},` +
      'zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,' +
      'format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0:peak=100,' +
      'zscale=t=bt709:m=bt709:r=tv,format=yuv420p'
    );
  });

  it('reads an HLG source as HLG in the CPU tone-map', () => {
    const filter = buildClipVideoFilter(HLG, 'zscale');
    expect(filter).toContain('setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc,');
    expect(filter).toContain('zscale=tin=arib-std-b67:');
    expect(filter).not.toContain('smpte2084');
  });
});

describe('quality levels (?quality=)', () => {
  it('offers high, medium and low, and gives high to a request that does not say', () => {
    expect(CLIP_QUALITY_VALUES).toEqual(['high', 'medium', 'low']);
    expect(DEFAULT_CLIP_QUALITY).toBe('high');
    for (const param of [undefined, '']) {
      expect(resolveClipQuality(param)).toBe('high');
    }
  });

  it('accepts a level in any case', () => {
    expect(resolveClipQuality('low')).toBe('low');
    expect(resolveClipQuality('MEDIUM')).toBe('medium');
    expect(resolveClipQuality(' High ')).toBe('high');
  });

  it('rejects anything else instead of falling back to a level nobody asked for', () => {
    for (const param of ['best', 'ultra', '720p', '28', 'toString', '__proto__', ['low', 'low'], 3, null]) {
      expect(resolveClipQuality(param)).toBeNull();
    }
  });

  it('gets smaller from high to low, in picture, bitrate ceiling and audio', () => {
    const bits = (value) => (value.endsWith('M') ? parseFloat(value) * 1000 : parseFloat(value));
    const { high, medium, low } = CLIP_QUALITIES;

    expect(medium.libx264.crf).toBeGreaterThan(high.libx264.crf);
    expect(low.libx264.crf).toBeGreaterThan(medium.libx264.crf);
    expect(bits(medium.libx264.maxrate)).toBeLessThan(bits(high.libx264.maxrate));
    expect(bits(low.libx264.maxrate)).toBeLessThan(bits(medium.libx264.maxrate));
    expect(bits(low.audioBitrate)).toBeLessThan(bits(high.audioBitrate));
    expect(low.width * low.height).toBeLessThan(high.width * high.height);
    // The ceiling is a VBV limit: it needs its buffer.
    for (const level of [high, medium, low]) {
      expect(bits(level.libx264.bufsize)).toBe(bits(level.libx264.maxrate) * 2);
      expect(level.width % 2).toBe(0);
      expect(level.height % 2).toBe(0);
    }
  });

  it('has settings for every encoder at every level, falling the same way', () => {
    const { high, medium, low } = CLIP_QUALITIES;
    for (const encoder of Object.keys(CLIP_ENCODERS)) {
      for (const level of [high, medium, low]) {
        expect(level[encoder]).toBeDefined();
      }
    }

    // A higher number is a lower quality target for all three encoders.
    expect(medium.libsvtav1.crf).toBeGreaterThan(high.libsvtav1.crf);
    expect(low.libsvtav1.crf).toBeGreaterThan(medium.libsvtav1.crf);
    expect(medium.libsvtav1.maxKbps).toBeLessThan(high.libsvtav1.maxKbps);
    expect(low.libsvtav1.maxKbps).toBeLessThan(medium.libsvtav1.maxKbps);
    expect(medium.av1_qsv.quality).toBeGreaterThan(high.av1_qsv.quality);
    expect(low.av1_qsv.quality).toBeGreaterThan(medium.av1_qsv.quality);

    // The two capped encoders share their ceilings, so a level means one size limit.
    for (const level of [high, medium, low]) {
      const x264Ceiling = level.libx264.maxrate.endsWith('M')
        ? parseFloat(level.libx264.maxrate) * 1000
        : parseFloat(level.libx264.maxrate);
      expect(level.libsvtav1.maxKbps).toBe(x264Ceiling);
    }
  });

  it('encodes medium inside the same 720p box at a lower target', () => {
    const args = buildTranscodeArgs({
      videoPath: '/media/a.mkv', start: 0, duration: 10, source: SDR, pipeline: 'none', quality: 'medium', outputPath: '/cache/x.part',
    });
    expect(args[args.indexOf('-vf') + 1]).toBe(`scale=${FIT},format=yuv420p`);
    expect(args.join(' ')).toContain('-crf 28 -maxrate 1200k -bufsize 2400k');
    expect(args.join(' ')).toContain('-c:a aac -b:a 96k');
  });

  it('encodes low inside 854x480, for SDR and for both tone-maps', () => {
    const lowFit = "w='min(854,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
    const args = buildTranscodeArgs({
      videoPath: '/media/a.mkv', start: 0, duration: 10, source: SDR, pipeline: 'none', quality: 'low', outputPath: '/cache/x.part',
    });
    expect(args[args.indexOf('-vf') + 1]).toBe(`scale=${lowFit},format=yuv420p`);
    expect(args.join(' ')).toContain('-crf 30 -maxrate 600k -bufsize 1200k');
    expect(args.join(' ')).toContain('-c:a aac -b:a 64k');

    expect(buildClipVideoFilter(HDR10, 'libplacebo', 'low')).toContain(`libplacebo=${lowFit}:apply_dolbyvision=1`);
    expect(buildClipVideoFilter(HDR10, 'zscale', 'low')).toContain(`,scale=${lowFit},zscale=`);
  });

  it('is the default level when a builder is not told', () => {
    const base = { videoPath: '/media/a.mkv', start: 0, duration: 10, source: SDR, pipeline: 'none', outputPath: '/cache/x.part' };
    expect(buildTranscodeArgs(base)).toEqual(buildTranscodeArgs({ ...base, quality: 'high' }));
    expect(buildClipVideoFilter(HDR10, 'libplacebo')).toBe(buildClipVideoFilter(HDR10, 'libplacebo', 'high'));
  });
});

describe('AV1 (?codec=av1)', () => {
  const base = { videoPath: '/media/movies/A Film/A Film.mkv', start: 3200, duration: 50, outputPath: '/cache/x.part' };

  it('names the codec each encoder makes', () => {
    expect(CLIP_ENCODERS.libx264.codec).toBe('h264');
    expect(CLIP_ENCODERS.libsvtav1.codec).toBe('av1');
    expect(CLIP_ENCODERS.av1_qsv.codec).toBe('av1');
  });

  it('encodes with SVT-AV1 in software: same pass, same streams, same container', () => {
    expect(buildTranscodeArgs({ ...base, source: SDR, pipeline: 'none', encoder: 'libsvtav1' })).toEqual([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', '3200',
      '-i', '/media/movies/A Film/A Film.mkv',
      '-t', '50',
      '-map', '0:V:0', '-map', '0:a:0?', '-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1',
      '-vf', `scale=${FIT},format=yuv420p`,
      '-c:v', 'libsvtav1', '-preset', '10', '-crf', '30', '-svtav1-params', 'mbr=2000',
      '-pix_fmt', 'yuv420p', '-g', '48',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
      '-max_muxing_queue_size', '9999', '-movflags', '+faststart', '-f', 'mp4',
      '/cache/x.part',
    ]);
  });

  it('follows the quality levels: a higher crf, a lower ceiling, a smaller box', () => {
    const medium = buildTranscodeArgs({ ...base, source: SDR, pipeline: 'none', encoder: 'libsvtav1', quality: 'medium' });
    expect(medium.join(' ')).toContain('-crf 44 -svtav1-params mbr=1200');
    expect(medium.join(' ')).toContain('-b:a 96k');

    const low = buildTranscodeArgs({ ...base, source: SDR, pipeline: 'none', encoder: 'libsvtav1', quality: 'low' });
    expect(low.join(' ')).toContain('-crf 52 -svtav1-params mbr=600');
    expect(low[low.indexOf('-vf') + 1]).toContain("w='min(854,iw)':h='min(480,ih)'");
  });

  it('encodes on an Intel GPU with a quality level only, fed NV12', () => {
    const args = buildTranscodeArgs({ ...base, source: SDR, pipeline: 'none', encoder: 'av1_qsv' });
    expect(args[args.indexOf('-vf') + 1]).toBe(`scale=${FIT},format=nv12`);
    expect(args.slice(args.indexOf('-c:v'), args.indexOf('-c:a'))).toEqual([
      '-c:v', 'av1_qsv', '-global_quality', '26', '-g', '48',
    ]);
    // No bitrate: with one, Quick Sync leaves its quality mode (see clipEncode.mjs).
    expect(args).not.toContain('-b:v');
    expect(args).not.toContain('-maxrate');
    // And no software pixel format forced on a hardware encoder.
    expect(args).not.toContain('-pix_fmt');

    expect(buildTranscodeArgs({ ...base, source: SDR, pipeline: 'none', encoder: 'av1_qsv', quality: 'medium' }).join(' '))
      .toContain('-global_quality 31');
    expect(buildTranscodeArgs({ ...base, source: SDR, pipeline: 'none', encoder: 'av1_qsv', quality: 'low' }).join(' '))
      .toContain('-global_quality 33');
  });

  it('tone-maps HDR for the GPU encoder exactly as for the others, then repacks to NV12', () => {
    expect(buildClipVideoFilter(HDR10, 'libplacebo', 'high', 'av1_qsv')).toBe(`${LIBPLACEBO},format=nv12`);
    expect(buildClipVideoFilter(HDR10, 'libplacebo', 'high', 'libsvtav1')).toBe(LIBPLACEBO);

    const cpu = buildClipVideoFilter(HDR10, 'zscale', 'high', 'av1_qsv');
    expect(cpu).toContain('tonemap=tonemap=hable');
    expect(cpu.endsWith(',zscale=t=bt709:m=bt709:r=tv,format=nv12')).toBe(true);

    const args = buildTranscodeArgs({ ...base, source: HDR10, pipeline: 'libplacebo', encoder: 'av1_qsv' });
    expect(args.slice(args.indexOf('-init_hw_device'), args.indexOf('-init_hw_device') + 2)).toEqual(['-init_hw_device', 'vulkan']);
    expect(args.join(' ')).toContain('-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv');
  });

  it('is H.264 when a builder is not told which encoder', () => {
    const untold = buildTranscodeArgs({ ...base, source: SDR, pipeline: 'none' });
    expect(untold).toEqual(buildTranscodeArgs({ ...base, source: SDR, pipeline: 'none', encoder: 'libx264' }));
    expect(untold).toContain('libx264');
  });
});

describe('buildTranscodeArgs', () => {
  const base = { videoPath: '/media/movies/A Film/A Film.mkv', start: 3200, duration: 50, outputPath: '/cache/x.part' };

  it('is one pass: seek before the input, H.264 + AAC, faststart MP4', () => {
    expect(buildTranscodeArgs({ ...base, source: SDR, pipeline: 'none' })).toEqual([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', '3200',
      '-i', '/media/movies/A Film/A Film.mkv',
      '-t', '50',
      '-map', '0:V:0', '-map', '0:a:0?', '-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1',
      '-vf', `scale=${FIT},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-x264-params', 'subme=1',
      '-crf', '23', '-maxrate', '2M', '-bufsize', '4M',
      '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '48',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
      '-max_muxing_queue_size', '9999', '-movflags', '+faststart', '-f', 'mp4',
      '/cache/x.part',
    ]);
  });

  it('gives libplacebo its Vulkan device, and tags the tone-mapped result BT.709', () => {
    const args = buildTranscodeArgs({ ...base, source: HDR10, pipeline: 'libplacebo' });
    // The device has to be created before the input it filters.
    expect(args.indexOf('-init_hw_device')).toBeLessThan(args.indexOf('-i'));
    expect(args.slice(args.indexOf('-init_hw_device'), args.indexOf('-init_hw_device') + 2)).toEqual(['-init_hw_device', 'vulkan']);
    expect(args[args.indexOf('-vf') + 1]).toBe(LIBPLACEBO);
    expect(args.join(' ')).toContain('-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv');
  });

  it('tags the CPU tone-map BT.709 too, without asking for a Vulkan device', () => {
    const args = buildTranscodeArgs({ ...base, source: HDR10, pipeline: 'zscale' });
    expect(args).not.toContain('-init_hw_device');
    expect(args.join(' ')).toContain('-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv');
  });

  it('does not stamp BT.709 on an SDR source, whose own tags may say BT.601', () => {
    const args = buildTranscodeArgs({ ...base, source: SDR, pipeline: 'none' });
    expect(args).not.toContain('-colorspace');
    expect(args).not.toContain('-color_trc');
  });

  it('writes fractional times without float noise', () => {
    const args = buildTranscodeArgs({ ...base, start: 0.1 + 0.2, duration: 12.5, source: SDR, pipeline: 'none' });
    expect(args[args.indexOf('-ss') + 1]).toBe('0.3');
    expect(args[args.indexOf('-t') + 1]).toBe('12.5');
  });
});

describe('canCopyOriginal', () => {
  const source = (codec, pixFmt, extra = {}) => ({ ...SDR, codec, pixFmt, ...extra });

  it('copies 8-bit H.264 and 8/10-bit HEVC, which a TV or phone decodes in hardware', () => {
    expect(canCopyOriginal(source('h264', 'yuv420p'))).toBe(true);
    expect(canCopyOriginal(source('hevc', 'yuv420p'))).toBe(true);
    expect(canCopyOriginal(source('hevc', 'yuv420p10le'))).toBe(true);
    expect(canCopyOriginal(HDR10)).toBe(true);
  });

  it('transcodes everything else', () => {
    expect(canCopyOriginal(source('h264', 'yuv420p10le'))).toBe(false); // Hi10P
    expect(canCopyOriginal(source('hevc', 'yuv422p10le'))).toBe(false);
    expect(canCopyOriginal(source('av1', 'yuv420p10le'))).toBe(false);
    expect(canCopyOriginal(source('vp9', 'yuv420p'))).toBe(false);
    expect(canCopyOriginal(source('mpeg2video', 'yuv420p'))).toBe(false);
  });

  it('transcodes Dolby Vision that needs its RPU: a copy is green on any non-DV screen', () => {
    expect(canCopyOriginal(DOVI_P5)).toBe(false);
  });
});

describe('planOriginalCopy', () => {
  it('seeks a quarter second past the keyframe and runs to the requested end', () => {
    // Mutiny on production: keyframe at 3199.196 for a 3200-3250 clip.
    const plan = planOriginalCopy({ start: 3200, duration: 50, startTime: 0, keyframeTime: 3199.196 });
    expect(plan.seekTo).toBeCloseTo(3199.446, 6);
    expect(plan.seekTo + plan.length).toBeCloseTo(3250, 6);
  });

  it('works on the container timeline when the file does not start at zero', () => {
    // start=3 in a file whose timestamps begin at 4.977: the request is for t=7.977.
    const plan = planOriginalCopy({ start: 3, duration: 4, startTime: 4.977, keyframeTime: 7 });
    expect(plan.seekTo).toBeCloseTo(7.25, 6);
    expect(plan.seekTo + plan.length).toBeCloseTo(11.977, 6);
  });

  it('accepts a first keyframe that sits a moment after the start of the file', () => {
    const plan = planOriginalCopy({ start: 0, duration: 10, startTime: 0, keyframeTime: 0.083 });
    expect(plan.seekTo).toBeCloseTo(0.333, 6);
    expect(plan.seekTo + plan.length).toBeCloseTo(10, 6);
  });

  it('refuses when there is no keyframe, or none near the start', () => {
    expect(planOriginalCopy({ start: 100, duration: 50, startTime: 0, keyframeTime: null })).toBeNull();
    expect(planOriginalCopy({ start: 100, duration: 50, startTime: 0, keyframeTime: NaN })).toBeNull();
    expect(planOriginalCopy({ start: 100, duration: 50, startTime: 0, keyframeTime: 69.9 })).toBeNull(); // 30.1 s GOP
    expect(planOriginalCopy({ start: 100, duration: 50, startTime: 0, keyframeTime: 101.5 })).toBeNull(); // after the start
  });

  it('refuses a clip that would end before the copy could begin', () => {
    expect(planOriginalCopy({ start: 10, duration: 0.1, startTime: 0, keyframeTime: 10 })).toBeNull();
  });
});

describe('buildOriginalArgs', () => {
  const plan = { seekTo: 3199.446, length: 50.554 };
  const base = { videoPath: '/media/movies/A Film/A Film.mkv', plan, outputPath: '/cache/x.part' };

  it('copies HEVC as hvc1 with AAC stereo, from the keyframe, into faststart MP4', () => {
    expect(buildOriginalArgs({ ...base, source: HDR10 })).toEqual([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-seek_timestamp', '1',
      '-noaccurate_seek',
      '-ss', '3199.446',
      '-t', '50.554',
      '-i', '/media/movies/A Film/A Film.mkv',
      '-map', '0:V:0', '-map', '0:a:0?', '-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1',
      '-c:v', 'copy', '-tag:v', 'hvc1',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
      '-avoid_negative_ts', 'make_zero',
      '-max_muxing_queue_size', '9999', '-movflags', '+faststart', '-f', 'mp4',
      '/cache/x.part',
    ]);
  });

  it('leaves the tag alone for H.264', () => {
    const args = buildOriginalArgs({ ...base, source: SDR });
    expect(args).not.toContain('-tag:v');
    expect(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 2)).toEqual(['-c:v', 'copy']);
  });

  it('limits the input, not the output: -t comes before -i', () => {
    const args = buildOriginalArgs({ ...base, source: SDR });
    expect(args.indexOf('-t')).toBeLessThan(args.indexOf('-i'));
  });
});

describe('the audio track', () => {
  const transcode = {
    videoPath: '/media/movies/A Film/A Film.mkv', start: 3200, duration: 50, outputPath: '/cache/x.part',
    source: SDR, pipeline: 'none',
  };
  const copy = {
    videoPath: '/media/movies/A Film/A Film.mkv', plan: { seekTo: 3199.446, length: 50.554 }, outputPath: '/cache/x.part',
    source: SDR,
  };
  const maps = (args) => args.flatMap((arg, position) => (arg === '-map' ? [args[position + 1]] : []));

  it('is the first when the caller names none', () => {
    expect(maps(buildTranscodeArgs(transcode))).toEqual(['0:V:0', '0:a:0?']);
    expect(maps(buildOriginalArgs(copy))).toEqual(['0:V:0', '0:a:0?']);
  });

  it('is the one the caller names, by its position among the audio streams', () => {
    expect(maps(buildTranscodeArgs({ ...transcode, audioTrack: 2 }))).toEqual(['0:V:0', '0:a:2?']);
    expect(maps(buildOriginalArgs({ ...copy, audioTrack: 2 }))).toEqual(['0:V:0', '0:a:2?']);
    expect(maps(buildTranscodeArgs({ ...transcode, audioTrack: 1, encoder: 'libsvtav1' }))).toEqual(['0:V:0', '0:a:1?']);
  });

  it('is still one audio stream and nothing else', () => {
    const args = buildTranscodeArgs({ ...transcode, audioTrack: 3 });
    expect(args.filter((arg) => arg === '-map')).toHaveLength(2);
    expect(args).toEqual(expect.arrayContaining(['-sn', '-dn', '-map_chapters', '-map_metadata']));
  });

  it.each([[-1], [1.5], ['1'], [null], [NaN]])('refuses %p, which is not a position', (audioTrack) => {
    expect(() => buildTranscodeArgs({ ...transcode, audioTrack })).toThrow(/audio track/);
    expect(() => buildOriginalArgs({ ...copy, audioTrack })).toThrow(/audio track/);
  });
});
