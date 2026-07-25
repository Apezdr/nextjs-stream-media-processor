# Media Payload Contract — Containers, Identity, and JIT Transcoding

**Status: living document.** This is the implementation truth for what the media endpoints
emit about video sources. Its companion is
[`nextjs-stream/docs/jit-transcoder/backend-jit-url-emission.md`](../../nextjs-stream/docs/jit-transcoder/backend-jit-url-emission.md),
which states the *mission*; where the two disagree, this file describes what the code
actually does.

Each field below carries a **Status** marking the phase that ships it. Fields marked
`planned` are specified so the frontend can build against them before the backend lands
them — they are not in the payload yet.

| Phase | Branch | Ships |
|---|---|---|
| P0 | `epic/p0-scanner-baseline` | Scan concurrency bound, dead code removed |
| P1 | `epic/p1-media-resolution` | Container-agnostic discovery (§1–§3) |
| P2 | `epic/p2-info-sidecar` | `.info` sidecar v1.0011 — probe fields for eligibility (§8) |
| P3 | `epic/p3-media-identity` | `mediaIdentity` + `.mediaid.json` sidecar (§4) |
| P4 | `epic/p4-container-sources` | `urls.sources[]`; MKV/MOV titles become visible (§7) |
| P5 | — (frontend) | Identity cutover + WatchHistory remediation — **not started** |
| **P6** | `epic/p6-jit-emission` | **`jitEligible`, `jitKey`, `jitUrl` (§9)** — ships disabled |

---

## 1. What we pivoted away from

| Was | Why it broke | Now |
|---|---|---|
| **MP4-only discovery.** `findMp4File()` plus eight inline `.endsWith('.mp4')` filters | An `.mkv` or `.mov` title was invisible: no URL, no length, no dimensions, no `_id`, and therefore absent from the incremental hash sweep | One module, [`node/utils/mediaResolution.mjs`](../node/utils/mediaResolution.mjs), driven by `VIDEO_EXTENSIONS` |
| **Four different episode matchers.** Two supported legacy `03 - Name` keys, two silently did not | The full-video route and the clip route disagreed about whether an episode existed | `matchesEpisodeKey()` — the union of all four |
| **Literal `` `Season ${n}` `` joins** in five places | Missed `Season 01` and `Season 2 - Pilot Arc` entirely | `findSeasonFolder()` / `resolveSeasonDir()`, matched numerically |
| **Chapter path rebuilt by string surgery** — stripped the real extension, re-appended `.mp4` | 404'd for any non-mp4 title *even when its stored URL was correct* | Resolve the real file, then derive the chapter name from it |
| **`-original.mp4` clip cache** — remuxed source bytes into a hardcoded `.mp4` name | An `.mkv` source produced matroska bytes in a `.mp4` file served as `video/mp4`; three-way mismatch | Extension derived from the source container, with a matching eviction predicate |
| **3-entry MIME table** | `.mov` / `.m4v` / `.avi` served as `application/octet-stream`, which browsers refuse to play | One entry per `VIDEO_EXTENSIONS` member |
| **Identity derived from the played URL** | A rename, remux, or container swap orphaned watch history — and it already did once in production | `mediaIdentity.id`, derived from the folder path and persisted to a sidecar on the media volume (§4) |
| **Frontend-constructed JIT URLs** | The backend is co-located with the transcoder and already knows the library layout, so making every client re-derive the base64 encoding was pointless indirection | Backend emits `jitUrl` and `jitKey` (§9) |

---

## 2. Supported containers · Status: **shipped P1**

`VIDEO_EXTENSIONS` in [`node/utils/utils.mjs`](../node/utils/utils.mjs) is the single source
of truth:

```js
export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi'];
```

**The order is load-bearing.** It is the priority order used to choose "the" video file when
a folder holds more than one, so it decides which URL a title publishes. `.mp4` stays first
because that is what the scanner has always chosen, and today's watch-history identity is
derived from the published URL — reordering would repoint existing titles. New containers are
appended or inserted *after* `.mp4`, never in front of it.

Matching is case-insensitive (`Movie.MKV` works). Files containing `-TdarrCacheFile-` are
excluded: they are valid containers written mid-transcode, so an extension filter alone would
happily return one.

---

## 3. Resolution rules · Status: **shipped P1**

Every "which file is this?" question goes through `mediaResolution.mjs`.

**Selecting a file** — three tiers, in order:

1. **Exact filename match** against the caller's stored filename.
2. **Stem match across containers.** The stored filename says `Show.S01E03.mp4` but Tdarr
   remuxed it to `.mkv`. This resolves and logs at info level. It used to 404.
