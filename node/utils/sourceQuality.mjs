// utils/sourceQuality.mjs
//
// How two video files of the same title compare, from the facts sources[]
// already publishes (dimensions, hdr label). The scanner uses it to choose a
// primary when no library manager says which file is the title's; the
// identity service uses it to warn when a "leftover" is the better copy.

/**
 * Resolution class from "WxH", by effective width: an anamorphic 1440x1080 is
 * 1080p and a letterboxed 3840x1608 is 2160p, so crop and pixel aspect do not
 * count as quality.
 * @param {string|null} dimensions
 * @returns {number} 0 unknown, 1 SD, 2 720p, 3 1080p, 4 2160p
 */
export function resolutionClass(dimensions) {
  const match = /^(\d+)x(\d+)$/.exec(dimensions ?? '');
  if (!match) return 0;
  const width = Math.max(Number(match[1]), Math.round((Number(match[2]) * 16) / 9));
  if (width >= 3200) return 4;
  if (width >= 1800) return 3;
  if (width >= 1200) return 2;
  return 1;
}

/** Whether an hdr label names a high-dynamic-range format ("10-bit SDR" does not). */
export function isHdrLabel(hdr) {
  return /HDR|Dolby Vision|HLG/i.test(hdr ?? '');
}

/**
 * HDR first, then resolution class.
 * @param {{dimensions?: string|null, hdr?: string|null}} a
 * @param {{dimensions?: string|null, hdr?: string|null}} b
 * @returns {number} > 0 when a is better, < 0 when b is, 0 when equal
 */
export function compareSourceQuality(a, b) {
  return (
    (isHdrLabel(a?.hdr) ? 1 : 0) - (isHdrLabel(b?.hdr) ? 1 : 0) ||
    resolutionClass(a?.dimensions) - resolutionClass(b?.dimensions)
  );
}
