/**
 * HDR detection from MediaInfo Video tracks. Fixtures copy the fields MediaInfo
 * reported for real library files; the comment on each names the title it came
 * from. The mediainfo subprocess is mocked.
 */

import { describe, it, expect, jest } from '@jest/globals';

let mediainfoPayload = '';
jest.unstable_mockModule('../../utils/utils.mjs', () => ({
  execAsync: async () => ({ stdout: mediainfoPayload }),
}));

const { analyzeVideoTracks, extractMediaQuality, getMediaInfoCombined } = await import(
  '../../mediaInfo/mediaInfo.mjs'
);

const uhdPQ = (overrides = {}) => ({
  '@type': 'Video',
  Format: 'HEVC',
  CodecID: 'hev1',
  Width: '3840',
  Height: '2160',
  BitDepth: '10',
  ColorSpace: 'YUV',
  colour_primaries: 'BT.2020',
  transfer_characteristics: 'PQ',
  matrix_coefficients: 'BT.2020 non-constant',
  Format_Profile: 'Main 10',
  ...overrides,
});

const sdr = (overrides = {}) => ({
  '@type': 'Video',
  Format: 'HEVC',
  CodecID: 'hev1',
  Width: '1920',
  Height: '1080',
  BitDepth: '10',
  ColorSpace: 'YUV',
  colour_primaries: 'BT.709',
  transfer_characteristics: 'BT.709',
  ...overrides,
});

// MP4 cover art as MediaInfo lists it: a one-frame JPEG Video track.
const coverArt = (overrides = {}) => ({
  '@type': 'Video',
  Format: 'JPEG',
  CodecID: 'mp4v-6C',
  Width: '640',
  Height: '360',
  BitDepth: '8',
  ColorSpace: 'YUV',
  FrameCount: '1',
  Default: 'No',
  ...overrides,
});

const staticHdr10 = {
  HDR_Format: 'SMPTE ST 2086',
  HDR_Format_Compatibility: 'HDR10',
  MasteringDisplay_ColorPrimaries: 'BT.2020',
  MasteringDisplay_Luminance: 'min: 0.0001 cd/m2, max: 1000 cd/m2',
};

describe('PQ sources are HDR10', () => {
  it('labels PQ over BT.2020 HDR10 when MaxCLL is absent', () => {
    // Logan, Luca: static metadata present, no MaxCLL/MaxFALL.
    const q = analyzeVideoTracks([uhdPQ(staticHdr10), uhdPQ(staticHdr10)]);

    expect(q.format).toBe('HDR10');
    expect(q.isHDR).toBe(true);
    expect(q.viewingExperience.standardHDR).toBe(true);
  });

  it('labels PQ HDR10 with no HDR_Format or mastering data at all', () => {
    // The Twits: x265 WEBRip, PQ signalled only in the VUI.
    const q = analyzeVideoTracks([
      uhdPQ({
        Width: '1920',
        Height: '1080',
        Encoded_Library_Settings: 'wpp / no-hdr10 / no-hdr10-opt / no-dhdr10-opt',
      }),
    ]);

    expect(q.format).toBe('HDR10');
    expect(q.isHDR).toBe(true);
  });

  it('does not read an x265 no-hdr10-opt setting as SDR on a PQ source', () => {
    // Andor: "hdr10 / no-hdr10-opt" contains the substring "no-hdr".
    const q = analyzeVideoTracks([
      uhdPQ({ ...staticHdr10, Height: '1608', Encoded_Library_Settings: 'hdr10 / no-hdr10-opt' }),
    ]);

    expect(q.format).toBe('HDR10');
    expect(q.isHDR).toBe(true);
  });

  it('adds HDR10 to a Dolby Vision profile 8 source', () => {
    // Moon Knight: profile 8.1 carries an HDR10 base layer.
    const q = analyzeVideoTracks([
      uhdPQ({
        HDR_Format: 'Dolby Vision / SMPTE ST 2086',
        HDR_Format_Profile: 'dvhe.08 / ',
        HDR_Format_Compatibility: 'HDR10 / HDR10',
      }),
    ]);

    expect(q.format).toBe('Dolby Vision, HDR10');
    expect(q.viewingExperience.dolbyVision).toBe(true);
  });

  it('does not call a Dolby Vision profile 5 source HDR10', () => {
    // Stuart Fails to Save the Universe: MediaInfo reports PQ over BT.2020, but
    // the base layer is IPTPQc2, not HDR10.
    const q = analyzeVideoTracks([
      uhdPQ({ HDR_Format: 'Dolby Vision', HDR_Format_Profile: 'dvhe.05' }),
    ]);

    expect(q.format).toBe('Dolby Vision');
    expect(q.isHDR).toBe(true);
    expect(q.viewingExperience.standardHDR).toBe(false);
  });

  it('keeps a BT.2020 SDR source out of HDR', () => {
    // BT.2020 primaries with the SDR transfer curve: wide colour, not HDR.
    const q = analyzeVideoTracks([
      sdr({ colour_primaries: 'BT.2020', transfer_characteristics: 'BT.2020 (10-bit)' }),
    ]);

    expect(q.isHDR).toBe(false);
    expect(q.viewingExperience.highDynamicRange).toBe(false);
  });

  it('still labels a BT.709 10-bit source as 10-bit SDR', () => {
    const q = analyzeVideoTracks([sdr()]);

    expect(q.format).toBe('10-bit SDR (BT.709)');
    expect(q.isHDR).toBe(false);
  });
});

