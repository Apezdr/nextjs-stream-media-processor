/**
 * Which audio track a caption is transcribed from: one tagged with the
 * caption's language, or none. And the questions built on that: can this file
 * be captioned at all, and was a caption made before tracks were chosen made
 * from the right one.
 */

import { describe, it, expect } from '@jest/globals';
import {
  selectCaptionAudioTrack,
  hasCaptionAudioTrack,
  ffmpegDefaultAudioTrack,
  judgeUnmappedCaption,
  tracksFromScanMetadata,
  NoCaptionAudioError
} from '../../../components/caption-generator/domain/audio-track.mjs';

function track(index, overrides = {}) {
  return {
    index,
    codec: 'ac3',
    channels: 2,
    language: null,
    title: null,
    isDefault: false,
    commentary: false,
    described: false,
    ...overrides
  };
}

function refusal(tracks, langCode = 'en') {
  try {
    selectCaptionAudioTrack(tracks, langCode);
  } catch (err) {
    return err;
  }
  return null;
}

describe('selectCaptionAudioTrack', () => {
  it('takes the English track over a default foreign track with more channels', () => {
    const tracks = [
      track(1, { language: 'jpn', channels: 6, isDefault: true }),
      track(2, { language: 'eng', channels: 2 })
    ];
    expect(selectCaptionAudioTrack(tracks, 'en')).toBe(tracks[1]);
  });

  it.each(['eng', 'en', 'EN', 'en-US', 'en_GB', ' eng '])('reads the tag "%s" as English', (language) => {
    const tracks = [track(1, { language: 'fre' }), track(2, { language })];
    expect(selectCaptionAudioTrack(tracks, 'en').index).toBe(2);
  });

  it('matches a three-letter caption language against a two-letter tag', () => {
    const tracks = [track(1, { language: 'en' }), track(2, { language: 'es' })];
    expect(selectCaptionAudioTrack(tracks, 'spa').index).toBe(2);
  });

  it('among several English tracks takes the default one, else the first', () => {
    const withDefault = [
      track(1, { language: 'eng' }),
      track(2, { language: 'eng', isDefault: true })
    ];
    expect(selectCaptionAudioTrack(withDefault, 'en').index).toBe(2);

    const noDefault = [track(3, { language: 'eng' }), track(4, { language: 'eng' })];
    expect(selectCaptionAudioTrack(noDefault, 'en').index).toBe(3);
  });

  it('passes over an English commentary for the English feature track', () => {
    const tracks = [
      track(1, { language: 'eng', commentary: true, isDefault: true }),
      track(2, { language: 'eng', title: "Director's Commentary" }),
      track(3, { language: 'eng', described: true }),
      track(4, { language: 'eng', title: 'English Audio Description' }),
      track(5, { language: 'eng', title: 'Surround 5.1' })
    ];
    expect(selectCaptionAudioTrack(tracks, 'en').index).toBe(5);
  });

  it('does not caption a foreign film from its English commentary', () => {
    const tracks = [
      track(1, { language: 'fre', isDefault: true }),
      track(2, { language: 'eng', commentary: true })
    ];
    expect(refusal(tracks)).toBeInstanceOf(NoCaptionAudioError);
  });

  it('uses a commentary track only when the file has nothing else', () => {
    const tracks = [track(1, { language: 'eng', commentary: true })];
    expect(selectCaptionAudioTrack(tracks, 'en').index).toBe(1);
  });

  it('refuses when every track is tagged with another language, and names them', () => {
    const thrown = refusal([
      track(1, { language: 'jpn', isDefault: true }),
      track(2, { language: 'fre' }),
      track(3, { language: 'ja' })
    ]);
    expect(thrown).toBeInstanceOf(NoCaptionAudioError);
    expect(thrown.code).toBe('NO_AUDIO_FOR_LANGUAGE');
    expect(thrown.language).toBe('en');
    expect(thrown.audioLanguages).toEqual(['Japanese', 'French']);
    expect(thrown.untaggedTracks).toBe(0);
    expect(thrown.message).toBe('No English audio track to caption (audio: Japanese, French)');
  });

  // A track that does not say what language it is in is not an English track.
  it.each([[null], [undefined], [''], ['und'], ['UND']])(
    'refuses a file whose only track has the language tag %p',
    (language) => {
      const thrown = refusal([track(1, { language, isDefault: true })]);
      expect(thrown).toBeInstanceOf(NoCaptionAudioError);
      expect(thrown.audioLanguages).toEqual([]);
      expect(thrown.untaggedTracks).toBe(1);
      expect(thrown.message).toBe('No English audio track to caption (audio: untagged)');
    }
  );

  it('does not fall back to an untagged track beside a foreign one', () => {
    const thrown = refusal([
      track(1, { language: 'ita', isDefault: true }),
      track(2, { language: 'und' }),
      track(3)
    ]);
    expect(thrown.audioLanguages).toEqual(['Italian']);
    expect(thrown.untaggedTracks).toBe(2);
    expect(thrown.message).toBe('No English audio track to caption (audio: Italian, untagged)');
  });

  it('refuses a file with no audio at all', () => {
    for (const tracks of [[], null, undefined]) {
      const thrown = refusal(tracks);
      expect(thrown).toBeInstanceOf(NoCaptionAudioError);
      expect(thrown.audioLanguages).toEqual([]);
      expect(thrown.untaggedTracks).toBe(0);
      expect(thrown.message).toBe('No audio track to caption');
    }
  });
});

