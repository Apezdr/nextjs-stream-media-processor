import { canonicalizeLangCode, getLanguageName } from '../../../utils/languageMap.mjs';

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
 * A track here is `{ index, language, title, isDefault, commentary, described,
 * channels }`: what `getAudioTracks` (ffprobe.mjs) returns, and what
 * `tracksFromScanMetadata` makes of the scanner's stored record.
 */

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

/** The tracks a caption may come from: the ordinary ones, or all of them when none is ordinary. */
function candidateTracks(tracks) {
  const ordinary = tracks.filter((track) => !isSecondary(track));
  return ordinary.length > 0 ? ordinary : tracks;
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

  const candidates = candidateTracks(tracks);
  const wanted = canonicalizeLangCode(String(langCode).toLowerCase());

  const inLanguage = candidates.filter((track) => taggedLanguage(track) === wanted);
  if (inLanguage.length > 0) {
    return inLanguage.find((track) => track.isDefault) || inLanguage[0];
  }

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
  try {
    selectCaptionAudioTrack(tracks, langCode);
    return true;
  } catch (err) {
    if (err instanceof NoCaptionAudioError) return false;
    throw err;
  }
}

/**
 * The track ffmpeg takes when it is not told which: the default one, else the
 * one with the most channels, else the first. This is what every caption made
 * before tracks were chosen by language was transcribed from.
 *
 * @param {Array<Object>} tracks
 * @returns {Object|null}
 */
export function ffmpegDefaultAudioTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const score = (track) => (track.isDefault ? 5000000 : 0) + (Number(track.channels) || 0);
  return tracks.reduce((best, track) => (score(track) > score(best) ? track : best));
}

/**
 * Whether a caption made from ffmpeg's own pick was made from the right audio.
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
  const wanted = canonicalizeLangCode(String(langCode).toLowerCase());
  const usedIsRight = candidateTracks(tracks).includes(used) && taggedLanguage(used) === wanted;
  return usedIsRight ? 'ok' : 'wrong-track';
}

/**
 * The audio tracks of a title's video as the scanner recorded them
 * (`additionalMetadata.audio`, see infoManager.mjs), in the shape the
 * functions above take. Null when the record does not say which language each
 * track is in: no audio list, or one written before `languageTag` existed.
 *
 * @param {Object|null|undefined} additionalMetadata
 * @returns {Array<Object>|null}
 */
export function tracksFromScanMetadata(additionalMetadata) {
  const audio = additionalMetadata?.audio;
  if (!Array.isArray(audio)) return null;
  if (audio.some((track) => !track || !('languageTag' in track))) return null;
  return audio.map((track, position) => ({
    index: position,
    channels: track.channels,
    language: track.languageTag,
    title: track.title ?? null,
    isDefault: Boolean(track.disposition?.default),
    commentary: Boolean(track.disposition?.comment),
    described: Boolean(track.disposition?.visual_impaired || track.disposition?.descriptions),
  }));
}
