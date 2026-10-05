/**
 * Which audio track a caption is transcribed from: the one tagged with the
 * caption's language, else an untagged one, else none.
 */

import { describe, it, expect } from '@jest/globals';
import {
  selectCaptionAudioTrack,
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

describe('selectCaptionAudioTrack', () => {
  it('takes the English track over a default foreign track with more channels', () => {
    const tracks = [
      track(1, { language: 'jpn', channels: 6, isDefault: true }),
      track(2, { language: 'eng', channels: 2 })
    ];
    expect(selectCaptionAudioTrack(tracks, 'en')).toEqual({ track: tracks[1], matchedLanguage: true });
  });

  it.each(['eng', 'en', 'EN', 'en-US', 'en_GB', ' eng '])('reads the tag "%s" as English', (language) => {
    const tracks = [track(1, { language: 'fre' }), track(2, { language })];
    expect(selectCaptionAudioTrack(tracks, 'en').track.index).toBe(2);
  });

  it('matches a three-letter caption language against a two-letter tag', () => {
    const tracks = [track(1, { language: 'en' }), track(2, { language: 'es' })];
    expect(selectCaptionAudioTrack(tracks, 'spa').track.index).toBe(2);
  });

  it('among several English tracks takes the default one, else the first', () => {
    const withDefault = [
      track(1, { language: 'eng' }),
      track(2, { language: 'eng', isDefault: true })
    ];
    expect(selectCaptionAudioTrack(withDefault, 'en').track.index).toBe(2);

    const noDefault = [track(3, { language: 'eng' }), track(4, { language: 'eng' })];
    expect(selectCaptionAudioTrack(noDefault, 'en').track.index).toBe(3);
  });

  it('passes over an English commentary for the English feature track', () => {
    const tracks = [
      track(1, { language: 'eng', commentary: true, isDefault: true }),
      track(2, { language: 'eng', title: "Director's Commentary" }),
      track(3, { language: 'eng', described: true }),
      track(4, { language: 'eng', title: 'English Audio Description' }),
      track(5, { language: 'eng', title: 'Surround 5.1' })
    ];
    expect(selectCaptionAudioTrack(tracks, 'en').track.index).toBe(5);
  });

  it('does not caption a foreign film from its English commentary', () => {
    const tracks = [
      track(1, { language: 'fre', isDefault: true }),
      track(2, { language: 'eng', commentary: true })
    ];
    expect(() => selectCaptionAudioTrack(tracks, 'en')).toThrow(NoCaptionAudioError);
  });

  it('uses a commentary track only when the file has nothing else', () => {
    const tracks = [track(1, { language: 'eng', commentary: true })];
    expect(selectCaptionAudioTrack(tracks, 'en').track.index).toBe(1);
  });

  it('falls back to an untagged track when none is tagged English', () => {
    const tracks = [
      track(1, { language: 'jpn', isDefault: true }),
      track(2, { language: 'und' }),
      track(3)
    ];
    expect(selectCaptionAudioTrack(tracks, 'en')).toEqual({ track: tracks[1], matchedLanguage: false });
  });

  it('in a file with no language tags takes the default track, else the first', () => {
    const withDefault = [track(1), track(2, { isDefault: true })];
    expect(selectCaptionAudioTrack(withDefault, 'en').track.index).toBe(2);

    const noDefault = [track(1, { language: '' }), track(2, { language: 'und' })];
    expect(selectCaptionAudioTrack(noDefault, 'en').track.index).toBe(1);
  });

  it('refuses when every track is tagged with another language, and names them', () => {
    const tracks = [
      track(1, { language: 'jpn', isDefault: true }),
      track(2, { language: 'fre' }),
      track(3, { language: 'ja' })
    ];
    let thrown;
    try {
      selectCaptionAudioTrack(tracks, 'en');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NoCaptionAudioError);
    expect(thrown.code).toBe('NO_AUDIO_FOR_LANGUAGE');
    expect(thrown.language).toBe('en');
    expect(thrown.audioLanguages).toEqual(['Japanese', 'French']);
    expect(thrown.message).toBe('No English audio track to caption (audio: Japanese, French)');
  });

  it('refuses a file with no audio at all', () => {
    for (const tracks of [[], null, undefined]) {
      let thrown;
      try {
        selectCaptionAudioTrack(tracks, 'en');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(NoCaptionAudioError);
      expect(thrown.audioLanguages).toEqual([]);
      expect(thrown.message).toBe('No audio track to caption');
    }
  });
});
