# Auto-Generated Captions (MVP: English)

On-demand subtitle generation for movies and TV episodes using a local
whisper.cpp backend, gated by a flag in `app_config.settings`, with a
dedicated health check and round-trip discovery via the existing scanner.

## 1. Goals & non-goals

**Goals**
- `POST /api/admin/captions/generate` to enqueue a transcription job for a
  given movie or episode, language `en` only.
- `GET /api/captions/health` exposing engine readiness, queue depth, and last
  success/failure.
- `app_config.settings` flag controlling whether the feature is active and
  which language codes are allowed.
- Output written to disk as `{base}.{lang}.auto.srt` next to the source `.mp4`,
  picked up by the next scan and surfaced as `English - Auto Generated` in the
  scanner output (alongside any human subtitles, not replacing them).

**Non-goals (MVP)**
- Translation (source language → other language).
- Languages other than English (the whisper model auto-detects, but we only
  emit and label `en` for MVP).
- Speaker diarization, word-level timestamps, hearing-impaired flag.
- Auto-triggering on scan or on import. Generation is admin-initiated only.
- GPU acceleration. CPU-only via whisper.cpp; GPU is a follow-up.

## 2. Engine: whisper.cpp

- Binary: `whisper-cli` (built from [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)).
- Model: `ggml-base.en.bin` (~150 MB) — best speed/quality tradeoff for
  English MVP. Larger models (`small.en`, `medium.en`) selectable via env.