describe('HDR10+ is detected', () => {
  it('labels SMPTE ST 2094 App 4 on a PQ stream HDR10+', () => {
    // 28 Years Later: MediaInfo's name for ST 2094-40 is "App 4".
    const q = analyzeVideoTracks([
      uhdPQ({
        Width: '3832',
        Height: '1384',
        HDR_Format: 'SMPTE ST 2094 App 4',
        HDR_Format_Compatibility: 'HDR10+ Profile B',
        MaxCLL: '308',
      }),
    ]);

    expect(q.format).toBe('HDR10+');
    expect(q.isHDR).toBe(true);
    expect(q.viewingExperience.hdr10Plus).toBe(true);
    expect(q.viewingExperience.standardHDR).toBe(true);
  });

  it('labels App 4 HDR10+ when no compatibility is reported', () => {
    // Upload S01E09.
    const q = analyzeVideoTracks([uhdPQ({ HDR_Format: 'SMPTE ST 2094 App 4' })]);

    expect(q.format).toBe('HDR10+');
  });

  it('keeps Dolby Vision alongside HDR10+', () => {
    // Lanterns S01E07: both formats in one HDR_Format field. The old else-if
    // matched "SMPTE ST 2094" first and never saw the Dolby Vision.
    const q = analyzeVideoTracks([
      uhdPQ({
        Height: '1920',
        HDR_Format: 'Dolby Vision / SMPTE ST 2094 App 4',
        HDR_Format_Profile: 'dvhe.08 / ',
        HDR_Format_Compatibility: 'HDR10 / HDR10+ Profile B',
        MaxCLL: '298',
      }),
    ]);

    expect(q.format).toBe('Dolby Vision, HDR10+');
    expect(q.viewingExperience.dolbyVision).toBe(true);
    expect(q.viewingExperience.hdr10Plus).toBe(true);
  });

  it('does not call App 4 metadata on an HLG stream HDR10+ or HDR10', () => {
    // The Old Man S1, previously "HDR10, HLG".
    const q = analyzeVideoTracks([
      uhdPQ({ transfer_characteristics: 'HLG', HDR_Format: 'SMPTE ST 2094 App 4' }),
      coverArt({ Width: '1000', Height: '1500' }),
    ]);

    expect(q.format).toBe('HLG');
    expect(q.viewingExperience.hdr10Plus).toBe(false);
    expect(q.viewingExperience.standardHDR).toBe(true);
  });
});

describe('cover art does not describe the picture', () => {
  it('keeps the main track transfer and bit depth when a JPEG track follows', () => {
    // Flight Risk: two HEVC tracks, then a JPEG with no colour fields.
    const q = analyzeVideoTracks([
      uhdPQ({ ...staticHdr10, MaxCLL: '581', MaxFALL: '261' }),
      uhdPQ({ ...staticHdr10, MaxCLL: '581', MaxFALL: '261' }),
      coverArt(),
    ]);

    expect(q.transferCharacteristics).toBe('PQ');
    expect(q.bitDepth).toBe(10);
    expect(q.format).toBe('HDR10');
  });

  it('ignores the sRGB transfer a cover-art JPEG reports', () => {
    // The Cabin in the Woods: the JPEG claims BT.709 primaries and sRGB.
    const q = analyzeVideoTracks([
      uhdPQ(staticHdr10),
      coverArt({ colour_primaries: 'BT.709', transfer_characteristics: 'sRGB/sYCC' }),
    ]);

    expect(q.transferCharacteristics).toBe('PQ');
    expect(q.format).toBe('HDR10');
  });

  it('reports HLG for an HLG source with cover art', () => {
    // The Old Man: HLG, with a 1500-px JPEG poster track.
    const q = analyzeVideoTracks([
      uhdPQ({ transfer_characteristics: 'HLG' }),
      coverArt({ Width: '1000', Height: '1500' }),
    ]);

    expect(q.transferCharacteristics).toBe('HLG');
    expect(q.format).toContain('HLG');
    expect(q.isHDR).toBe(true);
  });

  it('keeps an SDR source 10-bit when cover art follows', () => {
    const q = analyzeVideoTracks([sdr(), coverArt()]);

    expect(q.format).toBe('10-bit SDR (BT.709)');
    expect(q.bitDepth).toBe(10);
    expect(q.transferCharacteristics).toBe('BT.709');
  });

  it('still analyses a file whose only video track is an image codec', () => {
    // Motion JPEG: the image codec IS the video.
    const q = analyzeVideoTracks([
      coverArt({ FrameCount: '43200', colour_primaries: 'BT.709', Default: 'Yes' }),
    ]);

    expect(q.bitDepth).toBe(8);
    expect(q.format).toBe('8-bit SDR (BT.709)');
  });
});

describe('both mediainfo entry points share the analysis', () => {
  const tracks = [
    { '@type': 'General', FileSize: '74617383000', Duration: '8243.316' },
    uhdPQ(staticHdr10),
    { '@type': 'Audio', Format: 'AAC' },
    coverArt(),
  ];

  it('getMediaInfoCombined returns the HDR10 label and the main track fields', async () => {
    mediainfoPayload = JSON.stringify({ media: { track: tracks } });

    const { mediaQuality, hdr, headerData } = await getMediaInfoCombined('/x/Logan.mp4');

    expect(hdr).toBe('HDR10');
    expect(mediaQuality).toEqual(analyzeVideoTracks(tracks.filter((t) => t['@type'] === 'Video')));
    expect(mediaQuality.transferCharacteristics).toBe('PQ');
    expect(headerData).toContain('HEVC');
  });

  it('extractMediaQuality agrees with getMediaInfoCombined', async () => {
    mediainfoPayload = JSON.stringify({ media: { track: tracks } });

    const combined = await getMediaInfoCombined('/x/Logan.mp4');
    const single = await extractMediaQuality('/x/Logan.mp4');

    expect(single).toEqual(combined.mediaQuality);
  });
});
