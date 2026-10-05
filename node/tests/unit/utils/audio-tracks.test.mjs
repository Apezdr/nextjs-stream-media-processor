/**
 * Reading a video's audio tracks: the track in a language, and the
 * deployment's preferred language (PREFERRED_AUDIO_LANGUAGE).
 *
 * The caption generator's use of these is covered in
 * tests/unit/caption-generator/audio-track.test.mjs.
 */

import { describe, it, expect } from '@jest/globals';
import {
  taggedLanguage,
  comparableLanguage,
  ordinaryTracks,
  trackInLanguage,
  preferredAudioLanguageFromEnvironment,
} from '../../../utils/audioTracks.mjs';

function track(index, language, overrides = {}) {
  return {
    index,
    channels: 6,
    language,
    title: null,
    isDefault: false,
    commentary: false,
    described: false,
    ...overrides,
  };
}

describe('taggedLanguage', () => {
  it.each([
    ['eng', 'en'], ['en', 'en'], ['EN', 'en'], ['en-US', 'en'], ['en_GB', 'en'], [' eng ', 'en'],
    ['ger', 'de'], ['deu', 'de'], ['fre', 'fr'], ['fra', 'fr'], ['jpn', 'ja'], ['por', 'pt'], ['pt-BR', 'pt'],
  ])('reads "%s" as %s', (language, expected) => {
    expect(taggedLanguage(track(0, language))).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['und'], ['UND'], [7]])('reads %p as no language', (language) => {
    expect(taggedLanguage(track(0, language))).toBeNull();
  });
});

describe('comparableLanguage', () => {
  it('puts a code in the form taggedLanguage returns', () => {
    expect(comparableLanguage('en')).toBe('en');
    expect(comparableLanguage('ENG')).toBe('en');
    expect(comparableLanguage(' pt-BR ')).toBe('pt');
    expect(comparableLanguage('spa')).toBe('es');
  });
});

describe('ordinaryTracks', () => {
  it('leaves out commentary and audio-description tracks, by flag or by title', () => {
    const tracks = [
      track(0, 'eng', { commentary: true }),
      track(1, 'eng', { title: "Director's Commentary" }),
      track(2, 'eng', { described: true }),
      track(3, 'eng', { title: 'Audio Description' }),
      track(4, 'eng', { title: 'DTS-HD MA 5.1' }),
    ];
    expect(ordinaryTracks(tracks)).toEqual([tracks[4]]);
  });

  it('is every track when none is ordinary', () => {
    const tracks = [track(0, 'eng', { commentary: true })];
    expect(ordinaryTracks(tracks)).toEqual(tracks);
  });
});

describe('trackInLanguage', () => {
  it('finds the track tagged with the language, wherever it sits', () => {
    const tracks = [track(0, 'ita', { isDefault: true }), track(1, 'ger'), track(2, 'eng')];
    expect(trackInLanguage(tracks, 'en')).toBe(tracks[2]);
    expect(trackInLanguage(tracks, 'de')).toBe(tracks[1]);
    expect(trackInLanguage(tracks, 'ita')).toBe(tracks[0]);
  });

  it('takes the default one among several, else the first', () => {
    const withDefault = [track(0, 'eng'), track(1, 'eng', { isDefault: true })];
    expect(trackInLanguage(withDefault, 'en')).toBe(withDefault[1]);

    const noDefault = [track(0, 'ita', { isDefault: true }), track(1, 'eng'), track(2, 'eng')];
    expect(trackInLanguage(noDefault, 'en')).toBe(noDefault[1]);
  });

  it('passes over a commentary in the language for the programme itself', () => {
    const tracks = [track(0, 'eng', { commentary: true, isDefault: true }), track(1, 'ita'), track(2, 'eng')];
    expect(trackInLanguage(tracks, 'en')).toBe(tracks[2]);
  });

  it('is null when the only track in the language is a commentary on something else', () => {
    const tracks = [track(0, 'fre', { isDefault: true }), track(1, 'eng', { commentary: true })];
    expect(trackInLanguage(tracks, 'en')).toBeNull();
  });

  it('is null when no track is tagged with the language', () => {
    expect(trackInLanguage([track(0, 'ita')], 'en')).toBeNull();
    expect(trackInLanguage([track(0, null), track(1, 'und')], 'en')).toBeNull();
  });

  it('is null when the tracks are not known', () => {
    expect(trackInLanguage(null, 'en')).toBeNull();
    expect(trackInLanguage(undefined, 'en')).toBeNull();
    expect(trackInLanguage([], 'en')).toBeNull();
  });
});

describe('preferredAudioLanguageFromEnvironment', () => {
  it('states no preference when the variable is not set', () => {
    for (const value of [undefined, '', '   ']) {
      expect(preferredAudioLanguageFromEnvironment(value)).toEqual({ language: null, invalid: false });
    }
  });

  it.each([
    ['en', 'en'], ['EN', 'en'], ['eng', 'en'], [' en ', 'en'], ['de', 'de'], ['ger', 'de'],
    ['ja', 'ja'], ['pt-BR', 'pt'], ['zh_Hant', 'zh'], ['fil', 'fil'],
  ])('reads "%s" as %s', (value, language) => {
    expect(preferredAudioLanguageFromEnvironment(value)).toEqual({ language, invalid: false });
  });

  it.each([['English'], ['en,de'], ['e'], ['en us'], ['true'], ['1']])(
    'rejects "%s", which is not a language code',
    (value) => {
      expect(preferredAudioLanguageFromEnvironment(value)).toEqual({ language: null, invalid: true });
    }
  );
});