- Output format: SRT (`whisper-cli -osrt`) — matches existing scanner exactly.
- Audio extraction: existing `executeFFmpeg` ([node/ffmpeg/ffmpeg.mjs:8](node/ffmpeg/ffmpeg.mjs#L8))
  to produce `16 kHz mono PCM WAV`, which is whisper.cpp's required input.

### Dockerfile additions

In the **builder** stage of [Dockerfile](Dockerfile), after the existing
`apk add` block, build whisper.cpp:

```dockerfile
RUN apk add --no-cache cmake git && \
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /tmp/whisper.cpp && \
    cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_EXAMPLES=ON && \
    cmake --build /tmp/whisper.cpp/build --target whisper-cli -j && \
    install -m755 /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli && \
    rm -rf /tmp/whisper.cpp
```

In the **production** stage, add a model directory and download the default
model lazily on first use (rather than baking it into the image — keeps image
size down, lets users pick model via env without a rebuild):

```dockerfile
RUN mkdir -p /usr/src/app/whisper-models && chown 1000:1000 /usr/src/app/whisper-models
COPY --from=builder /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
```

Model auto-download is handled in Node at startup (see §6 health check).

## 3. New / modified files

```
node/
├── lib/
│   └── whisper.mjs                     [NEW] engine wrapper, model mgmt, runner
├── components/
│   └── caption-generator/              [NEW] feature module (3-tier per repo convention)
│       ├── index.mjs                   public API
│       ├── data-access/
│       │   └── caption-config.mjs      app_config.settings reads
│       ├── domain/
│       │   ├── audio-extractor.mjs     ffmpeg → 16kHz mono WAV
│       │   ├── srt-postprocess.mjs     normalize whisper.cpp SRT output
│       │   └── target-resolver.mjs     {movie,tv}+langCode → mp4Path, srtPath
│       └── entry-points/
│           └── caption-controller.mjs  enqueue + health
├── routes/
│   └── captions.mjs                    [NEW] /api/admin/captions/*, /api/captions/health
├── components/media-scanner/domain/
│   ├── movie-scanner.mjs               [MOD] processSubtitles: detect ".auto" token
│   └── tv-scanner.mjs                  [MOD] processEpisodeSubtitles: detect ".auto" token
├── lib/taskManager.mjs                 [MOD] add TaskType.CAPTION_GENERATE
└── routes/index.mjs                    [MOD] mount captions router
```

The existing `langMap` constant lives in two places already
([app.mjs:213](node/app.mjs#L213) and [admin.mjs:549](node/routes/admin.mjs#L549)).
We will **not** add a third copy — the resolver imports `getLanguageCode` from
`admin.mjs` (or factors it out to `utils/languageMap.mjs` as a small cleanup,
TBD with reviewer).

## 4. `app_config.settings` schema

New document, default-inserted on first boot in
[database.mjs](node/database.mjs) alongside `checkAutoSync`:

```js
{
  name: "autoCaptions",
  value: {
    enabled: false,                 // master switch (default off — opt-in)
    languages: ["en"],              // allowed target languages
    model: "base.en",               // whisper.cpp model name (no .bin, no ggml- prefix)
    threads: 4,                     // whisper-cli -t
    maxConcurrent: 1                // queue depth, enforced by taskManager
  }
}
```

Helper in `data-access/caption-config.mjs`:

```js
export async function getAutoCaptionsConfig() { ... }
export async function isLanguageEnabled(langCode) { ... }
```

Mirrors the `checkAutoSync()` pattern at
[database.mjs:232-253](node/database.mjs#L232-L253) — auto-creates the doc with
defaults if absent.

## 5. API surface

### `POST /api/admin/captions/generate`

Auth: `authenticateUser + requireAdmin` (matches sibling admin routes).

**Request**

```json
{
  "mediaType": "movie" | "tv",
  "mediaTitle": "The Movie",
  "language": "en",
  "season": "1",            // tv only
  "episode": "1",           // tv only
  "force": false            // overwrite existing .auto.srt (default false)
}
```

**Response (202 Accepted)**

```json
{
  "success": true,
  "queued": true,
  "jobId": "cap-1746460800000-1",
  "expectedPath": "/var/www/html/movies/The Movie/The Movie.en.auto.srt"
}
```

**Response (409 Conflict)** when `force=false` and target already exists.
**Response (400)** when language not in `app_config.autoCaptions.languages`.
**Response (503)** when feature disabled.

Implementation: validates → resolves source `.mp4` path (reuse the file-finding
logic from [admin.mjs:74-121](node/routes/admin.mjs#L74-L121)) → computes
`{base}.{lang}.auto.srt` target → enqueues via `enqueueTask(TaskType.CAPTION_GENERATE, ...)`
→ returns immediately with the job id. The route does **not** await the task.

### `GET /api/captions/health`

Auth: `authenticateWebhookOrUser` (mirrors `/api/system-status`).

```json
{
  "status": "ready" | "disabled" | "degraded" | "unavailable",
  "enabled": true,
  "engine": {
    "binary": "/usr/local/bin/whisper-cli",
    "binaryPresent": true,
    "model": "base.en",
    "modelPath": "/usr/src/app/whisper-models/ggml-base.en.bin",
    "modelPresent": true,
    "modelSizeBytes": 147951465
  },
  "languages": ["en"],
  "queue": {
    "active": 0,
    "queued": 0,
    "lastSuccessAt": "2026-05-04T22:11:09.123Z",
    "lastFailureAt": null,
    "lastFailureReason": null
  },
  "timestamp": "2026-05-05T00:00:00.000Z"
}
```

Status mapping:
- `disabled` — flag off in `app_config.settings`.
- `unavailable` — flag on but binary or model missing.
- `degraded` — last job failed and no success since.
- `ready` — all green.

### `GET /api/admin/captions/jobs/:jobId` *(optional, low cost)*

Returns task status by id. The existing `getTaskStatus()`
([taskManager.mjs:240](node/lib/taskManager.mjs#L240)) already exposes
active/queued/history per type — add a small in-memory map keyed by `jobId` so
clients can poll a single job. **Cut from MVP if time-constrained**; clients
can poll `/api/tasks` instead.

## 6. Filename convention & scanner change

**Convention**: `{base}.{langCode}.auto.srt` and (future)
`{base}.{langCode}.auto.hi.srt`. The `auto` token sits between the language
code and the `srt` extension, so the existing dot-split parser already gets
the right `langCode` — we just need to recognize the `auto` token and adjust
the display key.

**Patch to [movie-scanner.mjs:183-207](node/components/media-scanner/domain/movie-scanner.mjs#L183-L207):**

```diff
   for (const file of fileNames) {
     if (file.endsWith('.srt')) {
       const filePath = join(dirPath, dirName, file);
       const encodedFilePath = encodeURIComponent(file);
       const parts = file.split('.');
       const srtIndex = parts.lastIndexOf('srt');
-      const isHearingImpaired = parts[srtIndex - 1] === 'hi';
-      const langCode = isHearingImpaired ? parts[srtIndex - 2] : parts[srtIndex - 1];
+      // tokens after the language code, before "srt"
+      const trailingTokens = new Set();
+      let cursor = srtIndex - 1;
+      while (cursor >= 0 && (parts[cursor] === 'hi' || parts[cursor] === 'auto')) {
+        trailingTokens.add(parts[cursor]);
+        cursor--;
+      }
+      const langCode = parts[cursor];
+      const isHearingImpaired = trailingTokens.has('hi');
+      const isAutoGenerated = trailingTokens.has('auto');
       const langName = langMap[langCode] || langCode;
-      const subtitleKey = isHearingImpaired ? `${langName} Hearing Impaired` : langName;
+      let subtitleKey = langName;
+      if (isHearingImpaired) subtitleKey += ' Hearing Impaired';
+      if (isAutoGenerated) subtitleKey += ' - Auto Generated';

       subtitles[subtitleKey] = {
         url: `${prefixPath}/movies/${encodedDirName}/${encodedFilePath}`,
         srcLang: langCode,
+        autoGenerated: isAutoGenerated,
         lastModified: (await fs.stat(filePath)).mtime.toISOString()
       };
     }
   }
```

Identical change to
[tv-scanner.mjs:184-199](node/components/media-scanner/domain/tv-scanner.mjs#L184-L199).
The new `autoGenerated` boolean lets the frontend visually distinguish them
without parsing the key string.

This is order-independent (`name.en.auto.srt` and `name.en.auto.hi.srt` both
parse correctly) and **fully backward-compatible** — existing files with no
`auto`/`hi` tokens hit `cursor = srtIndex - 1` and behave exactly as before.

## 7. Generation pipeline

`enqueueTask(TaskType.CAPTION_GENERATE, name, async () => { ... })`:

1. **Read config** — `getAutoCaptionsConfig()`. Bail if disabled or language
   not allowed.
2. **Resolve target** — locate source `.mp4`, compute final `.auto.srt` path.
   Reject if exists and `force=false`.
3. **Ensure model** — if `whisper-models/ggml-{model}.bin` missing, download
   from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin`
   to a `.tmp` and rename atomically. Subsequent calls are no-ops.
4. **Extract audio** — to a temp file in the existing `node/cache/` tree
   (e.g. `node/cache/captions/{hash}.wav`):

   ```
   ffmpeg -y -i <mp4> -vn -ac 1 -ar 16000 -c:a pcm_s16le <tempWav>
   ```
5. **Run whisper-cli**:

   ```
   whisper-cli -m <modelPath> -f <tempWav> -l en -t <threads> -osrt -of <tempBase>
   ```

   Produces `<tempBase>.srt`.
6. **Post-process** ([srt-postprocess.mjs]):
   - Strip whisper.cpp's leading `[BLANK_AUDIO]` / `[ ]` markers.
   - Trim leading/trailing whitespace per cue.
   - Drop empty cues.
   - Verify cue count > 0 — fail loudly if empty (likely silent track).
7. **Atomic write** — write to `<finalPath>.tmp`, then `fs.rename` to
   `<finalPath>`. This avoids the scanner picking up a half-written file.
8. **Cleanup** — remove temp WAV. Update last-success timestamp in the
   in-memory health state.

Concurrency: `concurrencyLimits[TaskType.CAPTION_GENERATE] = config.maxConcurrent`
(default 1, configurable). **Add to the existing exclusivity group** at
[taskManager.mjs:42](node/lib/taskManager.mjs#L42)? No — caption gen does not
touch the DB or read whole library trees, so it can run alongside scans. Leave
it independent.

Failure handling: on any step failure, log via `createCategoryLogger('captions')`,
update health's `lastFailureAt` / `lastFailureReason`, ensure temp WAV is
deleted, and let the task promise reject (taskManager already logs and
processes the next task).

## 8. Edge cases worth pre-deciding

| Case | Behavior |
|---|---|
| User-authored `Title.en.srt` already exists | Generation still produces `.auto.srt` separately; both surface in scanner with distinct keys. |
| User adds `Title.en.auto.srt` manually | Treated identically — `auto` is a filename convention, not a DB-recorded provenance. By design. |
| MP4 file has no audio stream | ffmpeg step fails fast; reported as `degraded` in health with reason. |
| Model download fails mid-stream | Atomic rename ensures the partial file isn't seen as present; next request retries. |
| Two requests for same target collide | Second request hits "already exists" if first finished, or queues behind it (taskManager doesn't dedupe by name — acceptable for MVP, doc as known limitation). |
| Long episodes | whisper.cpp `base.en` is ~5–10× realtime CPU-only. A 45-min episode = 4–9 min on a modern 4-core. Health check exposes queue depth so admins see backups. |

## 9. Test plan

- **Unit** — `srt-postprocess.test.mjs`: golden whisper output → expected SRT.
- **Unit** — scanner subtitle parser: `Title.en.srt`, `Title.en.hi.srt`,
  `Title.en.auto.srt`, `Title.en.auto.hi.srt` all produce expected keys and
  `autoGenerated` flag.
- **Unit** — `caption-config.mjs`: defaults inserted on first read; disabled
  flag rejects requests.
- **Integration** — full pipeline against a 30-second test clip
  (`scripts/tests/fixtures/short_clip.mp4`, to be added) with the `tiny.en`
  model. Skip if `WHISPER_BIN` env not set, like the TMDB integration tests.
- **Manual** — generate captions for a real episode, run a scan, confirm the
  episode's `subtitles` map contains `English - Auto Generated`.

## 10. Rollout

1. Land scanner parser change first (backward compatible, no new behavior) —
   ship in its own PR.
2. Land settings flag + Dockerfile + `whisper.mjs` engine wrapper + health
   check + (disabled-by-default) feature.
3. Land generation endpoint, behind the flag.
4. Flip flag in dev, verify, then prod.

## 11. JIT (just-in-time) generation — extends the MVP

The admin-only generation flow above is for ops/manual backfill. The
**primary trigger** is JIT: generate when an authenticated user actually picks
the auto track in the player. This avoids transcribing the long tail of media
that never gets watched.

### 11.1 Design pillars

- **Auth split**: anyone (incl. unauthenticated) can *read* an existing
  `.auto.srt` via the track endpoint — matches how mp4 streaming works.
  Only the *enqueue-if-missing* branch requires auth + a per-user rate limit.
- **Dedupe by `(videoPath, langCode)`**: concurrent picks for the same media
  share one job. Lookup → in-flight job? → file on disk? → enqueue.
- **Memory-only job state**: in-process `Map<jobId, jobState>` and
  `Map<dedupeKey, jobId>`. Lost on restart, which is fine — the SRT file is
  the durable record, and re-enqueue is cheap and self-healing.
- **Always offer auto-gen as an alternative track**: even when a human
  `Title.en.srt` exists, the scanner emits `English - Auto Generated`
  alongside it. Distinct keys keep them separate in the player's track list,
  letting users switch to the auto track if the human one is wrong, missing
  cues, or out of sync. Generation is only blocked when an `.auto.srt`
  already exists for that language (409 unless `force=true`).
- **Always emit stub entries during scan**: when `autoCaptions.enabled` and a
  configured language has neither human nor `.auto` SRT for an item, emit
  `{ url: <track-endpoint>, srcLang, autoGenerated: true, pending: true,
  lastModified omitted }` in the scanner output so the option is discoverable
  from the UI before any generation runs.

### 11.2 Endpoints

#### `GET /api/captions/track/movie/:title/:lang`
#### `GET /api/captions/track/tv/:show/:lang/:season/:episode`

Auth: `authenticateWebhookOrUser` for the *trigger* path; the *read* path
serves the SRT to anyone.

Behavior:
- File exists on disk → **`302` redirect** to the static URL
  (`${PREFIX_PATH}/movies/...` or `/tv/.../Season X/...`) so nginx/CDN serves
  the bytes. The redirect itself sends `Cache-Control: public, max-age=300`
  so repeat plays bypass Node entirely. Stable across the lifetime of the
  file — the path doesn't change once written.
- File missing + feature disabled / lang not allowed → `404` (anonymous) or
  `503` (authed, with explicit reason).
- File missing + authed + within rate limit → enqueue (or attach to existing
  in-flight job), respond `202` with body:
  ```json
  {
    "status": "queued" | "running",
    "jobId": "cap-...",
    "queuePosition": 3,
    "pollUrl": "/api/captions/jobs/cap-..."
  }
  ```
- Authed + rate-limited → `429` with `Retry-After`.

#### `GET /api/captions/jobs/:jobId`

Auth: none — job IDs are unguessable (`cap-{ts}-{8 hex}`). Returns:

```json
{
  "jobId": "cap-1746460800000-7a3f1e22",
  "status": "queued" | "running" | "succeeded" | "failed",
  "queuePosition": 2,
  "progressPct": 0.42,
  "expectedPath": "/var/www/html/movies/.../Title.en.auto.srt",
  "createdAt": "...",
  "completedAt": null,
  "error": null
}
```

`progressPct` parsed from whisper-cli's per-segment timestamp output
(`[hh:mm:ss.xxx --> hh:mm:ss.xxx]`) divided by total audio duration. Falls back
to `null` until the first segment is logged.

### 11.3 Rate limit

Per-user, **10 jobs/hour**, in-memory sliding window keyed by `req.user.id`.
Configurable via env (`CAPTIONS_RATE_LIMIT_PER_HOUR`). Applied only to the
*enqueue* branch of the track endpoint and to the admin `POST` endpoint.
Reads of existing files bypass entirely.

### 11.4 Scanner stub entries

In `processSubtitles` ([movie-scanner.mjs](node/components/media-scanner/domain/movie-scanner.mjs))
and `processEpisodeSubtitles` ([tv-scanner.mjs](node/components/media-scanner/domain/tv-scanner.mjs)),
after the existing loop:

1. If `autoCaptionsConfig` not yet loaded for this scan, load once and pass
   through (cache via the controller arg, not per-item).
2. For each lang in `config.languages`:
   - If `subtitles["{Language} - Auto Generated"]` already exists (because a
     real `.auto.srt` was found on disk) → skip, don't shadow the real entry.
   - Else emit `subtitles["{Language} - Auto Generated"] = { url: <track URL>,
     srcLang, autoGenerated: true, pending: true }`. **Coexists** with any
     human-authored same-lang entry under the distinct `English` key.

The track URL prefix is **deployment-controlled** via env var, not hard-coded:

- Default: `${FILE_SERVER_NODE_URL}/api/captions/track` — player hits this
  processor directly. Auth via session cookie (cross-domain) or
  `Authorization: Bearer`. CDN serves cached `.auto.srt` files via the 302
  branch.
- Override via `CAPTIONS_TRACK_URL_PREFIX` to point at a Next.js (or any
  proxy) route — useful for centralizing auth, edge caching, or hiding the
  processor URL from the browser.

The path shape stays fixed across deployments so a proxy can route on it:
`/movie/:title/:lang` and `/tv/:show/:lang/:season/:episode`. The proxy is
responsible for translating to/from this shape (e.g. its own
`/api/authenticated/subtitles?title=...&auto=true` form).

**Cross-repo decision required**: the Next.js team owns whether to set
`CAPTIONS_TRACK_URL_PREFIX` and proxy, or leave it blank and let the player
hit the processor directly. Both work — direct is simpler, proxy is more
flexible. No processor-side code change either way.

### 11.5 Startup orphan sweep

On app boot, the caption-generator init removes stale `*.wav` and orphan SRT
output files older than 1 hour from `CAPTIONS_TMP_DIR`, since restarts may
have left them behind. One-time, fire-and-forget.

### 11.6 Health additions

The existing `GET /api/captions/health` payload gains:
- `queue.maxJobsPerUserPerHour: number`
- `queue.activeJobs: [{ jobId, dedupeKey, status, progressPct }]` (top N for
  observability).

## 12. GPU acceleration

Whisper.cpp's GPU backend is selected at compile time, so each variant is a
separate Docker image. Three image variants are planned, two are built:

| Tag suffix | Backend | Speedup | Hardware | Status |
|---|---|---|---|---|
| (none, default) | CPU | 1× | Any | Built |
| `-vulkan` | Vulkan | 3–5× | Intel ARC/iGPU, AMD, NVIDIA-via-toolkit | Built |
| `-cuda` | CUDA | 10–30× | NVIDIA only | Stub ([Dockerfile.cuda](Dockerfile.cuda)) |

### How it's wired

- **`Dockerfile`** accepts `--build-arg WHISPER_GPU=none|vulkan`. CPU and
  Vulkan share the alpine base. The cmake invocation toggles `-DGGML_VULKAN=ON`
  and the production stage installs `vulkan-loader mesa-vulkan-intel
  mesa-vulkan-radeon` only when `vulkan` is selected. Build args:
  ```bash
  docker build -f Dockerfile --build-arg WHISPER_GPU=none   -t <repo>:<tag> .
  docker build -f Dockerfile --build-arg WHISPER_GPU=vulkan -t <repo>:<tag>-vulkan .
  ```
- **`Dockerfile.cuda`** is currently a stub with a header explaining the
  planned implementation (base image swap to `nvidia/cuda:12-runtime-ubuntu22.04`,
  apt instead of apk, manual NodeJS install, `-DGGML_CUDA=ON` cmake flag).
  Until built out, `build.ps1 -Variant cuda` exits early with a friendly error.
- **`build.ps1`** takes `-Variant cpu|vulkan|cuda`, defaults to `cpu`. Tags
  CPU as `:YYYY.MM.DD` + `:latest` (backward compat) and GPU variants as
  `:YYYY.MM.DD-${variant}` + `:latest-${variant}`.

### Runtime requirements per variant

| Variant | Host requirements | Compose additions |
|---|---|---|
| CPU | none | none |
| Vulkan, Intel ARC/iGPU | Intel GPU + i915 kernel module | `devices: ['/dev/dri:/dev/dri']` and `group_add: [video]` (or `render`) |
| Vulkan, AMD | amdgpu kernel module + Mesa on host | same `/dev/dri` passthrough |
| Vulkan, NVIDIA | NVIDIA proprietary driver + [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) | `runtime: nvidia` and `deploy.resources.reservations.devices: [{driver: nvidia, count: all, capabilities: [gpu]}]` |
| CUDA *(stub)* | NVIDIA proprietary driver + Container Toolkit | same as Vulkan-NVIDIA |

### Health visibility

`/api/captions/health` reports `engine.gpuBackend` (`none` / `vulkan` / `cuda`)
sourced from the `WHISPER_GPU_BACKEND` env var, which the Dockerfile sets from
the build arg. Operators can confirm the running container's backend without
inspecting the image tag.

### Verifying a Vulkan image works at runtime

After deploying the `:vulkan` tag with the device passthrough, two checks:

1. `docker exec <container> vulkaninfo --summary | head -30` — should list at
   least one `physicalDevice` (Intel ARC, AMD, or NVIDIA depending on host).
2. Trigger a generation and watch logs: whisper-cli prints `vulkan: <gpu name>`
   on startup when the backend is active. CPU-only builds print no such line.

If `vulkaninfo` shows no devices but the image is `:vulkan`, the issue is host
driver / device-passthrough — not the image.

## 13. Out-of-scope follow-ups

- GPU build of whisper.cpp (CUDA / Vulkan) for 10–30× speedup.
- Auto-trigger generation when scanner finds an MP4 with no subtitles in any
  enabled language.
- Translation pass (`-l {target}` with whisper's `--task translate`).
- Hearing-impaired pass (with non-speech token retention).
- Per-show / per-movie opt-out via a sentinel file or DB flag.
- Word-level timestamps for richer frontend UX.
