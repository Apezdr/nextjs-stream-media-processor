// components/media-scanner/domain/jit-eligibility.mjs
//
// Pure decision table: can the JIT transcoder serve this file WITHOUT the
// viewer losing something they get from direct playback today?
//
// That framing matters. The transcoder's ladder can decode essentially anything
// ffmpeg can demux, so "can it play this at all" is nearly always yes and would
// be a useless predicate. What this answers is narrower and more useful: is
// routing this file through JIT a strict improvement, or does it quietly cost
// the viewer an audio language?
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
// A multi-audio file is addressable but not recommended: an admin who accepts
// losing the second language needs the URL to exist, which is why URL emission
// no longer keys off this verdict. See docs/jit-url-addressability.md.
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
 * @param {string[]} [facts.audioLanguages] - Distinct strict language codes
 * @param {boolean} facts.hostEnabled
 * @returns {EligibilityVerdict}
 */
export function evaluateJitEligibility({
  container,
  formatName,
  videoCodec,
  audioLanguages = [],
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

  // The transcoder collapses multi-audio sources to ONE language, chosen by a
  // process-global JIT_AUDIO_LANG with no per-request override. Routing a
  // multi-language file through it would silently drop languages the viewer
  // gets today. Lift this when audio-group support ships.
  if (audioLanguages.length > 1) {
    return { eligible: false, reason: 'multi-audio-language' };
  }

  // Deliberately NOT disqualifying:
  //   HDR / Dolby Vision — the tone-map path is always present (JIT_HDR
  //     defaults to tonemap) and PQ passthrough is additive on top of it.
  //   Interlaced content — field_order gates only the zero-cost remux rung,
  //     never the transcode ladder.
  return { eligible: true, reason: 'ok' };
}
