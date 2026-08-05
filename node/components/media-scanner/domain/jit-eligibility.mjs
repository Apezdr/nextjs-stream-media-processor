// components/media-scanner/domain/jit-eligibility.mjs
//
// Pure decision table: can the JIT transcoder serve this file WITHOUT the
// viewer losing something they get from direct playback today?
//
// That framing matters. The transcoder's ladder can decode essentially anything
// ffmpeg can demux, so "can it play this at all" is nearly always yes and would
// be a useless predicate. What this answers is narrower and more useful: is
// routing this file through JIT a strict improvement, or does it quietly cost
// the viewer something?
//
// Eligibility is a RECOMMENDATION, not addressability and not liveness. Three
// separate facts, deliberately not folded together:
//
//   recommendation  — this module. "Routing through JIT loses nothing."
//   addressability  — isJitAddressableContainer below. "The transcoder can
//                     reach and serve this file at all." Gates jitKey/jitUrl.
//   liveness        — nobody's claim. The client health-checks at serve time
//                     and falls back to the raw URL.
//
// The split still matters even though multi-audio no longer disqualifies:
// probe-incomplete files are addressable but not recommended, and the admin
// override needs a URL for anything it is pointed at. See
// docs/jit-url-addressability.md.
//
// Zero I/O by design, mirroring cooldown-policy.mjs: every input is a fact the
// scanner already has from the .info sidecar.

/** Containers the transcoder is known to handle. */
const SUPPORTED_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm']);

/**
 * Can the transcoder address and serve this container at all?
 *
 * The addressability half of the split — this, not the eligibility verdict, is
 * what gates `jitKey`/`jitUrl`. Shares SUPPORTED_CONTAINERS with the predicate
 * on purpose: the two must never disagree about `.avi`, whose Annex-B/legacy
 * demuxing through the ladder is unverified and therefore stays unaddressable.
 *
 * @param {string} container - Extension without the dot, any case
 * @returns {boolean}
 */
export function isJitAddressableContainer(container) {
  return SUPPORTED_CONTAINERS.has(String(container).toLowerCase());
}

/**
 * @typedef {Object} EligibilityVerdict
 * @property {boolean} eligible
 * @property {string} reason - 'ok' or the disqualifying rule
 */

/**
 * @param {Object} facts
 * @param {string} facts.container       - Extension without the dot, lowercased
 * @param {string|null} facts.formatName - ffprobe format_name
 * @param {string|null} facts.videoCodec
 * @param {boolean} facts.hostEnabled
 * @returns {EligibilityVerdict}
 */
export function evaluateJitEligibility({
  container,
  formatName,
  videoCodec,
  hostEnabled,
}) {
  if (!hostEnabled) {
    return { eligible: false, reason: 'host-disabled' };
  }

  if (!isJitAddressableContainer(container)) {
    // .avi and anything else stays fully discoverable and directly playable —
    // it simply never carries the flag. Annex-B/legacy demuxing through the
    // ladder is unverified, and a capability claim should be conservative.
    return { eligible: false, reason: 'container-unsupported' };
  }

  // Fail CLOSED on incomplete probe data. A sidecar written before v1.0011 has
  // no container/codec block, so the flag simply does not appear until that
  // sidecar converges. This is what lets the probe bump and this rollout
  // self-order with no sequencing work between them.
  if (!videoCodec || !formatName) {
    return { eligible: false, reason: 'probe-incomplete' };
  }

  // Deliberately NOT disqualifying:
  //   Multi-language audio — WAS `multi-audio-language`, the whole reason this
  //     predicate existed. The transcoder now publishes every audio track as an
  //     HLS audio group and the player picks, so nothing is dropped;
  //     JIT_AUDIO_LANG selects the DEFAULT rather than collapsing the rest
  //     away. Removed in payload v5 — see docs/jit-transcoder.md §9. This is
  //     why `audioLanguages` is no longer a parameter at all: the count stops
  //     being a policy input, though it stays published in sources[] for
  //     consumers that surface available languages.
  //   HDR / Dolby Vision — the tone-map path is always present (JIT_HDR
  //     defaults to tonemap) and PQ passthrough is additive on top of it.
  //   Interlaced content — field_order gates only the zero-cost remux rung,
  //     never the transcode ladder.
  return { eligible: true, reason: 'ok' };
}
