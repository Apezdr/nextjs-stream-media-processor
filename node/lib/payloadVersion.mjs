// lib/payloadVersion.mjs
//
// Identifies WHICH payload shape produced a stored row.
//
// The scanner's upsert change-guard only fires when directory_hash moves — i.e.
// when the library changed on disk. That is correct for content changes and
// completely wrong for shape changes: adding a field to the payload, or
// flipping a feature flag that adds one, changes nothing on disk, so the
// scanner computes the new payload and then declines to store it. The bug looks
// like "works on my machine" because a fresh dev database has no converged rows
// to skip.
//
// Storing the signature alongside the row and comparing it in the guard turns a
// version bump into exactly one library-wide convergence pass, which then
// settles. It is also the only convergence driver for TV, whose sidecars have
// no equivalent of the movie scanner's needsInfoRegeneration check.
//
// BUMP THIS when the emitted payload shape changes in a way consumers must see.

// 2 — mediaIdentity added (P3)
// 3 — urls.sources[] / episode.sources[] added; non-mp4 containers discovered (P4)
// 4 — jitKey/jitUrl decoupled from jitEligible: emitted for every addressable
//     container, so ineligible-but-servable files (multi-audio, probe-incomplete)
//     now carry a URL. Nothing on disk changes, so ONLY this bump converges it.
// 5 — multi-audio no longer disqualifies: the transcoder publishes audio groups
//     and the player picks, so those titles flip to jitEligible: true and lose
//     their jitReason. Again nothing on disk changes.
export const MEDIA_PAYLOAD_VERSION = 5;

/**
 * Whether this host advertises JIT transcoder capability.
 *
 * Read at call time rather than captured at module load so tests and a restart
 * both observe the current value.
 *
 * @returns {boolean}
 */
export function isJitEligibilityEnabled() {
  return process.env.JIT_ELIGIBILITY_ENABLED === 'true';
}

/**
 * The signature stored on every scanned row.
 *
 * The JIT flag is folded in deliberately: flipping the host toggle changes the
 * payload (the flag and URL appear or vanish) but touches nothing on disk, so
 * without it in the signature the toggle would have no effect at all on an
 * already-converged database. Rollback is "flip the env var, run one scan".
 *
 * @returns {string} e.g. '2:jit0'
 */
export function currentPayloadSignature() {
  return `${MEDIA_PAYLOAD_VERSION}:${isJitEligibilityEnabled() ? 'jit1' : 'jit0'}`;
}