describe('hasCaptionAudioTrack', () => {
  it('is true exactly when a track would be selected', () => {
    expect(hasCaptionAudioTrack([track(1, { language: 'eng' })], 'en')).toBe(true);
    expect(hasCaptionAudioTrack([track(1, { language: 'jpn' }), track(2, { language: 'en' })], 'en')).toBe(true);
    expect(hasCaptionAudioTrack([track(1, { language: 'jpn' })], 'en')).toBe(false);
    expect(hasCaptionAudioTrack([track(1)], 'en')).toBe(false);
    expect(hasCaptionAudioTrack([track(1, { language: 'eng' })], 'es')).toBe(false);
  });

  it('is false when the tracks are not known', () => {
    expect(hasCaptionAudioTrack(null, 'en')).toBe(false);
    expect(hasCaptionAudioTrack(undefined, 'en')).toBe(false);
    expect(hasCaptionAudioTrack([], 'en')).toBe(false);
  });
});

describe('ffmpegDefaultAudioTrack', () => {
  it('is the default track, even with fewer channels', () => {
    const tracks = [track(1, { channels: 8 }), track(2, { channels: 2, isDefault: true })];
    expect(ffmpegDefaultAudioTrack(tracks)).toBe(tracks[1]);
  });

  it('is the track with the most channels when none is the default', () => {
    const tracks = [track(1, { channels: 2 }), track(2, { channels: 6 }), track(3, { channels: 6 })];
    expect(ffmpegDefaultAudioTrack(tracks)).toBe(tracks[1]);
  });

  it('is the default with the most channels when several are', () => {
    const tracks = [track(1, { channels: 2, isDefault: true }), track(2, { channels: 6, isDefault: true })];
    expect(ffmpegDefaultAudioTrack(tracks)).toBe(tracks[1]);
  });

  it('is null without tracks', () => {
    expect(ffmpegDefaultAudioTrack([])).toBeNull();
    expect(ffmpegDefaultAudioTrack(null)).toBeNull();
  });
});