3. **`VIDEO_EXTENSIONS` priority order**, constrained by an episode pattern for TV.

**A miss returns `null`, never a wrong file.** The old `findMp4File` fell back to "any `.mp4`
in this directory", which for TV meant requesting a missing episode silently served a
*different* episode. That is now a `null` and a 404.

**Episode identification** accepts both the standard `S01E03` token and the legacy
`03 - Episode Name` form, in filenames and in stored blob keys, with padded or unpadded input.

**Season folders** are matched by the numeric value of their first digit run, over
directories only — a stray `Season 1 notes.txt` beside a real `Season 1` folder is ignored.

**Path safety.** `resolveMovieVideo` / `resolveSeasonDir` / `resolveEpisodeVideo` take
untrusted title names and route them through `safeJoin`, which throws `PathTraversalError`.
Previously only the admin routes were guarded; the video, frame, clip, sprite, and chapter
routes were not.

---

## 4. Identity · Status: **shipped P3**

**`mediaIdentity.id` is what watch history joins on.** Do not derive identity from a URL, a
filename, or `_id`.

Two constraints decided the design: it must survive a database refresh (so SQLite cannot be
the source of truth), and it must not depend on a service the operator may not have configured
(so TMDB cannot be the anchor). What is left is the media volume.

**The id is derived from the library-relative folder path, then persisted to a
`.mediaid.json` sidecar beside the media.** Derivation makes it self-healing; persistence makes
it rename-proof.

| Change | Survives | Why |
|---|---|---|
| Remux `.mkv` → `.mp4`, re-encode in place | ✅ | Identity is folder-level |
| Add / remove a container | ✅ | Same |
| Episode file rename | ✅ | Episode id is `showId` + coordinate, never the filename |
| **DB drop / rebuild / refresh** | ✅ | Sidecars are read back; ids are byte-identical |
| **Folder rename** | ✅ | The sidecar travels with the folder and wins over re-derivation |
| Sidecar deleted, folder unchanged | ✅ | Re-derives identically |
| Sidecar deleted **and** folder renamed | ❌ | The one accepted gap — needs an admin remap |
| TMDB re-points, or was never configured | ✅ | No TMDB dependency at all |

```jsonc
// movies/Dune (2021)/.mediaid.json   —   tv/Breaking Bad/.mediaid.json
{
  "v": 1,
  "id": "mid:a91c04f7e2b6d558",         // sha256(library-relative path)[0:16], frozen at first sight
  "derivedFrom": "movies/Dune (2021)",  // provenance; stale after a rename, and that is fine
  "primarySource": "Dune.2021.mkv",     // which file publishes as urls.mp4
  "firstSeen": "2026-07-25T18:02:11.000Z",
  "previousIds": []                     // appended on a repoint, never by a normal scan
}
```

- **Movie id** — the sidecar's `id`.
- **Episode id** — `` `${showId}:s${SS}e${EE}` ``, e.g. `mid:3e88b1049fc7a2d1:s01e03`. One
  sidecar per *show*, not per episode.
- Separators are normalised before hashing so a Windows host and a Linux host derive the same
  id — a host migration must not fork watch history.

**Emitted as** `mediaIdentity: { id, scheme: "mid" }`, at the movie level and flat on each
episode. `null` when identity could not be resolved this pass.

**`mediaIdentity` vs `_id`** — do not conflate them. `mediaIdentity` is *location* identity:
one per title, stable across re-encodes. `_id` is `info.uuid`, a mediainfo header hash: **per
file**, so it differs between containers and rotates whenever the bytes change. The video and
sprite caches key on `_id` precisely because it rotates.

**Scanner behaviour**

| State | Action |
|---|---|
| Sidecar present and parseable | Use its `id`. Never re-derive. |
| No sidecar | Derive, write it, log `identity established` |
| Sidecar unparseable or a future `v` | **Do not overwrite** — derive for this pass only, log `identity sidecar unreadable` |
| Id already claimed by another title | Re-derive from this folder's own path, record the displaced id in `previousIds`, log `identity duplicate` + `identity repointed` |
| Media volume read-only | Use the derived id, log `identity sidecar write failed`, retry next scan |

`primarySource` is seeded **once**, from the row's already-stored `urls.mp4`, and never
recomputed. Today's scanner picks the *last* `.mp4` in a multi-mp4 folder while priority-order
selection picks the *first*; recomputing would silently repoint those titles' published URL,
which the frontend still derives its legacy watch-history key from until its cutover lands.

