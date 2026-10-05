// utils/audioTracks.mjs
//
// Reading a video's audio tracks: which language each says it is in, which are
// commentary, and which one a given purpose should use.
//
// Two things pick a track by language. A caption is transcribed from one
// (components/caption-generator/domain/audio-track.mjs), and a preview clip
// carries one (videoHandler.mjs). They ask different questions of the same
// facts: a caption must not be made from a track that is not known to be in
// its language; a clip always has sound, and only prefers a language, and only
// on a deployment that names one (PREFERRED_AUDIO_LANGUAGE).
//
// A track here is `{ index, language, title, isDefault, commentary, described,
// channels }`. `language` is the stream's language tag as written, or null.

import { canonicalizeLangCode } from './languageMap.mjs';

const SECONDARY_TITLE = /\b(commentary|audio description|descriptive|described)\b/i;

/**
 * A track's language tag as a comparable code ("eng", "en", "en-US" are all
 * "en"), or null when the track does not say: no tag, or "und" (undetermined).
 */
export function taggedLanguage(track) {
  const raw = typeof track.language === 'string' ? track.language.trim().toLowerCase() : '';
  if (!raw || raw === 'und') return null;
  return canonicalizeLangCode(raw.split(/[-_]/)[0]);
}

/** A language code as `taggedLanguage` returns them, for comparing with one. */
export function comparableLanguage(langCode) {
  return canonicalizeLangCode(String(langCode).trim().toLowerCase().split(/[-_]/)[0]);
}

function isSecondary(track) {
  return Boolean(track.commentary || track.described || (track.title && SECONDARY_TITLE.test(track.title)));
}

/**
 * The tracks that are the programme itself: not a commentary, not an audio
 * description. All of them when none is ordinary, so a file is never left with
 * nothing to choose from.
 */
export function ordinaryTracks(tracks) {
  const ordinary = tracks.filter((track) => !isSecondary(track));
  return ordinary.length > 0 ? ordinary : tracks;
}

const defaultOrFirst = (tracks) => tracks.find((track) => track.isDefault) || tracks[0];

/**
 * The ordinary track tagged with a language: the default one among several,
 * else the first. Null when no ordinary track is tagged with it.
 *
 * @param {Array<Object>} tracks - In file order
 * @param {string} langCode
 * @returns {Object|null}
 */
export function trackInLanguage(tracks, langCode) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const wanted = comparableLanguage(langCode);
  const inLanguage = ordinaryTracks(tracks).filter((track) => taggedLanguage(track) === wanted);
  return inLanguage.length > 0 ? defaultOrFirst(inLanguage) : null;
}

/**
 * The deployment's preferred audio language, from PREFERRED_AUDIO_LANGUAGE: a
 * language code ("en", "eng", "de", "ja", "pt-BR"). Null when it is not set,
 * which states no preference: nothing here assumes one.
 *
 * `invalid` is true for a value that cannot be a language code, so the caller
 * can say so once instead of silently preferring nothing.
 *
 * @param {string|undefined} value - process.env.PREFERRED_AUDIO_LANGUAGE
 * @returns {{ language: string|null, invalid: boolean }}
 */
export function preferredAudioLanguageFromEnvironment(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { language: null, invalid: false };
  if (!/^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/i.test(raw)) return { language: null, invalid: true };
  return { language: comparableLanguage(raw), invalid: false };
}

/**
 * The track ffmpeg takes when it is not told which: the default one, else the
 * one with the most channels, else the first.
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
 * The audio tracks of a video as the scanner recorded them
 * (`additionalMetadata.audio`, see infoManager.mjs), in the shape the
 * functions above take. `index` is the track's position among the file's audio
 * streams, which is what `-map 0:a:<index>` takes.
 *
 * Null when the record does not say which language each track is in: no audio
 * list, or one written before `languageTag` existed.
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
