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
| **P1** | `epic/p1-media-resolution` | **Container-agnostic discovery (this document's §1–§3)** |
| P2 | `epic/p2-info-sidecar` | `.info` sidecar v1.0011 — probe fields for eligibility |
| P3 | `epic/p3-media-identity` | `mediaIdentity` + `.mediaid.json` sidecar |
| P4 | `epic/p4-container-sources` | `urls.sources[]`, MKV/MOV titles become visible |
| P5 | — (frontend) | Identity cutover + WatchHistory remediation |
| P6 | `epic/p6-jit-emission` | `jitEligible`, `jitKey`, `jitUrl` |

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
| *(P3)* **Identity derived from the played URL** | A rename, remux, or container swap orphaned watch history | `mediaIdentity.id` from a sidecar on the media volume |
| *(P6)* **Frontend-constructed JIT URLs** | The backend is co-located with the transcoder and already knows the media root | Backend emits `jitUrl` |

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

## 4. Movie payload

`GET /media/movies` → `urls`:

| Field | Type | Status | Notes |
|---|---|---|---|
| `mp4` | string | shipped | **Legacy name.** The primary source URL, whatever its container — for an MKV-only title this ends in `.mkv`. It is a *locator*, never a container claim. New code should read `identityUrl` and `sources[]`. |
| `mediaLastModified` | ISO string | shipped | mtime of the primary source. Drives the incremental hash sweep. |
| `subtitles`, `chapters`, `poster`, `backdrop`, `logo`, `metadata` | — | shipped | Unchanged by this pivot |
| `identityUrl` | string | **planned P3** | Exact alias of `mp4`. Present so the two can diverge later without another migration. |
| `sources[]` | array | **planned P4** | Every video file for this title — see §6 |

`jitEligible` (boolean) and `mediaIdentity` (object) sit at the movie level, beside `urls`.

## 5. TV payload

`GET /media/tv` → `seasons[<Season Name>].episodes[<key>]`:

| Field | Type | Status | Notes |
|---|---|---|---|
| `filename` | string | shipped | Basename with extension |
| `videoURL` | string | shipped | Primary source URL — the TV counterpart of `urls.mp4` |
| `_id` | string | shipped | `info.uuid`, a mediainfo header hash. **Per file**, so it varies by container and rotates on re-encode. |
| `mediaIdentity`, `sources[]`, `jitEligible`, `jitUrl` | — | **planned P3/P4/P6** | Flat on the episode object |

**Episodes carry flat fields by design and will not gain a `urls` bag.** Nesting them would
reshape a hot payload and change the input shape of `generateTVShowHashes`, forcing a resync
for no benefit.

---

## 6. `sources[]` · Status: **planned P4**

One entry per video file in the title's folder.

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
  "jitEligible": "boolean",
  "jitKey": "string|null",
  "jitUrl": "string|null"
}
```

**Ordering is a hard contract**, not cosmetic: `movies.urls` is folded wholesale into the
movie hash, so a `readdir`-order-dependent array would make that hash flap between scans and
force a permanent resync loop. Sorted by `VIDEO_EXTENSIONS` index, then by filename.

**Invariants:** exactly one `isPrimary: true` when the array is non-empty; that entry's `url`
equals `urls.mp4`; an empty array means no `urls.mp4` at all.

**`directPlayLikely` is deliberately not emitted.** Whether the transcoder can remux rather
than re-encode depends on `JIT_DIRECT_PLAY`, `JIT_HDR`, segment-size floors, and a keyframe
map — all transcoder-side config this backend cannot observe. The raw facts above let any
consumer recompute it; a derived boolean would silently rot.

---

## 7. Non-goals and known gaps

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
- The scanner still filters video files with `.mp4` checks until P4 — **P1 fixed the serving
  and derived-asset paths, not discovery.** An MKV-only title is reachable through
  `/frame`, `/videoClip`, `/spritesheet`, and `/chapters`, but does not yet appear in
  `/media/movies` or `/media/tv`.

---

## 8. Change process

Any change to `sources[]`, to `mediaIdentity` semantics, or to the transcoder's route shape
requires a coordinated update to **both**
`nextjs-stream/docs/jit-transcoder/backend-jit-url-emission.md` and
`nextjs-stream/src/utils/videoIdentity.js`. The frontend parses these structures to key watch
history; an uncoordinated change orphans user progress.
