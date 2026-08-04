# Mission: Split JIT Addressability from Eligibility (`jitUrl` for all servable files)

**Status: implemented — `MEDIA_PAYLOAD_VERSION` 3 → 4.** Emission rule lives in
[`video-sources.mjs`](../node/components/media-scanner/domain/video-sources.mjs)
(`isJitAddressableContainer`, not `verdict.eligible`); the contract is folded
into [`jit-transcoder.md` §9](./jit-transcoder.md). **The convergence pass has
not been observed in production yet** — acceptance criterion 5 stays open until
the deploy runs and the reprocessing log line settles.

Companion to [`jit-transcoder.md`](./jit-transcoder.md) — this was the next
evolution of §9 (JIT emission). Requested by the frontend after the per-title
"Always JIT" override shipped.

## The problem, concretely

An admin set the per-title delivery override "Always JIT" on `Primate`
(audio: `eng` + `ger`). Nothing happened — and nothing *could* happen: the
scanner marks multi-audio files `jitEligible: false` (reason
`multi-audio-language`) and, because URL emission is gated on eligibility,
never publishes a `jitUrl` for them. The frontend override forces the
serve-time *decision*, but it cannot conjure a manifest URL the payload
declined to carry.

The current contract conflates two different facts:

- **"Routing this file through JIT loses nothing"** — the eligibility
  predicate's actual question (multi-audio would silently drop a language
  the viewer gets from direct play today).
- **"The transcoder can address and serve this file"** — true for
  multi-audio files; the ladder plays them fine, minus the extra language.

The per-title override exists precisely so an admin can say *"I know, and I
accept that"* — e.g. the German track on Primate is dispensable, and JIT
playback on the web beats a dead-end. That decision needs the URL to exist.

## The contract evolution

| Field | Old meaning | New meaning |
|---|---|---|
| `jitEligible` | servable via JIT (gates URL emission) | **RECOMMENDATION: no-loss** — unchanged predicate, unchanged values |
| `jitReason` | why not eligible | unchanged — now doubles as the "what you'd lose" label for override UIs |
| `jitKey` / `jitUrl` | emitted only when eligible | **ADDRESSABILITY** — emitted for every file the transcoder can technically serve |

New emission rule (replaces `verdict.eligible` in the `emitJit` condition,
`node/components/media-scanner/domain/video-sources.mjs:122`):

```
emitJit = hostEnabled && urlConfigured && relPath
          && SUPPORTED_CONTAINERS.has(container)   // mp4|m4v|mov|mkv|webm — NOT avi
```

- `hostEnabled` (`JIT_ELIGIBILITY_ENABLED`) stays the master switch: off ⇒
  no flags, no URLs, anywhere. Rollback semantics unchanged.
- `urlConfigured` (`JIT_TRANSCODER_URL`) unchanged.
- Container gate matches the eligibility predicate's own
  `SUPPORTED_CONTAINERS` (`node/components/media-scanner/domain/
  jit-eligibility.mjs`) — `.avi` stays unaddressable (Annex-B demuxing
  through the ladder is unverified).
- `multi-audio-language` and `probe-incomplete` files therefore now carry
  `jitKey`/`jitUrl` while keeping `jitEligible: false` + their `jitReason`.
  (The transcoder runs its own probe at serve time, so probe-incomplete is
  addressable; it just isn't *recommended* until the sidecar converges.)
- Title-level pair (`urls.jitEligible`/`urls.jitUrl` on movies, flat on
  episodes) keeps its existing derivation from the primary source — with
  the decoupled rule, a multi-audio primary now yields
  `jitEligible: false` **and** a non-null `jitUrl`. That combination is the
  whole point; nothing downstream may "simplify" one from the other.

## What the frontend does with it (context, no work for you)

Already shipped frontend-side (forward-compatible no-op until this lands):

- Default serve modes (`rescue`/`prefer`) require `jitEligible === true` to
  auto-swap — the no-loss default is preserved; nobody silently loses an
  audio track because a mode flag flipped.
- The per-title/season/show "Always JIT" override uses `jitUrl` regardless
  of eligibility — the accept-the-loss decision is explicit, per-title, and
  admin-owned.
- List visibility keys on "servable for this title": playable primary, or
  (`jitUrl` present AND (`jitEligible` OR overridden on)). So a multi-audio
  MKV stays hidden by default (it would dead-end on web) and appears the
  moment an admin overrides it.

## Convergence / versioning — do not skip

This changes emitted payload content with **nothing changed on disk**, which
is exactly the case the §11 change-guard note warns about: without a
version bump the scanner computes the new payload and declines to store it
(except on fresh databases, where it "works on my machine").

**Bump `MEDIA_PAYLOAD_VERSION`** (`node/lib/payloadVersion.mjs`). Cost: one
full library re-scan + one frontend resync — schedule off-peak. The
convergence log line (`media pivot: reprocessing … for payload signature`)
must appear once per title and then settle.

## Worth stating in the docs

`JIT_AUDIO_LANG` decides which language survives the collapse when an
overridden multi-audio file plays through JIT. Admins accepting the loss
should know which track wins — surface the configured value (or its
default) in `jit-transcoder.md` so "Always JIT on Primate" has a
predictable outcome (`eng` stays, `ger` drops, or vice versa).

## Acceptance criteria

1. A multi-audio file (e.g. `Primate`: eng+ger mp4) emits
   `jitEligible: false`, `jitReason: "multi-audio-language"`, **and**
   non-null `jitKey`/`jitUrl` (source entry and title level).
2. A probe-incomplete file emits `jitEligible: false`,
   `jitReason: "probe-incomplete"`, and non-null `jitKey`/`jitUrl`.
3. `.avi` files emit `jitEligible: false`, `jitReason:
   "container-unsupported"`, and **null** `jitKey`/`jitUrl`.
4. `JIT_ELIGIBILITY_ENABLED=false` ⇒ no flags and no URLs anywhere
   (unchanged rollback).
5. `MEDIA_PAYLOAD_VERSION` bumped; one convergence pass observed; the
   reprocessing log line does not recur on subsequent ticks.
6. Route shape and `jitKey` encoding untouched (`/stream/<base64url_nopad>/
   master.m3u8` — frozen per §12; the frontend's identity layer parses it).
7. `jit-transcoder.md` §9 updated: the "Capability, not liveness" framing
   becomes a three-way split — recommendation (`jitEligible`),
   addressability (`jitKey`/`jitUrl`), liveness (still nobody's claim).
