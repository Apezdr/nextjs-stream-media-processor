import { getLanguageName } from '../../../utils/languageMap.mjs';
import {
  taggedLanguage,
  comparableLanguage,
  ordinaryTracks,
  trackInLanguage,
  ffmpegDefaultAudioTrack,
  tracksFromScanMetadata,
} from '../../../utils/audioTracks.mjs';

/**
 * Which audio track a caption is transcribed from.
 *
 * Left to itself ffmpeg takes the file's default audio track, or with no
 * default the one with the most channels, whatever language it is in. A film
 * whose default track is the Italian dub was transcribed from the Italian, by
 * a model told the speech was English, and the "English" captions came out as
 * nonsense.
 *
 * A caption is made only from a track that SAYS it is in the caption's
 * language: one whose language tag matches. A file with no such track gets no
 * caption, and is not offered one (caption-stubs.mjs asks the same question
 * here). That includes a file whose audio carries no language tag at all: its
 * speech may well be English, but nothing identifies it as English, and the
 * untagged files in a library are exactly where the foreign-language ones with
 * no metadata sit. Tagging the track brings the caption back.
 *
 * Commentary and audio-description tracks are never chosen while the file has
 * an ordinary track: an English director's commentary is not the English
 * version of a French film. Among equals the file's default track wins, then
 * the first in the file.
 *
 * The reading of the tracks themselves (language tags, commentary, ffmpeg's own
 * pick) is utils/audioTracks.mjs, shared with the preview clips. A track is
 * what `getAudioTracks` (ffprobe.mjs) returns, or what `tracksFromScanMetadata`
 * makes of the scanner's stored record.
 */

export { ffmpegDefaultAudioTrack, tracksFromScanMetadata };

export class NoCaptionAudioError extends Error {
  /**
   * @param {string} langCode - The caption language asked for
   * @param {string[]} audioLanguages - Display names of the languages the file's audio is tagged with
   * @param {number} untaggedTracks - How many of its tracks carry no language tag
   */
  constructor(langCode, audioLanguages, untaggedTracks) {
    const wanted = getLanguageName(langCode);
    const found = [...audioLanguages, ...(untaggedTracks > 0 ? ['untagged'] : [])];
    super(
      found.length > 0
        ? `No ${wanted} audio track to caption (audio: ${found.join(', ')})`
        : 'No audio track to caption'
    );
    this.code = 'NO_AUDIO_FOR_LANGUAGE';
    this.language = langCode;
    this.audioLanguages = audioLanguages;
    this.untaggedTracks = untaggedTracks;
  }
}

/**
 * @param {Array<Object>|null|undefined} tracks - The file's audio tracks in file order
 * @param {string} langCode - The caption language ("en")
 * @returns {Object} The track to transcribe
 * @throws {NoCaptionAudioError} when no track is tagged with that language
 */
export function selectCaptionAudioTrack(tracks, langCode) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new NoCaptionAudioError(langCode, [], 0);
  }

  const inLanguage = trackInLanguage(tracks, langCode);
  if (inLanguage) return inLanguage;

  const candidates = ordinaryTracks(tracks);
  const tagged = candidates.map(taggedLanguage).filter((language) => language !== null);
  throw new NoCaptionAudioError(
    langCode,
    [...new Set(tagged.map((language) => getLanguageName(language)))],
    candidates.length - tagged.length
  );
}

/**
 * Whether a caption in `langCode` can be made from these tracks. False for
 * unknown tracks (null): a file is offered a caption only when it is known to
 * have the audio for one.
 *
 * @param {Array<Object>|null|undefined} tracks
 * @param {string} langCode
 * @returns {boolean}
 */
export function hasCaptionAudioTrack(tracks, langCode) {
  return Array.isArray(tracks) && trackInLanguage(tracks, langCode) !== null;
}

/**
 * Whether a caption made from ffmpeg's own pick was made from the right audio.
 * Every caption made before tracks were chosen by language came from that pick.
 *
 * @param {Array<Object>|null|undefined} tracks
 * @param {string} langCode
 * @returns {'ok'|'wrong-track'|'no-audio-in-language'}
 *   'ok': the pick was an ordinary track in the language.
 *   'wrong-track': it was not, and the file has one that is.
 *   'no-audio-in-language': the file has no track a caption could come from.
 */
export function judgeUnmappedCaption(tracks, langCode) {
  if (!hasCaptionAudioTrack(tracks, langCode)) return 'no-audio-in-language';
  const used = ffmpegDefaultAudioTrack(tracks);
  const usedIsRight =
    ordinaryTracks(tracks).includes(used) && taggedLanguage(used) === comparableLanguage(langCode);
  return usedIsRight ? 'ok' : 'wrong-track';
}