**`media_identity_index` in SQLite is a rebuildable cache**, not authoritative state — its only
active job is the duplicate check. `DROP TABLE media_identity_index` and rescan reproduces it
exactly. Likewise `movies.media_id` / `tv_shows.media_id` are cached copies of the sidecar
value. Nothing here needs backing up; the media volume already is the backup.

---

## 5. Movie payload

`GET /media/movies` → `urls`:

| Field | Type | Status | Notes |
|---|---|---|---|
| `mp4` | string | shipped | **Legacy name.** The primary source URL, whatever its container — for an MKV-only title this ends in `.mkv`. It is a *locator*, never a container claim. New code should read `identityUrl` and `sources[]`. |
| `mediaLastModified` | ISO string | shipped | mtime of the primary source. Drives the incremental hash sweep. |
| `subtitles`, `chapters`, `poster`, `backdrop`, `logo`, `metadata` | — | shipped | Unchanged by this pivot |
| `sources[]` | array | **shipped P4** | Every video file for this title — see §7 |

`mediaIdentity` (object, **shipped P3** — see §4) sits at the movie level beside `urls`.
`jitEligible` / `jitUrl` (**shipped P6** — see §9) live *inside* `urls`, beside `urls.mp4`.

## 6. TV payload

`GET /media/tv` → `seasons[<Season Name>].episodes[<key>]`:

| Field | Type | Status | Notes |
|---|---|---|---|
| `filename` | string | shipped | Basename with extension |
| `videoURL` | string | shipped | Primary source URL — the TV counterpart of `urls.mp4` |
| `_id` | string | shipped | `info.uuid`, a mediainfo header hash. **Per file**, so it varies by container and rotates on re-encode. Not identity — see §4. |
| `mediaIdentity` | object | **shipped P3** | `{ id, scheme }`, flat on the episode. `id` is `` `${showId}:s##e##` `` |
| `sources[]` | array | **shipped P4** | Every container for this episode — see §7 |
| `jitEligible`, `jitUrl` | boolean / string\|null | **shipped P6** | Flat on the episode, describing the primary source — see §9 |

**Episodes carry flat fields by design and will not gain a `urls` bag.** Nesting them would
reshape a hot payload and change the input shape of `generateTVShowHashes`, forcing a resync
for no benefit.

---

## 7. `sources[]` · Status: **shipped P4**

One entry per video file in the title's folder. Present on movies as
`urls.sources[]` and flat on each episode as `sources[]`.

```jsonc
{
  "url": "string",                // as served, percent-encoded
  "filename": "string",           // decoded basename
  "container": "mp4|m4v|mov|mkv|webm|avi",
  "formatName": "string|null",    // ffprobe format.format_name, verbatim
  "size": "number|null",          // bytes
  "length": "number|null",        // duration, ms
  "dimensions": "string|null",    // "1920x1080"
  "videoCodec": "string|null",
  "pixFmt": "string|null",
  "fieldOrder": "string|null",    // null = unknown; treat as progressive
  "hdr": "string|null",
  "audioTrackCount": "number",
  "audioLanguages": "string[]",   // distinct, normalized, sorted; [] when untagged
  "mediaLastModified": "string",
  "uuid": "string|null",          // info.uuid of THIS file, not of the title
  "isPrimary": "boolean",         // exactly one true
  "jitEligible": "boolean",       // see §9
  "jitReason": "string|null",     // why not, when ineligible
  "jitKey": "string|null",
  "jitUrl": "string|null"
}
```

**Ordering is a hard contract**, not cosmetic: `movies.urls` is folded wholesale into the
movie hash, so a `readdir`-order-dependent array would make that hash flap between scans and
force a permanent resync loop. Sorted by `VIDEO_EXTENSIONS` index, then by filename.

**Invariants:** exactly one `isPrimary: true` when the array is non-empty; that entry's `url`
equals `urls.mp4` (movies) or `videoURL` (episodes); an empty array means neither is emitted.

**Which source is primary** — the identity sidecar's pinned `primarySource` when that file is
still present, otherwise the first entry in `VIDEO_EXTENSIONS` priority order. The pin is what
keeps an existing title publishing the same URL it published before this shipped.

**An unprobeable file is still a source.** If ffprobe cannot read it, the entry is published
with null facts rather than dropped — a file that exists and can be served should not vanish
from the catalog because a probe failed.

