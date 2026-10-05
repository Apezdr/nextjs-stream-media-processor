import { canonicalizeLangCode, getLanguageName } from '../../../utils/languageMap.mjs';

/**
 * Which audio track a caption is transcribed from.
 *
 * Left to itself ffmpeg takes the audio stream with the most channels, whatever
 * language it is in. A film whose 5.1 track is the Japanese original and whose
 * English dub is stereo was transcribed from the Japanese, by a model told the
 * speech was English, and the "English" captions came out as nonsense.
 *
 * The track is chosen by its language tag instead:
 *   1. a track tagged with the caption's language;
 *   2. failing that, a track with no language tag. Its language is unknown, so
 *      it may well be the right one, and it is what an untagged file has always
 *      been captioned from;
 *   3. failing that, none. Every track says it is another language, and a
 *      caption made from it would be wrong, so none is made.
 *
 * Commentary and audio-description tracks are never chosen while the file has
 * an ordinary track: an English director's commentary is not the English
 * version of a French film. Among equals the file's default track wins, then
 * the first in the file.
 */

export class NoCaptionAudioError extends Error {
  /**
   * @param {string} langCode - The caption language asked for
   * @param {string[]} audioLanguages - Display names of the languages the file's audio is tagged with
   */
  constructor(langCode, audioLanguages) {
    const wanted = getLanguageName(langCode);
    super(
      audioLanguages.length > 0
        ? `No ${wanted} audio track to caption (audio: ${audioLanguages.join(', ')})`
        : 'No audio track to caption'
    );
    this.code = 'NO_AUDIO_FOR_LANGUAGE';
    this.language = langCode;
    this.audioLanguages = audioLanguages;
  }
}

const SECONDARY_TITLE = /\b(commentary|audio description|descriptive|described)\b/i;

/**
 * A track's language tag as a comparable code ("eng", "en", "en-US" are all
 * "en"), or null when the track does not say: no tag, or "und" (undetermined).
 */
function taggedLanguage(track) {
  const raw = typeof track.language === 'string' ? track.language.trim().toLowerCase() : '';
  if (!raw || raw === 'und') return null;
  return canonicalizeLangCode(raw.split(/[-_]/)[0]);
}

function isSecondary(track) {
  return Boolean(track.commentary || track.described || (track.title && SECONDARY_TITLE.test(track.title)));
}

function preferred(tracks) {
  return tracks.find((track) => track.isDefault) || tracks[0];
}

/**
 * @param {Array<{ index: number, language: string|null, title: string|null, isDefault: boolean, commentary: boolean, described: boolean }>} tracks
 *   The file's audio tracks in file order (`getAudioTracks`)
 * @param {string} langCode - The caption language ("en")
 * @returns {{ track: Object, matchedLanguage: boolean }} The track to transcribe, and
 *   whether it is tagged with the language (false: it has no language tag)
 * @throws {NoCaptionAudioError} when the file has no track that could be in that language
 */
export function selectCaptionAudioTrack(tracks, langCode) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new NoCaptionAudioError(langCode, []);
  }

  const ordinary = tracks.filter((track) => !isSecondary(track));
  const candidates = ordinary.length > 0 ? ordinary : tracks;
  const wanted = canonicalizeLangCode(String(langCode).toLowerCase());

  const inLanguage = candidates.filter((track) => taggedLanguage(track) === wanted);
  if (inLanguage.length > 0) {
    return { track: preferred(inLanguage), matchedLanguage: true };
  }

  const untagged = candidates.filter((track) => taggedLanguage(track) === null);
  if (untagged.length > 0) {
    return { track: preferred(untagged), matchedLanguage: false };
  }

  const audioLanguages = [...new Set(candidates.map((track) => getLanguageName(taggedLanguage(track))))];
  throw new NoCaptionAudioError(langCode, audioLanguages);
}
