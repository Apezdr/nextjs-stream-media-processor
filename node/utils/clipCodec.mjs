// utils/clipCodec.mjs
//
// The output codec a /videoClip request may ask for with `?codec=`.
//
// The default keeps the host's best hardware encoder (vp9_vaapi -> VP9 in
// WebM on an Intel Arc box): small, but not playable everywhere — older
// iPhones/Safari and many chat apps' inline players refuse it. `codec=h264` is
// software libx264 in MP4 with AAC audio, the format practically every device
// plays, for clips shared with people outside the app.

/** Requestable codecs and the encoder (encoderConfig.mjs export) each one uses. */
export const CLIP_CODEC_ENCODERS = Object.freeze({
  h264: 'libx264',
});

/** Every value `?codec=` accepts, for error messages and docs. */
export const CLIP_CODEC_VALUES = Object.freeze(['auto', ...Object.keys(CLIP_CODEC_ENCODERS)]);

/**
 * Parse `?codec=`. Absent, empty or `auto` keeps the hardware default
 * (`encoder: null`); a supported value names its encoder; anything else —
 * including a repeated parameter, which Express hands over as an array — is
 * rejected rather than silently falling back to the default.
 *
 * @param {unknown} param - req.query.codec
 * @returns {{ ok: true, encoder: string|null } | { ok: false }}
 */
export function resolveClipCodec(param) {
  if (param === undefined || param === '') return { ok: true, encoder: null };
  if (typeof param !== 'string') return { ok: false };
  const value = param.trim().toLowerCase();
  if (value === 'auto') return { ok: true, encoder: null };
  const encoder = CLIP_CODEC_ENCODERS[value];
  return encoder ? { ok: true, encoder } : { ok: false };
}
