// utils/clipCodec.mjs
//
// The `?codec=` parameter on /videoClip.
//
// It used to choose between the host's hardware encoder (VP9 in WebM on an
// Intel Arc box) and software H.264. Every encoded clip is H.264 + AAC in MP4
// now, so there is nothing left to choose: `h264` and `auto` are both accepted
// and name the same clip. `h264` stays because share links written while it was
// an option still carry it.
//
// Anything else is rejected rather than quietly served as H.264, so a typo, or
// a codec this endpoint does not make, is visible to whoever built the URL.

/** Every value `?codec=` accepts, for error messages and docs. */
export const CLIP_CODEC_VALUES = Object.freeze(['auto', 'h264']);

/**
 * Whether a `?codec=` value is acceptable. Absent and empty are; so are the
 * values above, in any case. A repeated parameter, which Express hands over as
 * an array, is not.
 *
 * @param {unknown} param - req.query.codec
 * @returns {boolean}
 */
export function isAcceptedClipCodec(param) {
  if (param === undefined || param === '') return true;
  if (typeof param !== 'string') return false;
  return CLIP_CODEC_VALUES.includes(param.trim().toLowerCase());
}
