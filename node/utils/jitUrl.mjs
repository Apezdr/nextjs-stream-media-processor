// utils/jitUrl.mjs
//
// Builds the JIT transcoder's stream URLs.
//
// The transcoder addresses a source by base64url of its path RELATIVE TO ITS
// OWN media root — no query parameters, no ids, no database. This backend is
// co-located with it and already knows the library layout, so it constructs the
// URL rather than making every client re-derive the encoding rules.
//
// Route shape (frozen — coordinate any change with the frontend, which parses
// these in its watch-history identity layer):
//
//   {base}/stream/{base64url_nopad(relative path)}/master.m3u8
//
// HLS with fMP4 segments. DASH is a 501 stub in the transcoder.

const RAW_BASE = () => (process.env.JIT_TRANSCODER_URL || '').trim().replace(/\/+$/, '');

/**
 * Path prefix to prepend when this backend's BASE_PATH and the transcoder's
 * JIT_SOURCE_DIR are not rooted at the same place.
 *
 * Empty is correct for the standard topology, where the same volume is mounted
 * at /var/www/html here and /media (read-only) there, so a library-relative
 * path means the same thing on both sides.
 */
const SOURCE_PREFIX = () => {
  const raw = (process.env.JIT_SOURCE_PREFIX || '').trim();
  if (!raw) return '';
  return `${raw.replace(/^\/+|\/+$/g, '')}/`;
};

/**
 * Is JIT URL emission configured at all?
 *
 * Separate from JIT_ELIGIBILITY_ENABLED: a host can be eligible-enabled but
 * have no public transcoder URL configured, in which case the flag is emitted
 * and the URL is not.
 *
 * @returns {boolean}
 */
export function isJitUrlConfigured() {
  return RAW_BASE().length > 0;
}

/**
 * base64url, unpadded — matching the transcoder's own path_key encoding.
 *
 * Separators are normalised to '/' so a Windows host produces the same key as
 * a Linux one for the same file; the key is a path on the TRANSCODER's
 * filesystem, not on ours.
 *
 * @param {string} libraryRelativePath - e.g. 'movies/Dune (2021)/Dune.2021.mkv'
 * @returns {string}
 */
export function jitPathKey(libraryRelativePath) {
  const normalized = `${SOURCE_PREFIX()}${String(libraryRelativePath).replace(/\\/g, '/').replace(/^\/+/, '')}`;
  return Buffer.from(normalized, 'utf8').toString('base64url');
}

/**
 * Master playlist URL for a source, or null when no transcoder is configured.
 *
 * @param {string} libraryRelativePath
 * @returns {string|null}
 */
export function jitMasterUrl(libraryRelativePath) {
  const base = RAW_BASE();
  if (!base) return null;
  return `${base}/stream/${jitPathKey(libraryRelativePath)}/master.m3u8`;
}