**Multiple containers of the same episode collapse to one entry.** A season holding both
`S01E01.mp4` and `S01E01.mkv` yields a single episode whose primary is the `.mp4`, with the
`.mkv` alongside in `sources[]`. Previously the two would have written to the same episode key
and the winner would have flipped with readdir order, moving that episode's URL on every scan.

**`directPlayLikely` is deliberately not emitted.** Whether the transcoder can remux rather
than re-encode depends on `JIT_DIRECT_PLAY`, `JIT_HDR`, segment-size floors, and a keyframe
map — all transcoder-side config this backend cannot observe. The raw facts above let any
consumer recompute it; a derived boolean would silently rot.

---

## 8. `.info` sidecar v1.0011 · Status: **shipped P2**

Each video file has a `<filename>.info` sidecar next to it, written by
[`node/infoManager.mjs`](../node/infoManager.mjs). It is a **cache**, not a source of truth —
delete one and it regenerates. `additionalMetadata` is published to the frontend as
`additional_metadata`.

v1.0011 adds the facts needed to decide whether the transcoder can serve a file without
losing anything, at **zero extra subprocess cost** — the existing
`ffprobe -show_format -show_streams` call already returned them and threw them away.

```jsonc
additionalMetadata: {
  format: {                       // NEW — null when probing failed
    formatName: "matroska,webm",  // ffprobe format_name, verbatim (comma-joined family)
    formatLongName: "Matroska / WebM",
    bitrate: 8000000
  },
  video: [{
    codec, frame_rate, bitrate, aspect_ratio, width, height,
    pix_fmt, field_order,                            // NEW — gate the remux path
    color_transfer, color_primaries, color_space,    // NEW — HDR10 / HLG / SDR
    profile, level                                   // NEW
  }],
  audio: [{
    codec, channels, sample_rate, bitrate,
    language,      // UNCHANGED, and NOT a language code — see below
    languageTag,   // NEW — strict code, lowercased; null for absent/"und"
    title,         // NEW
    disposition: { default, comment, visual_impaired, descriptions }  // NEW
  }]
}
```

**`language` vs `languageTag`.** The pre-existing `language` field falls back to
`tags.title` when no language tag is present, so it can hold `"Director Commentary"` or
`"English [DTS-HD MA 5.1]"`. It is left exactly as-is because it is published and the frontend
reads it. **Any policy decision about how many languages a file carries must use
`languageTag`**, which comes only from `tags.language|LANGUAGE|lang`. A three-track file with
one tagged language yields 3 distinct `language` values and 1 distinct `languageTag`.

**Probe failure writes a shaped empty**, not `{}` — every key present, values null.
`validateInfo` tests for the *presence* of `format`, so a bare `{}` would fail validation,
regenerate, fail again, on every `getInfo` call forever. There is a regression test pinning
this.

**Convergence.** Movies re-probe through `needsInfoRegeneration`, which covers every container
as of P4. It had to stay `.mp4`-only until then: it decides whether to *reprocess*, while
`processVideoFiles` is what actually calls `getInfo`, so widening the first without the second
makes every folder containing an `.mkv` reprocess on every scan tick forever. They widened
together. TV has no equivalent check and converges via the payload-signature bump instead.

---

## 9. JIT emission · Status: **shipped P6**

Three fields per source, plus the same pair at title level describing the primary:

| Field | Meaning |
|---|---|
| `jitEligible` | The transcoder can serve this file **without the viewer losing anything** |
| `jitReason` | Why not, when `jitEligible` is false. `null` when it is. |
| `jitKey` | base64url of the transcoder-relative path — build variant/init URLs without re-deriving the encoding |
| `jitUrl` | `{base}/stream/{jitKey}/master.m3u8`. Only emitted when eligible **and** a public base URL is configured. |

Movies carry `urls.jitEligible` / `urls.jitUrl` beside `urls.mp4`; episodes carry them flat
beside `videoURL`. Each follows its own container's existing convention.

### Capability, not liveness

`jitEligible` says the transcoder *can* serve the file. It says nothing about whether the
service is up. **The client still health-checks and falls back to the raw URL** — do not treat
the flag or the URL as a liveness signal.

### The predicate

Deliberately narrower than "can the ladder decode this?", which is nearly always yes and
therefore useless. It asks whether routing the file through JIT is a strict improvement.