describe('judgeUnmappedCaption', () => {
  it('is ok when ffmpeg picked an ordinary track in the language', () => {
    expect(judgeUnmappedCaption([track(1, { language: 'eng', isDefault: true })], 'en')).toBe('ok');
  });

  it('is ok when ffmpeg picked a different English track from the one chosen now', () => {
    // ffmpeg: the 5.1 (most channels). Chosen now: the first. Both are the film in English.
    const tracks = [track(1, { language: 'eng', channels: 2 }), track(2, { language: 'eng', channels: 6 })];
    expect(judgeUnmappedCaption(tracks, 'en')).toBe('ok');
  });

  it('is wrong-track when ffmpeg picked the default foreign dub of a film with English audio', () => {
    // Nosferatu as it sits in the library: English 7.1, English 5.1, Italian 5.1 default.
    const tracks = [
      track(1, { language: 'eng', channels: 8 }),
      track(2, { language: 'eng', channels: 6 }),
      track(3, { language: 'ita', channels: 6, isDefault: true })
    ];
    expect(judgeUnmappedCaption(tracks, 'en')).toBe('wrong-track');
  });

  it('is wrong-track when ffmpeg picked an untagged track and an English one exists', () => {
    const tracks = [track(1, { channels: 6, isDefault: true }), track(2, { language: 'eng' })];
    expect(judgeUnmappedCaption(tracks, 'en')).toBe('wrong-track');
  });

  it('is wrong-track when ffmpeg picked the English commentary', () => {
    const tracks = [
      track(1, { language: 'eng', commentary: true, isDefault: true }),
      track(2, { language: 'eng' })
    ];
    expect(judgeUnmappedCaption(tracks, 'en')).toBe('wrong-track');
  });

  it('is no-audio-in-language when nothing is tagged with the language', () => {
    expect(judgeUnmappedCaption([track(1, { language: 'ita', isDefault: true })], 'en')).toBe('no-audio-in-language');
    expect(judgeUnmappedCaption([track(1, { isDefault: true })], 'en')).toBe('no-audio-in-language');
    expect(judgeUnmappedCaption([], 'en')).toBe('no-audio-in-language');
    expect(judgeUnmappedCaption(null, 'en')).toBe('no-audio-in-language');
  });
});

describe('tracksFromScanMetadata', () => {
  const scanned = (overrides = {}) => ({
    codec: 'eac3',
    channels: 6,
    language: 'eng',
    languageTag: 'eng',
    title: null,
    disposition: { default: true, comment: false, visual_impaired: false, descriptions: false },
    ...overrides
  });

  it('reads the tracks the scanner recorded', () => {
    const tracks = tracksFromScanMetadata({
      audio: [
        scanned({ languageTag: 'ita', language: 'ita' }),
        scanned({ channels: 2, disposition: { default: false, comment: true } }),
        scanned({ languageTag: null, language: 'Stereo', title: 'Stereo', disposition: { default: false, descriptions: true } })
      ]
    });

    expect(tracks).toEqual([
      { index: 0, channels: 6, language: 'ita', title: null, isDefault: true, commentary: false, described: false },
      { index: 1, channels: 2, language: 'eng', title: null, isDefault: false, commentary: true, described: false },
      { index: 2, channels: 6, language: null, title: 'Stereo', isDefault: false, commentary: false, described: true }
    ]);
  });

  it('uses the strict language tag, never the display field that falls back to the title', () => {
    // infoManager's `language` is "English [DTS-HD MA 5.1]" for an untagged track with that title.
    const tracks = tracksFromScanMetadata({
      audio: [scanned({ language: 'English [DTS-HD MA 5.1]', languageTag: null, title: 'English [DTS-HD MA 5.1]' })]
    });
    expect(tracks[0].language).toBeNull();
    expect(hasCaptionAudioTrack(tracks, 'en')).toBe(false);
  });

  it('is null when the record does not say what the tracks are', () => {
    expect(tracksFromScanMetadata(undefined)).toBeNull();
    expect(tracksFromScanMetadata(null)).toBeNull();
    expect(tracksFromScanMetadata({})).toBeNull();
    expect(tracksFromScanMetadata({ audio: 'eac3' })).toBeNull();
  });

  it('is null for a record written before the language tag was recorded', () => {
    const { languageTag, ...old } = scanned();
    expect(tracksFromScanMetadata({ audio: [old] })).toBeNull();
    expect(tracksFromScanMetadata({ audio: [scanned(), old] })).toBeNull();
    expect(tracksFromScanMetadata({ audio: [null] })).toBeNull();
  });

  it('is an empty list for a video with no audio', () => {
    expect(tracksFromScanMetadata({ audio: [] })).toEqual([]);
  });
});
