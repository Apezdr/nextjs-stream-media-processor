// utils/clipCodec.mjs
//
// The URL parameters, and the one environment variable, that choose how an
// encoded /videoClip is made.
//
//   ?codec=    `h264` (the default, and what `auto` means) or `av1`.
//              H.264 plays everywhere. AV1 is about half the size for a browser
//              that can play it, so a page lists the AV1 URL first and the
//              plain one second and lets the browser pick.
//
//   ?encoder=  AV1 only: `software` or `gpu`. Software (SVT-AV1) is the default
//              and works on every server. `gpu` asks for an Intel GPU's AV1
//              encoder through Quick Sync, and gets the software encoder where
//              there is no such GPU or it fails: the clip is AV1 either way.
//
//   VIDEO_CLIP_AV1_ENCODER=gpu   makes `gpu` the default for requests that do
//              not say. `?encoder=software` still overrides it per request.
//
// A value that is not on these lists is rejected rather than quietly served as
// something else, so a typo is visible to whoever built the URL. Whether this
// particular server can make AV1 at all is the handler's question, not this
// file's: it depends on what its ffmpeg and its hardware can do.

/** Every value `?codec=` can take. */
export const CLIP_CODEC_VALUES = Object.freeze(['auto', 'h264', 'av1']);

/** Every value `?encoder=` can take. */
export const CLIP_ENCODER_VALUES = Object.freeze(['software', 'gpu']);

/** What makes an AV1 clip when neither the URL nor the environment says. */
export const DEFAULT_AV1_ENCODER_CHOICE = 'software';

/** A single, non-empty query value, lowercased; undefined when absent; null when it is not a plain string. */
function queryValue(param) {
  if (param === undefined || param === '') return undefined;
  if (typeof param !== 'string') return null; // a repeated parameter arrives as an array
  return param.trim().toLowerCase();
}

/**
 * Parse `?codec=`.
 *
 * @param {unknown} param - req.query.codec
 * @returns {'h264'|'av1'|null} null for a value this endpoint does not know
 */
export function resolveClipCodec(param) {
  const value = queryValue(param);
  if (value === undefined || value === 'auto' || value === 'h264') return 'h264';
  return value === 'av1' ? 'av1' : null;
}

/**
 * Parse `?encoder=`.
 *
 * @param {unknown} param - req.query.encoder
 * @returns {'software'|'gpu'|undefined|null} undefined when the URL does not
 *   say (the server default applies); null for a value this endpoint does not know
 */
export function resolveClipEncoderChoice(param) {
  const value = queryValue(param);
  if (value === undefined) return undefined;
  return CLIP_ENCODER_VALUES.includes(value) ? value : null;
}

/**
 * Read VIDEO_CLIP_AV1_ENCODER.
 *
 * @param {string|undefined} value - process.env.VIDEO_CLIP_AV1_ENCODER
 * @returns {{ choice: 'software'|'gpu', invalid: boolean }} `invalid` when the
 *   variable is set to something else; the choice is then the built-in default
 */
export function av1EncoderChoiceFromEnvironment(value) {
  const normalised = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalised === '') return { choice: DEFAULT_AV1_ENCODER_CHOICE, invalid: false };
  if (CLIP_ENCODER_VALUES.includes(normalised)) return { choice: normalised, invalid: false };
  return { choice: DEFAULT_AV1_ENCODER_CHOICE, invalid: true };
}