1. `!hostEnabled` → `host-disabled`
2. Container ∉ {mp4, m4v, mov, mkv, webm} → `container-unsupported`. **`.avi` is excluded** — still discoverable and directly playable, just never advertised.
3. No `videoCodec` or no `formatName` → `probe-incomplete`. **Fails closed.** A pre-v1.0011 sidecar cannot supply these, so the flag simply does not appear until it converges — which is why the probe bump and this rollout need no sequencing between them.
4. More than one distinct `audioLanguages` entry → `multi-audio-language`. The transcoder collapses multi-audio to one language via a process-global `JIT_AUDIO_LANG` with no per-request override, so JIT would silently drop languages direct playback exposes. **Lift when audio groups ship.**
5. Otherwise eligible.

**HDR and Dolby Vision do not disqualify** — the tone-map path is always present and PQ
passthrough is additive. **Interlaced does not disqualify** — `field_order` gates only the
zero-cost remux rung, never the ladder.

### Configuration

| Var | Default | Effect |
|---|---|---|
| `JIT_ELIGIBILITY_ENABLED` | `false` | Advertise capability at all. Folded into `payload_signature`, so flipping it plus one scan converges the library — and flipping back is the rollback. |
| `JIT_TRANSCODER_URL` | unset | **Public** base URL, reachable by end clients. Unset ⇒ no `jitUrl` anywhere, even for eligible files. |
| `JIT_SOURCE_PREFIX` | `''` | Prefix when `BASE_PATH` here and `JIT_SOURCE_DIR` there are not rooted alike. Empty is correct for the standard shared-volume topology. |

> **Security.** The transcoder is unauthenticated with permissive CORS, and `jitKey` is
> reversible base64. Publishing `JIT_TRANSCODER_URL` makes everything under its media root
> fetchable by anyone who can reach that host. Front it with something that authenticates, or
> keep it on a network where that is acceptable. Confirm this before enabling.

---

## 10. Non-goals and known gaps

- **`.avi` is discoverable and playable but will never be JIT-eligible** (P6). Annex-B
  demuxing through the transcode ladder is unverified.
- **`.ts` / `.m2ts` are not discovered at all.** Adding them is a one-line change to
  `VIDEO_EXTENSIONS` plus a MIME entry, deliberately deferred.
- **Subtitles are entirely this backend's job.** The transcoder emits no
  `EXT-X-MEDIA:TYPE=SUBTITLES` and no WebVTT — sidecar SRT only. A client playing through JIT
  must attach subtitle tracks itself.
- **Multi-audio collapses to one language** in the transcoder, selected by a process-global
  `JIT_AUDIO_LANG` with no per-request override. This is why multi-language sources will be
  marked ineligible in P6.
- **DASH is a 501 stub** in the transcoder. HLS only.
- **A title with several containers publishes ONE playable URL** (`urls.mp4` /
  `videoURL`) — the primary. The others are described in `sources[]` but the backend does not
  choose between them; that is the client's call. There is no per-source playback endpoint.
- **`fileNames` / `lengths` / `dimensions` are informational.** They are keyed by filename and
  now cover every container. `sources[].length` and `sources[].dimensions` are authoritative.

---

## 11. Payload versioning

Every scanned row stores a `payload_signature` — currently `` `${MEDIA_PAYLOAD_VERSION}:jit0|jit1` ``
(see [`node/lib/payloadVersion.mjs`](../node/lib/payloadVersion.mjs)).

It exists because the scanner's change-guard only fires when a title's `directory_hash` moves,
i.e. when the library changed **on disk**. A payload-shape change — a new field, or the JIT
toggle flipping — changes nothing on disk, so without the signature the scanner would compute
the new payload and then decline to store it. The bug looks like "works on my machine": a fresh
development database has no converged rows to skip.

Comparing the signature turns a version bump into **exactly one** library-wide convergence
pass, which then settles. It is also the only convergence driver for TV, which has no
equivalent of the movie scanner's `needsInfoRegeneration` check.

Bumping `MEDIA_PAYLOAD_VERSION`, or flipping `JIT_ELIGIBILITY_ENABLED`, therefore costs one
full re-scan and one full frontend resync. Schedule off-peak. Rollback is the same operation in
reverse.

The convergence pass is greppable: `media pivot: reprocessing <title> for payload signature
<old> -> <new>`. It must appear **once** per release, not on every scheduled tick — if it
recurs, something is rewriting a hashed input on every pass.

---

## 12. Change process

Any change to `sources[]`, to `mediaIdentity` semantics, or to the transcoder's route shape
requires a coordinated update to **both**
`nextjs-stream/docs/jit-transcoder/backend-jit-url-emission.md` and
`nextjs-stream/src/utils/videoIdentity.js`. The frontend parses these structures to key watch
history; an uncoordinated change orphans user progress.
