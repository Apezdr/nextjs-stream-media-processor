# Backend Architecture — nextjs-stream-media-processor

The verified product-design reference for this backend: what each subsystem owns, the split between **ground truth** on disk and **derived state** in SQLite (plus a third MongoDB tier), and the full lifecycle of every **keypoint** — the entities the backend is responsible for keeping correct. It exists so that a maintainer changing one stage of a lifecycle can see every other stage that depends on it before shipping. A companion open-questions/decision log tracks everything known to be wrong, undecided, or deliberately accepted; decided-but-unshipped changes are labeled **"Decided 2026-07-07 — not yet implemented"** throughout and are *not* current behavior.

**Contents**

- [0. Purpose, scope, and status of existing documentation](#0-purpose-scope-and-status-of-existing-documentation)
- [1. Ground truth vs. derived state](#1-ground-truth-vs-derived-state)
- [2. System map](#2-system-map)
- [3. Keypoint lifecycle catalog](#3-keypoint-lifecycle-catalog)
- [4. Contracts & boundaries between subsystems](#4-contracts--boundaries-between-subsystems)
- [Appendix A — HTTP endpoint inventory](#appendix-a--http-endpoint-inventory)
- [Appendix B — `tmdb.config` field reference](#appendix-b--tmdbconfig-field-reference)
- [Appendix C — Glossary](#appendix-c--glossary)

## 0. Purpose, scope, and status of existing documentation

### 0.1 What this document is

This document is a verified description of the backend's intended product design: what each subsystem owns, the split between ground truth and derived state, and the full lifecycle of every **keypoint** — the entities this backend is responsible for keeping correct (movies and TV shows, seasons and episodes, `tmdb.config` files, `metadata.json` files, image files, SQLite rows, metadata hashes, and cooldown bookkeeping). It exists so that a maintainer changing one stage of a lifecycle can see every other stage that depends on it before shipping.

It describes the current code, in which all TMDB metadata and image work runs natively in Node (the earlier Python TMDB pipeline has been removed; the only Python left in the repo is the standalone `scripts/generate_poster_collage.py` utility, still scheduled from `node/app.mjs`). Every behavioral claim in this document was checked against the source tree it describes; claims are cited as a repo-relative path plus a function or symbol name, e.g. `node/lib/metadataGenerator.mjs` `generateForShow()`. Line numbers are deliberately never cited — they rot.

### 0.2 What this document is not

- **Not an API reference.** Endpoints are mentioned only where they define a contract or a lifecycle transition, plus a route-level inventory in Appendix A. There is no exhaustive request/response catalog here.
- **Not a deployment or operations guide.** Docker images, GPU builds, environment provisioning, and monitoring setup are out of scope (see `build-scripts-README.md` and `docs/OPENTELEMETRY_GUIDE.md`).
- **Not a changelog.** Historical fixes are referenced only when the scar tissue explains a current design rule.

### 0.3 How to read this document

**Ground-truth / derived-state tags.** Every keypoint in the lifecycle catalog carries one of two tags:

| Tag | Meaning |
|---|---|
| `ground truth` | Lives on the filesystem (media directories, `metadata.json`, `tmdb.config`, image files). Authoritative. Never reconstructed from SQLite. |
| `derived state` | Lives in SQLite. Rebuildable from disk; fed one-way from the filesystem, never the reverse. |

A small class of SQLite tables (retry cooldowns, bot action history) is tagged `derived state` but is genuinely **not** derivable from disk — the one real exception to the rebuildability rule. Each such case is flagged inline where it appears.

**Planned-change labels.** Design decisions that have been made but not yet shipped are labeled **"Decided 2026-07-07 (ID) — not yet implemented."** Anything carrying that label is *not* current behavior: the code still exhibits the pre-decision behavior until the label is removed from this document. The parenthesized IDs (`G-*`, `R-*`, `I-*`, `T-*`, `P-*`, `F-*`, `A-*`, `S-*`, `C-*`, `B-*`, `V-*`, `M-*`, `D-*`, `SEC-*`) are stable identifiers for individual reviewed findings and decisions and are used consistently throughout this document and its companion open-questions material.

**Tense convention.** Declarative present tense always means "what the checked-in code does today." Future or planned behavior only ever appears under a "Decided 2026-07-07 — not yet implemented" label.

**Terminology.** One term per concept, used consistently: **freeze** (the `update_metadata: false` switch — see Appendix C), **pristine base** (the raw pre-override TMDB snapshot — column and population shipped with Branch 1 in this tree; its trust semantics remain planned), **ground truth**, and **derived state**.

### 0.4 Status of existing documentation

The repo carries earlier documentation of mixed reliability. The table below records, for each pre-existing file, whether it can still be trusted and what should happen to it. Verdicts: **accurate** (safe to rely on), **superseded** (replaced by this document or another; do not rely on it), **partially wrong** (contains claims contradicted by current code), **historical** (a closed incident or implementation log, correct for its time but not a living reference). File existence and each verdict's supporting claim were re-checked against the current tree.

| File | Verdict | Why | Recommended action |
|---|---|---|---|
| `docs/ENTERPRISE_SCANNER_ARCHITECTURE.md` | superseded | Describes a `media_scan_state` / rate-limiter / priority-queue scanner design that was never built — `media_scan_state` has zero occurrences anywhere under `node/`. | Delete or move to `docs/archive/` once this document lands. |
| `docs/TMDB_API.md` | partially wrong | Documents the media id as a path parameter (e.g. `GET /api/tmdb/details/:type/:id`), but the implemented routes in `node/routes/tmdb.mjs` are `/details/:type` etc., taking the id/name as query parameters. Also still references the removed Python scripts. | Rewrite against `node/routes/tmdb.mjs`, or archive. |
| `docs/TMDB_BLURHASH_ENHANCEMENT.md` | partially wrong | Still describes a Python blurhash path; blurhash generation is native Node (`node/utils/blurhashNative.mjs`). | Strip the Python references, then use as source material for the image-pipeline section. |
| `docs/TMDB_DATABASE_INITIALIZATION_FIX.md` | historical | Closed incident write-up. | Move to `docs/archive/`. |
| `docs/SESSION_CACHE_IMPLEMENTATION.md` | historical | Implementation log for shipped work; `docs/SESSION_CACHE.md` is the living reference. | Move to `docs/archive/`. |
| `docs/AUTHENTICATION_SYSTEM.md` | accurate | Live subsystem reference. | Link from this document; do not duplicate. |
| `docs/SESSION_CACHE.md` | accurate | Live subsystem reference. | Link; do not duplicate. |
| `docs/SYSTEM_STATUS.md` | accurate | Live subsystem reference. | Link; do not duplicate. |
| `docs/OPENTELEMETRY_GUIDE.md` | accurate | Live observability reference. | Link; do not duplicate. |
| `build-scripts-README.md` | accurate | Live build reference. | Link; do not duplicate. |
| `README.md` | partially wrong | The Windows local-development section still instructs installing MSVC build tools and `blurhash-python`; that pipeline is removed. `requirements.txt` is now scoped to the single remaining Python utility, `scripts/generate_poster_collage.py`. | Rewrite the local-setup section for the Node-native pipeline. |
| `plans/AIR_DATE_AWARE_EPISODE_BACKFILL.md` | accurate — shipped, mis-filed | Describes behavior that is live: the `episode_metadata_missing` cooldown table and backfill logic exist in `node/sqliteDatabase.mjs` and are driven from `node/components/media-scanner/domain/tv-scanner.mjs`. Sitting in `plans/` wrongly implies "not done yet." | Absorb into the keypoint lifecycle catalog; move the file to `plans/done/`. |
| `plans/ELIMINATE_SEASON_EPISODE_FILESYSTEM_IO.md` | accurate — shipped, mis-filed | The optimization it proposes is live: the `getTVShows()` read path in `node/sqliteDatabase.mjs` performs no `fs.stat` calls; image hashes are embedded into URLs at scan time by the TV scanner. | Absorb; move to `plans/done/`. |
| `plans/TV_METADATA_STALENESS_HARDENING.md` | accurate — backend phases shipped, mis-filed | Its backend phases are live: `generateTVShowHashes()` in `node/sqlite/metadataHashes.mjs` folds parsed metadata content into the show hash (Phase 1A); `getTVShows()` in `node/sqliteDatabase.mjs` cache-busts `metadata_path` with `directory_hash` (Phase 1B); episode metadata URLs carry a hash token at scan time in `node/components/media-scanner/domain/tv-scanner.mjs` (Phase 2A). Phases 1C/2B target the separate `nextjs-stream` frontend repo and are not verifiable from this tree. | Absorb the backend parts; move to `plans/done/` with a note that the frontend phases live in `nextjs-stream`. |
| `plans/BACKDROP_FOCAL_PLACEMENT.md` | partially wrong | Its library comparison rejects `@vladmandic/face-api` as archived and recommends alternatives — but the shipped detector, `node/utils/backdropFocalDetector.mjs`, loads its models from the `@vladmandic/face-api` package. | Correct the library-selection section to match the shipped choice, then fold in. |
| `plans/AUTO_GENERATED_CAPTIONS.md` | accurate — mostly shipped (~90%) | The bulk of the design is implemented: the `node/components/caption-generator/` component (domain, entry-points, data-access), `node/lib/whisper.mjs`, `node/routes/captions.mjs`, and unit tests all exist. This plan must not be bucketed with unbuilt plans. | Absorb the shipped parts into the captions subsystem section; track only the genuinely unshipped remainder as backlog. |
| `node/integrations/discord/MEDIA_ADMIN_COMMANDS_PLAN.md` | partially wrong — self-reports 100% complete; roughly 6% is shipped | Its own 17-item checklist marks every item done, including nine `/media` subcommands — but `node/integrations/discord/commands/` contains only `help.mjs`, `ping.mjs`, `status.mjs`, and `tasks.mjs`. No `/media` command exists. Decided 2026-07-07 (D-2): relabel this plan as backlog; nothing in this document may cite it as shipped behavior. | Correct the checklist to reflect reality and relabel as backlog. |
| `plans/OPENTELEMETRY_INSTRUMENTATION.md`, `plans/OTEL_QUICK_REFERENCE.md`, `plans/SQLITE_OPENTELEMETRY_INTEGRATION.md` | superseded | Replaced by `docs/OPENTELEMETRY_GUIDE.md`; observability plumbing is out of scope for this product-design document. | Leave in place or archive; do not fold in. |

## 1. Ground truth vs. derived state

The headline principle of this backend: **a small, well-defined set of files on disk is ground truth; almost everything else — SQLite rows, hashes, sidecars, cache directories — is derived state that can be rebuilt from it.** Data flows one way, from disk into the derived stores, never the reverse. Any future feature that would reconstruct `metadata.json`, `tmdb.config`, or a managed image from a database column is a presumptive architecture violation that needs explicit sign-off.

The principle has three deliberate qualifications, stated up front so nobody over-applies it:

1. **Not all filesystem content is ground truth.** Several on-disk locations are derived, disposable state (§1.2).
2. **Not all SQLite content is derived.** A small set of tables is genuinely non-derivable action history (Tier 5 in §1.3).
3. **A third, MongoDB-backed tier exists** that fits neither bucket and has its own rules (§1.4).

### 1.1 What ground truth is

Ground truth is the media library on disk, rooted at `BASE_PATH`:

- The media directory tree itself — a movie or show *exists* because its directory exists.
- Video/audio/subtitle files inside those directories.
- `metadata.json` per title (and per-season/per-episode metadata files) — the durable home of TMDB-derived, override-merged metadata.
- `tmdb.config` per title — operator intent: pinned `tmdb_id`, the `update_metadata` freeze flag, metadata/image overrides, `backdrop_focal`.
- Image files in their convention slots (poster/backdrop/logo, season posters, episode thumbnails).

Deleting derived state is always recoverable. Deleting ground truth is not: an accidentally deleted `tmdb.config` silently reverts the title to defaults (unpinned id, unfrozen, no overrides), and a deleted `metadata.json` on a *frozen* title is never rewritten (absent overrides — see the frozen-behavior matrix in the `metadata.json` entry of §3), because the freeze gate in `node/lib/metadataGenerator.mjs` (`isUpdateAllowed()` checked in `generateForShow()` / `generateForMovie()`) returns before any fetch would recreate it.

### 1.2 On-disk state that is NOT ground truth

The filesystem also hosts derived, disposable state. Deleting any of it costs only recompute time:

| Location | Contents | Rebuilt by |
|---|---|---|
| `cache/general`, `cache/video_clips`, `cache/spritesheet`, `cache/frames`, `cache/video_transcode` (defined in `node/utils/utils.mjs`) | Transcode output, clips, sprite sheets, frame extracts | On-demand video/sprite handlers; age-swept by the scheduled `clear*Cache()` jobs in `node/app.mjs` |
| `.info` sidecar files (written by `node/infoManager.mjs`) | Cached mediainfo result, including the `uuid` (SHA-256 of the media header) that becomes the DB `_id` | Re-running mediainfo on the video file |
| `.blurhash` / blurhash sidecar files | Encoded blurhash per image | Re-encoding from the image file |

A reader who generalizes §1.1 to "everything on disk is sacred" would wrongly protect these; a reader who generalizes §1.3 to "everything outside `BASE_PATH` media folders is rebuildable" would be right about these but wrong about Tier 5 below.

### 1.3 SQLite: derived state, with named exceptions

SQLite is split across four physical files (`DB_PATHS` in `node/sqliteDatabase.mjs`): `media.db` (movies, tv_shows, cooldown tables, metadata_hashes, blurhash_hashes), `process_tracking.db` (process_queue), `tmdb_cache.db` (tmdb_cache, tmdb_blurhash_cache), and `discord_intros.db`.

The one-way flow is enforced structurally, not just by convention: every write to the `movies`/`tv_shows` tables goes through `node/components/media-scanner/data-access/scanner-repository.mjs` (`saveMovie()` / `saveTVShow()`), which is called only from the scanners. `node/app.mjs` imports `insertOrUpdateMovie` / `insertOrUpdateTVShow` from `node/sqliteDatabase.mjs` but never calls them — a dead import that corroborates the one-way direction rather than contradicting it.

Not all derived state is equally cheap to rebuild. The tiers:

| Tier | Rebuild cost | Examples |
|---|---|---|
| 0 | Directory listing | Show/movie existence |
| 1 | Single `fs.stat` | `directory_hash`, `poster_hash`/`poster_mtime` and siblings |
| 2 | Read + parse an existing file | `movies.metadata` / `tv_shows.metadata` (mirror `metadata.json`), `backdrop_focal` (mirrors `tmdb.config`), `metadata_hashes` rows (recomputed from row data — which since Branch 1 carries the `metadata.json` content fingerprint for both types — by `generateMovieHashes()` / `generateTVShowHashes()` in `node/sqlite/metadataHashes.mjs`) |
| 3 | Deterministic external-process compute, cached in a sidecar | `_id` (SHA-256 of the mediainfo header, via `node/infoManager.mjs`), blurhashes |
| 4 | Heavier or external-dependent compute | `backdrop_focal_suggested` (face-detection), `tmdb_cache` rows (network fetch) |
| 5 | **Not derivable — the genuine exceptions** | `missing_data_media` and `episode_metadata_missing` cooldown timestamps (scanner retry history), and `discord_intros` (bot action history — a user greeted once must not be greeted again) |

Tier 5 is why "SQLite is a rebuildable cache" cannot be stated without qualification. Losing the cooldown tables is *harmless but real* (retries resume immediately instead of honoring cooldowns); losing `discord_intros` causes visible duplicate bot behavior. `process_queue` in `process_tracking.db` structurally resembles action history and was once suspected of belonging in this tier, but its lifecycle has since been traced end-to-end: it is disposable operational telemetry — losing it costs nothing but progress-display history (see the process-tracking entry in §3) — so it does not merit the Tier-5 durability posture.

### 1.4 The third tier: MongoDB-backed state

The filesystem/SQLite duality omits a real tier: this backend also owns MongoDB state (connection helpers and the `app_config` index provisioning in `node/database.mjs`). It has three distinct sub-kinds with different risk profiles:

1. **Non-derivable identity/admin state.** The `Users` database (name overridable via `MONGODB_AUTH_DB`, read by both `getUsersDb()` and the Better Auth setup in `node/lib/auth.mjs` so the two always resolve the same database; `account` / `user` collections, Better Auth schema) links Discord OAuth accounts to admin users; `getAdminByDiscordId()` in `node/database.mjs` reads it to authorize Discord bot commands. This repo only reads these collections — they are written by the frontend — but nothing in either repo can regenerate them.
2. **Self-healing config that silently reverts to defaults if lost.** `app_config.settings` holds named settings documents. Both `checkAutoSync()` in `node/database.mjs` and the autoCaptions config reader in `node/components/caption-generator/data-access/caption-config.mjs` *insert the default document if none exists*. Convenient for first boot, dangerous afterward: if these documents are ever lost, the system does not fail — it quietly resumes with defaults, discarding whatever the operator had configured. Decided 2026-07-07 (M-4) — not yet implemented: the durability posture is to be documented — naming `Users` and `app_config` as the collections an external backup/snapshot policy must cover, with a pointer in README/`.env.example` — and `app_config.settings` writes are to be logged so a silent revert-to-default is at least detectable in retrospect. An external backup policy covering this state already exists (operator-confirmed); the gap is purely that nothing in-repo documents it.
3. **Dead legacy collections (provisioning removed).** Historically `initializeMongoDatabase()` in `node/database.mjs` provisioned `Media.Movies`, `Media.TV`, `Media.PlaybackStatus`, and `Cache.cacheEntries` on every startup (and `initializeIndexes()` built indexes on all four), yet no code in either repo read or wrote any of them — the live frontend data is the `Flat*` collections owned by the frontend's own sync. Implemented (Branch 12, per the M-3 decision): the provisioning is deleted and `initializeIndexes()` maintains only the `app_config.settings` unique index. Any of those four collections still present in a deployed Mongo instance are inert leftovers this backend never touches, safe to drop manually.

### 1.5 Three recovery levers — distinct, easy to conflate

Three operations all "make things fresh again" and are routinely confused. They act on different layers:

1. **Delete `media.db` → full *derived-state* rebuild.** Accepted, bounded-cost recovery: the next scan repopulates every row from ground truth. Cost is paced by the scanners' sequential per-item processing, and the TMDB response cache lives in a *separate* file (`tmdb_cache.db`), so a `media.db` rebuild mostly hits the local cache rather than the TMDB API. Caveat from §1.3: this also destroys the Tier-5 cooldown rows that happen to live in `media.db`, so retry pacing resets (harmless); `discord_intros.db` and `process_tracking.db` are untouched.
2. **`GET /rescan/tmdb` → full *ground-truth* rebuild.** The route in `node/app.mjs` calls `runDownloadTmdbImages({ fullScan: true })`, which constructs a `MetadataGenerator` with `forceRefresh: true` and walks the entire library (`generateImages()` with no name → `processDirectory('tv')` then `processDirectory('movies')`). For each non-frozen title it wipes the managed images (`_wipeManagedImagesForForceRefresh()`), re-downloads them, and rewrites `metadata.json` from a fresh TMDB fetch with overrides re-applied. Frozen titles (`update_metadata: false`) are still skipped — the freeze gate runs before the force-refresh branch. This lever is orthogonal to lever 1: it rewrites ground truth itself. The route requires `authenticateWebhookOrUser` — a webhook shared secret or an admin session, the same level as its sibling `POST /media/scan` (A-1, implemented in Branch 9; auth posture in §4.9).
3. **Per-item `tmdb.config` edit → single-item force-refresh.** Touching a title's `tmdb.config` makes its mtime newer than `metadata.json`/images; the scanners detect this as `staleByConfig` (`checkTMDBImagesNeeded()` in `node/components/media-scanner/domain/movie-scanner.mjs`, with the symmetric TV path in `tv-scanner.mjs`) and pass `fullScan: staleByConfig` for **that item only**, triggering the same wipe-and-repull as lever 2 scoped to one title. This is the intended remediation for a wrong TMDB auto-match: pin the correct `tmdb_id` and the old id's images are wiped rather than stranded (the downloader's existence check would otherwise keep them). The full state machine is in §3 (movie / TV show entry).

> **Why the pristine-base snapshot is a SQLite column, not a file.**
> Decided 2026-07-07; the column and its population shipped with Branch 1 (this tree): the "pristine base" snapshot of TMDB's raw, pre-override response is stored as a SQLite column (`pristine_metadata`, on both `movies` and `tv_shows`) rather than a new on-disk file. This is a direct application of §1's principle, not an afterthought: the snapshot is a cache of TMDB's raw response — a derived artifact, so it belongs in the derived store — while ground truth already has a home in `metadata.json`. Adding a second ground-truth file would have created a second thing to back up, reconcile, and reason about; adding a column just makes the derived store richer. (Full lifecycle, including the still-unshipped Branch 2 trust semantics: the pristine-base entry at the end of §3.)

## 2. System map

One entry per subsystem. Each entry states what the subsystem owns (its exclusive responsibility), what it deliberately does not own (responsibilities that look like they might belong here but are placed elsewhere on purpose), and its key files. Paths are repo-relative; cite functions by name, not line number.

### 2.1 Media scanner

**Owns:** Filesystem diffing (directory hashing, presence/mtime checks), gate computation for when a title needs TMDB work, dispatch to the metadata generator, and all DB persistence of scan results via the repository layer. The scanner computes disk-state booleans (missing metadata, missing images, config-edit staleness) and hands the decision of *what to fetch* down a layer.

**Does not own:** TMDB schema knowledge. The scanner is forbidden from interpreting `metadata.json` content or knowing TMDB field names — schema awareness lives in the metadata generator and image downloader. Two deliberate, bounded exceptions exist (opaque canonicalization of `metadata.json` into the fingerprint the scanner persists to the `metadata` column — `movie-scanner.mjs` since Branch 1, `tv-scanner.mjs` `processShowMetadata()` before it — so metadata edits move the frontend-facing hash, plus a single-field `id` extraction for episode backfill); both are pinned in §4.1 and neither inspects individual TMDB fields to branch on. Since Branch 1 the scanner also carries the generator-returned raw pre-override TMDB payload (`pristineMetadata`) to `saveMovie()`/`saveTVShow()` as an opaque pass-through — it never parses it. The scanner also does not own the freeze decision (`update_metadata: false`) — that gate is enforced by the generator (see 2.2). Where the scanner calls a path that can independently write to TMDB-derived state (the air-date-aware episode backfill), it threads the freeze flag through explicitly: both `backfillMissingEpisodes` call sites in `node/components/media-scanner/domain/tv-scanner.mjs` compute `isUpdateAllowed(tmdbConfig)` and pass it in, and the parameter defaults to `false` (fail closed) so a future call site that forgets it gets no backfill rather than a freeze bypass.

**Key files:**
- `node/components/media-scanner/index.mjs` — component public surface
- `node/components/media-scanner/entry-points/scanner-controller.mjs`
- `node/components/media-scanner/domain/movie-scanner.mjs`, `node/components/media-scanner/domain/tv-scanner.mjs` — the two scan loops
- `node/components/media-scanner/domain/image-conventions.mjs` — image filename conventions the scanner recognizes
- `node/components/media-scanner/domain/subtitle-filename.mjs` — subtitle filename parsing
- `node/components/media-scanner/data-access/scanner-repository.mjs` — `saveMovie`, `saveTVShow`, `removeMovie`, `removeTVShow`, plus cooldown bookkeeping (`markMediaAsMissingData`, `recordEpisodeAttempt`, `clearEpisodeRetry`)

### 2.2 Metadata generator

**Owns:** TMDB fetch orchestration, override merging, the freeze gate, image-reconcile triggers, and the season/episode walk. The `MetadataGenerator` class in `node/lib/metadataGenerator.mjs` is where `update_metadata: false` is actually enforced: both `generateForShow` and `generateForMovie` check `isUpdateAllowed(tmdbConfig)` before any TMDB write. The air-date-aware episode re-pull (`refreshMissingEpisodes`, exported from the same file) owns all schema/air-date/cooldown-policy decisions for episode backfill; the scanner only hands it candidates.

**Does not own:** Raw HTTP, caching, and retry against TMDB (that is the API boundary, 2.4). Disk-staleness detection (that is the scanner, 2.1). Direct DB reads for prior state — the scanner passes previous file paths down so the generator stays DB-agnostic.

**Key files:**
- `node/lib/metadataGenerator.mjs` — `MetadataGenerator` class (`generateForShow`, `generateForMovie`, `generateImages`), `refreshMissingEpisodes`

### 2.3 `tmdb.config` module

**Owns:** All interpretation of per-title `tmdb.config` files. `node/utils/tmdbConfig.mjs` is the only legal reader/writer of that file's schema: load/save (`loadTmdbConfig`, `saveTmdbConfig`), validation and defaults (`validateTmdbConfig`), the freeze predicate (`isUpdateAllowed` — `update_metadata !== false`, defaulting to allowed), override accessors (`getMetadataOverrides`, `applyMetadataOverrides`, and the presence-based opt-in check `hasMetadataOverrideKey` — the single source of truth for "is this title override-managed", G-2), the id ratchet (`updateTmdbConfigWithId`, which only ever adds an id, never overwrites one), and path resolution (`getTmdbConfigFilePath`). Every other subsystem must go through these exports rather than hand-parsing the JSON.

**Does not own:** Deciding *when* the config is stale (scanner) or *what* to do about overrides (generator).

**Dead code note:** `getOverride(config, field)` is exported from `node/utils/tmdbConfig.mjs` but has zero callers anywhere in the codebase (re-verified against the current tree). Image override lookups happen through other paths.

**Key files:**
- `node/utils/tmdbConfig.mjs`

### 2.4 TMDB API boundary

**Owns:** The single request/cache/retry chokepoint for TMDB HTTP traffic in `node/utils/tmdb.mjs`: response caching (default TTL 1440 hours / 60 days, backed by the `tmdb_cache.db` SQLite file), retry/backoff logic, ETag capture, by-id vs. by-name lookup semantics, and response aggregation helpers (collections, cast, trailers). `forceRefresh` bypasses the response cache. The whole pipeline is native Node; the former Python TMDB scripts are removed.

**Does not own:** Deciding when to fetch (generator) or what the results mean for disk state (generator/downloader).

**Accepted posture — no circuit breaker (T-7, decided 2026-07-07).** There is deliberately no circuit breaker for a sustained TMDB outage. Protection is layered instead: per-request retry/backoff in this boundary, plus the per-title 24-hour `missing_data_media` cooldown at the scanner — so each in-flight title fails once and goes quiet rather than hammering a down API. This is accepted on the assumption that TMDB outages stay rare and short; revisit only if an observed incident leaves scan duration unacceptable after the T-4/T-5 client-hardening fixes land.

**Key files:**
- `node/utils/tmdb.mjs` — fetch/cache/retry core plus aggregation helpers (`fetchEnhancedCollectionData`, `aggregateCollectionData`, etc.)
- `node/routes/tmdb.mjs` — authenticated proxy routes (`/api/tmdb/*`) exposing search/details/cast/images/collection endpoints, plus admin cache-stats and cache-refresh endpoints

### 2.5 Image and blurhash pipeline

**Owns:** Image filename conventions on disk, existence-check-gated downloads, blurhash sidecar generation, and backdrop focal-point detection. The downloader (`node/utils/imageDownloader.mjs`: `downloadImage`, `downloadImageWithBlurhash`, `downloadMediaImages`, `downloadSeasonPoster`, `downloadEpisodeThumbnail`) is deliberately a dumb existence-check writer on the top-level poster/backdrop/logo path (`downloadImage` / `downloadMediaImages`): there it has no staleness logic of its own, and the generator alone decides when to delete a file so the downloader is forced to re-fetch. The two grandfathered exceptions are `downloadSeasonPoster()` and `downloadEpisodeThumbnail()`, which carry their own age-based TTL checks inside the downloader (§4.3). There are three independent blurhash entry points, each with its own sizing policy: (1) the scheduled sidecar scan pipeline (`node/utils/blurhashNative.mjs` with the worker pool in `node/lib/blurhash-pool.mjs`, persisted via `node/sqlite/blurhashHashes.mjs`); (2) blurhash generated at image-download time (`generateImageBlurhash` in `node/utils/imageDownloader.mjs`); (3) blurhash embedded into cached TMDB API responses (`node/utils/tmdbBlurhash.mjs`, cached via `node/sqlite/tmdbBlurhashCache.mjs`). Decided 2026-07-07 (B-2b) — not yet implemented: the three sizing policies are to be unified into one shared policy module, with the TMDB-proxy pipeline's poster-size divergence made an explicit, named choice rather than drift. The `.blurhash` sidecar lifecycle these pipelines feed is cataloged in §3. Backdrop focal detection lives in `node/utils/backdropFocalDetector.mjs` (`detectBackdropFocal`, face-api based).

**Does not own:** Staleness decisions (generator) or which conventions count as managed slots at scan time (`node/components/media-scanner/domain/image-conventions.mjs`, owned by the scanner component).

**Key files:**
- `node/utils/imageDownloader.mjs`
- `node/utils/blurhashNative.mjs`, `node/lib/blurhash-pool.mjs`
- `node/utils/tmdbBlurhash.mjs`
- `node/utils/backdropFocalDetector.mjs`
- `node/sqlite/blurhashHashes.mjs`, `node/sqlite/tmdbBlurhashCache.mjs`
- `node/routes/blurhash.mjs` — `/api/blurhash-changes`, per-title blurhash reads, bulk endpoint

### 2.6 SQLite persistence

**Owns:** Four physical database files and their schemas, declared in `node/sqliteDatabase.mjs`: `media.db` (main movies/TV tables plus metadata hashes), `process_tracking.db` (the process/step queue behind the `/processes` endpoints, managed by `node/sqlite/processTracking.mjs`), `tmdb_cache.db` (the TMDB response cache), and `discord_intros.db` (Discord introduction-DM history, `node/sqlite/discordIntros.mjs`). Access goes through `initializeDatabase(dbType)` / `releaseDatabase(db)`.

**Does not own:** Ground truth. The movies/TV tables are derived state mirroring the filesystem — the DB is a one-way sink and is never used to reconstruct `metadata.json`, `tmdb.config`, or images (see §1). The exceptions that are genuinely non-derivable are the bookkeeping tables (retry cooldowns and Discord intro history); the process-tracking queue, by contrast, is disposable operational telemetry (see the process-tracking entry in §3). Note that not all backend state is SQLite: a MongoDB tier (via `node/lib/mongo.mjs` and `node/database.mjs`) holds the auto-sync gate, the auto-captions config, and the Discord-user-to-admin linkage (see 2.7, 2.10, 2.12).

**Key files:**
- `node/sqliteDatabase.mjs`
- `node/sqlite/metadataHashes.mjs`, `node/sqlite/blurhashHashes.mjs`, `node/sqlite/tmdbBlurhashCache.mjs`, `node/sqlite/processTracking.mjs`, `node/sqlite/discordIntros.mjs`

### 2.7 Frontend sync

**Owns:** The hash-gating contract — this backend's only observable interface into frontend behavior. Hash rows live in `media.db` (`node/sqlite/metadataHashes.mjs`) and are served by `node/routes/metadataHashes.mjs` (`/api/metadata-hashes/:mediaType`, per-title and per-season variants). The push side is `autoSync` in `node/app.mjs`: after a media-list generation it POSTs to the frontend's `/api/authenticated/admin/sync` webhook, gated by a Mongo-backed `autoSync` setting read through `node/database.mjs`.

**Does not own:** Anything about how the frontend parses `metadata.json` beyond the documented hash-input fields. The backend must not encode assumptions about frontend internals; the contract is the hash surface plus the sync webhook (§4.7).

**Key files:**
- `node/sqlite/metadataHashes.mjs`
- `node/routes/metadataHashes.mjs`
- `node/app.mjs` — `autoSync` and the scheduled `Metadata Hashes Update` job
- `node/database.mjs` — Mongo settings reads (auto-sync gate)

### 2.8 Admin and API surface

**Owns:** Operator-facing mutation and read endpoints. The admin router (`node/routes/admin.mjs`, mounted at `/api/admin` by `node/routes/index.mjs`) covers subtitle saves, per-title `tmdb.config` updates, and related metadata mutations. All user-supplied title/show-name path segments in these handlers pass through `safeJoin` in `node/routes/admin.mjs`, which rejects `..` traversal after `decodeURIComponent` (shipped fix, SEC-1). Top-level operational routes live in `node/app.mjs`: `/media/movies`, `/media/tv`, `/media/scan`, `/processes`, `/api/logs`, and `/rescan/tmdb`.

**Does not own:** The work itself — handlers delegate to the scanner, generator, and cache modules.

**Known sharp edges (current behavior):** The config-update endpoint is a full-file replace with no server-side merge — deliberate and load-bearing (A-2; see the warning block in §4.6). The manual `/media/scan` route only scans movies — it calls `generateListMovies` with no TV equivalent (S-3; see §4.7). (`/rescan/tmdb`'s missing auth was closed by A-1 in Branch 9 — it now requires `authenticateWebhookOrUser`; see §4.9.)

**Key files:**
- `node/routes/admin.mjs` — `safeJoin` plus subtitle/config/metadata mutation handlers
- `node/routes/index.mjs` — router assembly (`/api`, `/api/admin`, `/api/tmdb`, Discord events)
- `node/app.mjs` — top-level media/scan/rescan/process/log routes

### 2.9 Scheduling and concurrency

**Owns:** Cron cadence and concurrency guarantees — **only for the paths that go through the task manager.** `node/lib/taskManager.mjs` defines the `TaskType` priority enum, per-type `concurrencyLimits` (e.g. one scan, one blurhash, one cache cleanup at a time), and `exclusiveGroups` that keep media scans, metadata hashing, and blurhash work mutually exclusive. Jobs are scheduled with `node-schedule` in `node/app.mjs` and wrapped in `enqueueTask`. The scheduled blurhash job enqueues under `TaskType.BLURHASH`, which exists in the enum and carries a concurrency limit of 1 (shipped fix, S-1).

**Does not own — and this is the honest limit of its guarantees:**
- **Duplicate-scheduled cleanup jobs bypass the limiter.** The frames, spritesheet, and video-clips cache cleanups are each scheduled *twice* in `node/app.mjs`: once at module level wrapped in `enqueueTask(TaskType.CACHE_CLEANUP, ...)`, and a second time inside `scheduleTasks()` calling `clearFramesCache` / `clearSpritesheetCache` / `clearVideoClipsCache` directly, with no task-manager gate. The direct copies run outside all concurrency and exclusivity guarantees (V-1). Decided 2026-07-07 — not yet implemented: delete the three redundant direct `scheduleJob` blocks (planned as Branch 11); the gated module-level equivalents already cover the work.
- **On-demand routes bypass it entirely.** `/media/scan`, `/rescan/tmdb`, the media-listing endpoints, and the admin metadata routes call their work directly rather than enqueueing, so they can run concurrently with a scheduled scan or each other (S-2). Decided 2026-07-07 (S-2): gate the write-heavy admin routes through the task manager (they can race the force-refresh image-wipe path); leave the read-mostly listing endpoints ungated. Not yet implemented.

**Key files:**
- `node/lib/taskManager.mjs` — `TaskType`, `concurrencyLimits`, `exclusiveGroups`, `enqueueTask`
- `node/app.mjs` — all `scheduleJob` registrations and `scheduleTasks()`

### 2.10 Subtitles, chapters, and captions

**Owns:** Subtitle filename parsing at scan time, chapter VTT generation, and just-in-time Whisper-based caption generation. Chapter generation is `generateChapters` in `node/chapter-generator.mjs`, served by the `/chapters/movie/...` and `/chapters/tv/...` routes in `node/app.mjs`. Auto-captions are the `caption-generator` component: config comes from MongoDB (`getAutoCaptionsConfig` in `node/components/caption-generator/data-access/caption-config.mjs`, reading the `app_config` database), stubs are injected at scan time (`domain/caption-stubs.mjs`), and generation runs through `entry-points/caption-controller.mjs` with Whisper plumbing in `node/lib/whisper.mjs`. Caption jobs enqueue under `TaskType.CAPTION_GENERATE` (limit 1).

**Does not own:** Video/audio transcoding (2.11) or subtitle file placement decisions during scans (scanner domain, `subtitle-filename.mjs`).

**Key files:**
- `node/chapter-generator.mjs`
- `node/components/caption-generator/` — `index.mjs`, `data-access/caption-config.mjs`, `domain/` (audio-extractor, caption-stubs, srt-postprocess, target-resolver), `entry-points/caption-controller.mjs`
- `node/lib/whisper.mjs`
- `node/routes/captions.mjs` — caption track/job/health routes
- `node/components/media-scanner/domain/subtitle-filename.mjs`

### 2.11 Video / HLS / transcode / sprite-frame cache pipeline — *shallow-surveyed*

> This subsystem has not been deep-surveyed to the same standard as the others; the entry below is verified at the route/file/cleanup level only. Internal transcode/cache-key behavior, the process-queue lifecycle, and hardware-acceleration selection have not been traced end-to-end. Treat "Owns" here as a directory of where things live, not a verified contract.

**Owns:** On-demand video serving with conditional transcode, video clip extraction, frame extraction, spritesheet + VTT thumbnail-track generation, and the disk caches behind all of it. Playback requests hit `/video/movie/:movieName` and `/video/tv/:showName/:season/:episode` in `node/app.mjs`, handled by `handleVideoRequest` in `node/videoHandler.mjs`, which decides codec/audio compatibility and either serves the source or generates a cached transcode via `node/ffmpeg/transcode.mjs` (`generateFullTranscode`, `generateAndCacheClip`). Clips are `/videoClip/...`; frames are `/frame/...`; spritesheets and their VTT tracks are `/spritesheet/...` and `/vtt/...`, registered by `createSpriteRoutes` in `node/sprite-route.mjs` with generation logic in `node/sprite.mjs`; the route layer (`node/sprite-route.mjs`) writes step-by-step progress into the process-tracking queue via `onProgress` callbacks it passes into the generation functions.

Five cache directories are declared in `node/utils/utils.mjs`: `general`, `spritesheet`, `frames`, `video_clips`, and `video_transcode`. Scheduled cleanup covers five categories — general cache, video clips, spritesheets, frames, and original segments (`clearGeneralCache`, `clearVideoClipsCache`, `clearSpritesheetCache`, `clearFramesCache`, `clearOriginalSegmentsCache`, all in `node/utils/utils.mjs`; original segments are `-original.mp4` files inside the video-clips directory on a short 8-minute access-time window). The `video_transcode` directory is the only cache with **no eviction job at all** (open item V-2). The frames/spritesheet/clips cleanups are double-scheduled with inconsistent task-manager wrapping — see 2.9 (V-1).

**Does not own:** Media metadata or images (scanner/generator), caption generation (2.10).

**Key files:**
- `node/videoHandler.mjs` — `handleVideoRequest`, `handleVideoClipRequest`
- `node/ffmpeg/` — `transcode.mjs`, `ffmpeg.mjs`, `ffprobe.mjs`, `encoderConfig.mjs`
- `node/sprite.mjs`, `node/sprite-route.mjs` — `createSpriteRoutes`
- `node/hardwareAcceleration.mjs`
- `node/utils/utils.mjs` — cache directory constants and all `clear*Cache` functions
- `node/sqlite/processTracking.mjs` — progress queue surfaced at `/processes`

### 2.12 Discord bot integration — live, shipped subsystem

This is real, working functionality today — distinct from `node/integrations/discord/MEDIA_ADMIN_COMMANDS_PLAN.md`, which is a mostly-unbuilt backlog (the plan self-reports completion it does not have; roughly one of its seventeen items shipped — open item D-2). Do not read the plan document as a description of current behavior.

**Owns:**
- **Webhook events endpoint:** `POST /api/discord/events` in `node/integrations/discord/routes.mjs`, registered with `express.raw` so the raw body is available for Ed25519 signature verification (`verifyKey` from `discord-interactions`, against `DISCORD_PUBLIC_KEY`; missing or bad signatures get 401). The global JSON body parser in `node/app.mjs` explicitly skips this path so the raw body survives (shipped fix, D-1).
- **Bot with shipped slash commands:** `node/integrations/discord/bot.mjs` (`DiscordBotAdapter`) loads commands from `node/integrations/discord/commands/` — `ping`, `help`, `status`, and `tasks` — plus event handlers in `events/` (`ready`, `guildCreate`, `interactionCreate`) and introduction DMs (`utils/introductionDM.mjs`, history persisted in `discord_intros.db` via `node/sqlite/discordIntros.mjs`).
- **Mongo-backed admin linkage:** privileged interactions (e.g. the `tasks` command) call `getAdminByDiscordId` in `node/database.mjs`, which resolves the Discord user through the frontend's Better Auth `account` collection to a `user` document in the Mongo `Users` database and requires `role === "admin"`.
- **Outbound notifications:** `node/integrations/index.mjs` wires a webhook-based `DiscordAdapter` (`webhook.mjs`) and conditionally starts the bot when a `discord_bot` notification channel is configured via environment variables.

**Does not own:** Admin authorization data itself (that is the frontend's Mongo `Users` database — this backend only reads it), and the unshipped command suite described in the plan document.

**Key files:**
- `node/integrations/discord/routes.mjs` — `setupDiscordRoutes`, events endpoint + signature verification
- `node/integrations/discord/bot.mjs`, `node/integrations/discord/webhook.mjs`, `node/integrations/index.mjs`
- `node/integrations/discord/commands/` — `ping.mjs`, `help.mjs`, `status.mjs`, `tasks.mjs`
- `node/integrations/discord/events/` — `ready.mjs`, `guildCreate.mjs`, `interactionCreate.mjs`
- `node/database.mjs` — `getAdminByDiscordId`
- `node/sqlite/discordIntros.mjs`

## 3. Keypoint lifecycle catalog

This catalog covers every keypoint entity in two groups: **ground-truth entities first** (they live on the media filesystem and are the system's ground truth), then **derived-state entities** (SQLite rows, in-process registries, and temp/cache files). Every SQLite row describing a ground-truth entity is derived and rebuildable; when disk and database disagree, disk wins and the scanner's job is to make the database catch up. Each entry gives the entity's states, the transitions between them, and — critically — **which layer owns each gate**, because the freeze/retry bugs this codebase has already had all came from a gate living in the wrong layer or being bypassed by a side channel.

The recurring owner split, stated once here and referenced throughout:

- **Scanner** (`node/components/media-scanner/domain/movie-scanner.mjs`, `tv-scanner.mjs`) computes disk-state booleans (what is missing/stale) and decides *whether* to invoke the generator. It is deliberately blind to TMDB schema and to the freeze flag's meaning — it never makes TMDB calls itself.
- **Generator** (`node/lib/metadataGenerator.mjs`, class `MetadataGenerator`) owns all TMDB fetches, all metadata.json/image writes, and enforces the freeze (`isUpdateAllowed`).
- **Repository** (`node/components/media-scanner/data-access/scanner-repository.mjs`) owns cooldown bookkeeping (the `missing_data_media` and `episode_metadata_missing` tables).

---

**Ground-truth entities** — the entries from here through the override entry live on the media filesystem.

### Movie / TV show (media directory)

The top-level entity is a directory under `movies/` or `tv/`. Its lifecycle:

```
Unseen ──► Fresh ──► (Images-missing | Metadata-missing | Config-edit-stale)* ──► Fresh
                └──► Frozen (operator-set, orthogonal to the above)
                └──► No-TMDB-match (currently collapses into Metadata-missing)
                └──► Removed
```

Each stale state is re-driven toward Fresh on scan ticks, gated as follows — with one structural asymmetry between the two scanners that shapes every retry row below. In `tv-scanner.mjs` `scanTVShows()`, the gate booleans (`missingImages`, `missingMetadata`) are computed on every tick *before* the unchanged-directory fast-skip, so the retry gates genuinely fire every tick. In `movie-scanner.mjs` `scanMovies()`, an existing movie whose directory hash is unchanged returns early *before* `checkTMDBImagesNeeded()` ever runs — and since `calculateDirectoryHash()` (`node/utils/utils.mjs`) hashes only entry names, sizes, and mtimes, a missing image or metadata file does not change the hash — so for movies the retry gates below are reachable only when the directory contents change (or `.info` regeneration forces processing — or, once per pre-Branch-1 row, the one-shot F-1 metadata-fingerprint backfill: the early return is skipped while `movies.metadata` is NULL and a `metadata.json` exists, converging after a single pass). All gates verified in current code:

| State | Detected by | Retry cooldown | Enforced in |
|---|---|---|---|
| Unseen / dir changed | `dirHashChanged` (stored directory hash differs or absent) | none — processed immediately | scanner |
| Images-missing | `missingImages` — any of poster/backdrop/logo absent or stale on disk | **none** for TV — retried every scan tick *while `isUpdateAllowed()`*; frozen titles are not re-offered on this branch (Branch 3). For movies, retried only when `dirHashChanged` forces processing | `tv-scanner.mjs` `processShowAssets()` (gate computed pre-skip every tick); `movie-scanner.mjs` `checkTMDBImagesNeeded()` (reached only past the unchanged-hash early return) |
| Metadata-missing | `missingMetadata` — `metadata.json` absent, or older than `tmdb.config` | **24 h** via `missing_data_media` (`RETRY_INTERVAL_HOURS` in `scanner-repository.mjs`) — the 24 h cycle is effective for TV; for movies the gate is unreachable while the directory hash is stable. The row is stamped **after a failed attempt** (Branch 3), not before the attempt. Frozen titles reach this branch only when `tmdb.config` carries metadata overrides | scanner gate + repository bookkeeping (`resolveCooldownAction` in `cooldown-policy.mjs`) |
| Config-edit-stale | `staleByConfig` — `tmdb.config` mtime newer than an *existing* `metadata.json` | none — fires once, self-limiting | scanner sets `fullScan: staleByConfig` → generator `forceRefresh` |
| Frozen | `update_metadata: false` in `tmdb.config` | n/a — generator early-returns; the scanners read the returned frozen reason and *clear* (no-overrides case) or 24h-pace (overrides case) the cooldown row | `metadataGenerator.mjs` `generateForShow()` / `generateForMovie()` via `isUpdateAllowed()`; scanner gate consults the flag for the images branch and the frozen-metadata branch (§4.2) |
| No-TMDB-match | typed `TmdbNoMatchError` from `tmdb.mjs` → generator returns `reason: 'no-match'` (G‑1b, Branch 3) | same as the metadata cooldown — 'no-match' and 'transient-error' are distinguishable in the return contract/logs but currently receive identical 24 h pacing | `tmdb.mjs` `fetchComprehensiveMediaDetails()` + generator failure classification |
| Removed | directory gone from disk | — | scanner `removeMovie()` / `removeTVShow()` |

Details per gate:

**Images-missing (no cooldown, freeze-aware — Branch 3).** The scanner deliberately exempts image failures from the 24 h cooldown on the theory that image-CDN failures are transient, but gates them on the freeze flag: `runDownloadTmdbImagesFlag = dirHashChanged || (missingImages && updateAllowed) || (missingMetadata && metadataGateAllowsRetry && (updateAllowed || hasOverrides))`. How often that formula is even evaluated differs by scanner. The TV scanner computes it on every tick — its fast-skip was deliberately restructured to run *after* the gate, precisely because the old movie-style hash-skip suppressed image-only retries (the comment in `tv-scanner.mjs` `scanTVShows()` records this). The movie scanner still has the pre-restructure shape: an unchanged-hash movie returns early before `checkTMDBImagesNeeded()`, and a permanently missing image never moves the directory hash, so after the first failed pass saves the post-attempt hash the movie is skipped on every subsequent tick — the image is retried only when the directory contents change. The old R‑2 consequence (a frozen TV show with a permanently missing image re-invoking the generator every tick forever) is fixed by the `updateAllowed` term: a frozen title is not re-offered on the images branch at all, and any unfreeze is picked up via `dirHashChanged` (the `tmdb.config` edit bumps its mtime).

**Metadata-missing (24 h cooldown).** The cooldown row in `missing_data_media` is stamped **after a failed attempt** (Branch 3, closing R‑1): the pre-attempt mark is gone, and the post-attempt bookkeeping — the shared `resolveCooldownAction()` in `node/components/media-scanner/domain/cooldown-policy.mjs` — decides from the generator's returned reason plus post-attempt disk state. Metadata still missing and the reason frozen with no overrides → the row is *cleared* (paused is not failing; the gate above will not re-offer the title anyway); still missing with overrides present, or any genuine failure (`'no-match'` / `'transient-error'`) → *marked*, so the 24 h cooldown now means confirmed failure; metadata and images both present → cleared; metadata present but images still missing → untouched (any existing row is irrelevant to the images path, which retries on its own `updateAllowed` gate). The 24 h *retry cycle* itself is real only for TV: the movie scanner consults `metadataGateAllowsRetry` only when the movie is processed at all, and the unchanged-hash early return short-circuits before that check — so a movie's failed metadata lookup is effectively retried once per directory-content change, with the `missing_data_media` row persisting but its 24 h gate unreachable while the hash is stable.

**Config-edit-stale.** An operator edit to `tmdb.config` (typically pinning a corrected `tmdb_id`) bumps the file's mtime past `metadata.json`'s. The scanner passes `fullScan: staleByConfig` into the generator invocation (`tv-scanner.mjs` and `movie-scanner.mjs`, symmetric), which becomes `forceRefresh: true` on the `MetadataGenerator`. `forceRefresh` bypasses every existence/age gate downstream: managed images are **wiped first** (`_wipeManagedImagesForForceRefresh()`) so the new id's art fully replaces the old id's, the TMDB response cache is bypassed, and season/episode files are re-pulled. The transition is self-limiting: the regenerated `metadata.json` is now newer than the config, so it does not re-fire.

**Frozen (`update_metadata: false`).** The freeze is enforced primarily in the generator — the *first* effective check in both `generateForShow()` and `generateForMovie()`, before any TMDB fetch. The scanner's gate computation consults the flag in the two narrowed places §4.2 documents (the images-missing branch, and the frozen-with-no-overrides metadata branch), and its post-attempt cooldown bookkeeping branches on the generator's returned frozen reason via `isFrozenReason()`. Two nuances of the freeze as shipped:

1. *Overrides still apply while frozen.* Before returning, the frozen branch calls `_applyOverridesWhileFrozen()`: if `tmdb.config.metadata` overrides exist, they are merged onto whatever `metadata.json` currently holds (or onto `{}` if the file is absent) and written back **only if the merge changes the file** — repeated scan ticks are idempotent. Rationale: setting an override is the operator's own instruction, not the TMDB churn the freeze exists to stop. The return value distinguishes the cases (`reason: 'updates-disabled-overrides-applied'` vs `'updates-disabled'`).
2. *The episode-backfill side channel is fail-closed.* `tv-scanner.mjs` `backfillMissingEpisodes()` can trigger TMDB writes independently of the generator's top-level gate, so it takes an explicit `updateAllowed` parameter (computed by the caller via `isUpdateAllowed()`) and **defaults to `false`** — a future call site that forgets to pass it gets no backfill rather than a freeze bypass. Both current call sites (the fast-skip path and the post-save path) pass it. This is the general contract for any future scanner-invoked path that can reach TMDB: freeze-awareness must be threaded in explicitly, fail-closed (§4.2).

One sharp edge in the freeze flag itself: `tmdbConfig.mjs` `validateTmdbConfig()` coerces a non-boolean `update_metadata` value (e.g. the string `"false"`) to `true` with only a warning log. A typo'd freeze **fails open**.

**No-TMDB-match (G‑1a/G‑1b, shipped in Branch 3).** When no `tmdb_id` is pinned and the title search returns nothing (after a retry with the `(year)` suffix stripped), `tmdb.mjs` `fetchComprehensiveMediaDetails()` throws a typed `TmdbNoMatchError` (`code: 'no-match'`); network/HTTP/rate-limit failures stay generic `Error`s. The generator's catch classifies accordingly: `{ success: false, reason: 'no-match' | 'transient-error' }`. The scanners read the returned reason, so "operator froze it" (`'updates-disabled*'` → row cleared or 24h-paced, see above) is now distinguishable from a genuine failure. Within the failure class, `'no-match'` and `'transient-error'` are distinguishable in the contract and logs but **currently receive identical pacing** — both mark the 24 h cooldown row (a deliberately conservative choice: fast-retrying transients per tick would flood retries and error logs during a TMDB outage; differentiated pacing can be added later without another contract change).

**Removed.** After each scan pass, names present in the DB but absent on disk are deleted (`removeMovie()` / `removeTVShow()`), with a full cascade (R-4 + F-3, shipped in Branch 5): the `missing_data_media` cooldown row, the show's `episode_metadata_missing` rows (`clearEpisodeRetryForShow()`), and the title's `metadata_hashes` rows (`deleteHashesForMedia()`) are cleared in the same loop — a same-named title re-added later starts clean instead of inheriting its predecessor's retry history or serving its frozen hash.

---

### Season

A season (`Season N/` directory under a show) has **no state machine of its own** — it is presence-only. Every time the parent show passes its gate and the generator runs, `processShowSeasons()` re-enumerates the season directories and `processSeason()` re-fetches each season's TMDB payload unconditionally (there is no season-level freshness check; the per-*episode* age gate inside is what bounds the work). The season poster is downloaded when TMDB offers one and the existing file is absent **or older than `SEASON_POSTER_REFRESH_DAYS`** (default 1 day) — the grandfathered downloader-side TTL described in §4.3; `downloadSeasonPoster()` also bumps the poster's mtime (`touchFile()`) on success, and `forceDownload` is additionally set on forceRefresh. A season therefore cannot be individually stale, frozen, or cooled down — it inherits everything from its parent show.

---

### Episode (per-episode metadata file + thumbnail)

Episodes have **two genuinely separate refresh mechanisms**. They share the write target (the per-episode metadata JSON in the season directory) but nothing else — different triggers, different gates, different bookkeeping. Treating them as variants of one system is how the freeze-bypass bug happened; do not conflate them.

#### Mechanism i — age-based refresh

Lives in `metadataGenerator.mjs` `processEpisode()`. Whenever the generator processes the show (i.e., the parent passed the scanner's gate *and* the freeze gate), each episode's metadata file is checked by **file mtime age only**: younger than `EPISODE_METADATA_REFRESH_DAYS` (default **4 days**, env-overridable) → skip; otherwise fetch `getEpisodeDetails()` and **rewrite unconditionally** — no sparseness check, no comparison against the previous content, no cooldown table. A file that TMDB returns identical bytes for still gets rewritten (mtime bump). `forceRefresh` bypasses both the age gate and the TMDB response cache.

Properties: unconditional, schedule-shaped ("keep recent episodes fresh"), zero persistent bookkeeping, gated only by the parent show's freeze and the scanner having a reason to invoke the generator at all.

#### Mechanism ii — air-date-aware sparse backfill

Targets a different problem: an episode whose metadata file **exists but is thin** because TMDB hadn't filled it in yet at fetch time (common for just-aired episodes). Split across the two layers per the I/O contract:

- **Scanner side** (`tv-scanner.mjs` `backfillMissingEpisodes()`): zero-I/O candidate detection from presence flags already in the built seasons object — `ep.metadata && !ep.thumbnail` is the cheap proxy for "present but thin" (a complete episode has a downloaded thumbnail). Episodes with no metadata file at all are *not* candidates; those belong to the `dirHashChanged` full-generator path. Candidates are annotated with their cooldown `lastAttempt` from the `episode_metadata_missing` table and handed off. Runs from two call sites: the fast-skip path (so a stable show still gets backfill — with `tmdb.config` loaded lazily only when candidates could exist) and after the post-processing save. Both pass the freeze gate; the parameter fails closed (see above).
- **Generator side** (`metadataGenerator.mjs` `refreshMissingEpisodes()`): owns every schema decision. Re-reads the file and confirms actual sparseness (`isEpisodeMetadataSparse()` — thin when `name`, `overview`, or `still_path` is absent; locked definition); a non-sparse file reports `resolved` so the scanner clears the cooldown row. The due-gate (`isEpisodeBackfillDue()`) requires: a known `air_date` (TBA episodes never poll), now within `EPISODE_MISSING_WINDOW_DAYS` (default **90 days**) of air date, and at least `EPISODE_MISSING_RETRY_DAYS` (default **3 days**) since `lastAttempt`. A due fetch bypasses the TMDB response cache (otherwise it would re-read the same cached sparse response forever) and **writes only on a non-sparse result** — a still-thin response stamps the cooldown but does not bump the file's mtime (so no false hash movement). Errors count as attempts so failures back off too.
- **Bookkeeping** (`scanner-repository.mjs` → `sqliteDatabase.mjs`): `episode_metadata_missing` is keyed `(show_name, season_number, episode_number)` with `air_date`, `last_attempt`, `attempts`. `recordEpisodeAttempt()` upserts on attempt; `clearEpisodeRetry()` deletes on resolution.

**Expired-row pruning (R‑3, shipped in Branch 3):** `refreshMissingEpisodes()` surfaces `expired: true` for a candidate past the give-up window (`isEpisodeBackfillExpired()` — `EPISODE_MISSING_WINDOW_DAYS` after a known air date), and `backfillMissingEpisodes()` in `tv-scanner.mjs` calls `clearEpisodeRetry()` for it — but **only when a cooldown row actually exists** (checked against the `lastAttemptOf` map already in scope): a permanently-thin old episode reports `expired` on every pass forever, and an unconditional DELETE would be a per-tick write-transaction no-op for each one. Return/count semantics are unchanged — `expired` increments neither `written` nor `retried`.

A backfill that actually writes an episode file on the fast-skip path triggers an inline season-rebuild + rehash so the fill-in reaches the frontend in one scan instead of two.

| | Mechanism i (age-based) | Mechanism ii (backfill) |
|---|---|---|
| Trigger | file mtime ≥ 4 days, generator running anyway | file present but thin, air date known |
| Write policy | unconditional rewrite | only on non-sparse TMDB response |
| Cooldown | none | 3-day per-episode, `episode_metadata_missing` |
| Give-up | never | 90 days after air date (row pruned when one exists — R‑3, shipped) |
| Freeze gate | inherited from `generateForShow()` | explicit `updateAllowed` param, fail-closed |

---

### `tmdb.config` file

Per-title operator control file, loaded exclusively through `node/utils/tmdbConfig.mjs` (`loadTmdbConfig()` / `saveTmdbConfig()` — no other module may hand-parse it). Field-by-field reference: Appendix B.

```
Absent (defaults) ──► Present, no id ──► Id-pinned ──► Frozen / Override-managed
        ▲                                   │                (orthogonal flags)
        │                                   ▼
        └──── accidental deletion ◄──── Edited (mtime bump → Config-edit-stale)
```

- **Absent.** `loadTmdbConfig()` returns `createDefaultConfig()` — `{ update_metadata: true, backdrop_focal: null }`. Everything runs on defaults: title-search auto-matching, no freeze, no overrides.
- **Id-pinned.** Either the operator writes `tmdb_id`, or the scanner-driven generator does it itself: when a title search succeeds, `updateTmdbConfigWithId()` persists the found id. Verified in current code: this function is still an **add-only one-way ratchet** — it writes `tmdb_id` only `if (!config.tmdb_id)` and never overwrites an existing one. The generator can therefore pin an id but can never change or unpin it; correcting a bad auto-match is always a manual config edit. The "already up to date" branch of `generateForShow()` (which needs an id for season processing) adopts the trusted id from the fresh `metadata.json` first and persists it through the same ratchet (G-3, shipped) — the unvalidated name-search-and-pin runs only as a last resort when the file carries no usable id.
- **Edited.** Any mtime bump makes the title Config-edit-stale (see the show/movie entry) on the next scan tick.
- **Validation coercions** (`validateTmdbConfig()`, applied on both load and save): non-integer/≤0 `tmdb_id` is silently deleted; non-boolean `update_metadata` is coerced to `true` (freeze fails open); invalid `backdrop_focal` values become `null`. Invalid JSON in the file is *not* coerced — `loadTmdbConfig()` throws, and the generator's catch turns the whole item into a failed generation until the file is fixed.
- **Terminal hazard — accidental deletion silently reverts to defaults.** Verified: there is no tombstone, backup, or warning path. On the next scan after `tmdb.config` disappears, `loadTmdbConfig()` returns defaults as if the file never existed: the pinned `tmdb_id` is gone (the generator falls back to first-result title search — potentially re-introducing the exact wrong match the pin existed to fix), `update_metadata: false` is gone (a frozen title silently thaws and TMDB churn resumes, overwriting whatever the freeze was protecting), and every `metadata` / `override_<kind>` override is gone (the next regeneration writes pure TMDB data; override-sourced images become stale-by-URL and get reconciled away in enforce mode). Nothing in the system can distinguish "operator deleted the config intentionally" from "file lost by accident". Treat `tmdb.config` files as operator data worth backing up; the system will not protect them.

---

### `metadata.json` file

The per-title TMDB payload snapshot (with overrides merged), written only by the generator.

```
Absent ──► Written (fresh fetch) ──► Stale (age > 24 h or config newer) ──► rewritten
                    │
                    └──► Frozen-untouched ──► Overridden-while-frozen (write on override change only)
```

- **Refresh triggers** (`node/utils/fileUtils.mjs` `shouldRefreshMetadata()`): file absent, file older than 24 hours (`maxAgeHours` default), or `tmdb.config` mtime newer than the file. Note the 24 h age trigger lives in the *generator's* check; the *scanner's* own `missingMetadata` boolean covers only absent-or-config-stale — a merely-old `metadata.json` is refreshed only when something else causes the generator to run.
- **Frozen behavior matrix.** Verified end-to-end in `generateForShow()` / `generateForMovie()` → `_applyOverridesWhileFrozen()`:

  | `metadata.json` | Overrides in config | Outcome while frozen |
  |---|---|---|
  | present | none / empty `{}` | untouched, forever |
  | present | present | overrides merged in; written only if the merge changes content |
  | **absent** | present | file **recreated containing only the override keys** — a partial, non-TMDB file that satisfies "metadata exists" |
  | **absent** | none | **never comes back** — see below |

- **Composite hazard — deleting `metadata.json` while frozen never gets it back (no overrides case).** Trace as of Branch 3: the deletion changes the directory hash, so the next tick processes the title and invokes the generator once; the freeze check runs **before** any fetch or write path, `_applyOverridesWhileFrozen()` finds no overrides and returns `applied: false`, and the generator exits with `reason: 'updates-disabled'` having touched nothing. The scanner's post-attempt bookkeeping sees frozen + still missing + no overrides and **clears** any cooldown row (paused is not failing), and the frozen-metadata gate (§4.2) does not re-offer the title — so the no-op fires once per directory change, not on a 24 h cycle. The title's DB row degrades to whatever can be derived without metadata, and the frontend loses the title's metadata at the next sync. This is the sharpest edge of "filesystem is ground truth + operator freeze": the freeze protects the *file*, but only if the file exists. Recovery is manual: either restore the file from backup or temporarily set `update_metadata: true` for one scan tick — either edit bumps `tmdb.config`'s mtime, flips `dirHashChanged`, and is picked up immediately with no stale cooldown in the way. The overrides variant is only partly better — the recreated file contains *only* the overridden keys, not the TMDB payload.

---

### Image files (poster / backdrop / logo, plus season posters and episode thumbnails)

The three top-level kinds are defined once in `node/components/media-scanner/domain/image-conventions.mjs` (canonical prefixes `poster`/`backdrop`/`logo` for movies, `show_*` for TV; accepted extensions per kind, `svg` for logos). The downloader (`node/utils/imageDownloader.mjs`) is deliberately dumb for these three top-level kinds: a plain existence check per target path, no staleness logic — **the generator alone decides when to delete a file so the downloader is forced to re-fetch** (§4.3; the season-poster and episode-thumbnail paths carry the grandfathered downloader-side TTLs described there).

```
Absent ──► Downloaded/managed (DB-tracked *FilePath) ──► Orphaned │ Stale-by-config ──► deleted (enforce) ──► re-downloaded
Manual/untracked ──► preserved ──────────────────────────────────────────────► force-wiped (forceRefresh only)
```

- **Managed vs manual.** A file is "managed" only if its path is recorded in the DB row's `posterFilePath`/`backdropFilePath`/`logoFilePath` columns — the scanner hands these to the generator as `previousPaths` precisely so the generator can distinguish files it wrote from files a human placed. Manual files at non-canonical names are never touched; a manual file at the *canonical* name survives reconcile (strict `previousPath === expectedPath` ownership check in `_reconcileImageOwnership()`) but **not** a forceRefresh (below).
- **Orphaned.** The previously-managed path differs from what the current effective URL would produce (e.g. an override URL's extension changed). Reconcile deletes the old file so the downloader writes the new one.
- **Stale-by-config.** The DB-tracked file matches the current expected path but its mtime predates the latest `tmdb.config` edit. Reconcile deletes it so the same filename is re-fetched fresh.
- **Reconcile mode.** Both deletions above run through `_safeUnlinkOwned()`, gated by the `SCANNER_RECONCILE_MODE` env: `off` (no-op), `dry-run` (log "would delete", touch nothing), `enforce` (actually unlink, including the `.blurhash` sidecar). Verified current default: **`dry-run`** — out of the box, orphan/stale images are logged but never remediated. Decided 2026‑07‑07 (I‑1, **not yet implemented**): the default flips to `enforce`, with `dry-run` becoming the opt-out.
- **Force-wiped.** On `forceRefresh` (config-edit-stale or an explicit full rescan), `_wipeManagedImagesForForceRefresh()` deletes **every accepted extension at every canonical prefix**, plus season posters (`processSeason()`) and episode thumbnails — via `_forceWipeImage()`, which is explicitly *not* gated by reconcile mode (operator intent overrides the cautious default) and also removes `.blurhash` sidecars. This wipe does not check DB ownership: a manual file sitting at a canonical name is deleted too (tracked as I‑2). Override-sourced art survives the cycle in effect — `override_<kind>` URLs win the precedence and are immediately re-downloaded after the wipe.
- **URL precedence** (verified in `_reconcileImageOwnership()` and the downloader): `override_<kind>` from `tmdb.config` beats the metadata `<kind>_path`. When the effective URL is empty (TMDB dropped the asset, no override), any previously-managed file is deliberately **preserved** and logged, per the "keep what was previously approved" rule.
- **Overrides are URL-only; local-art curation is direct file placement (decided 2026-07-07, I-7b).** `override_<kind>` values are resolved as TMDB CDN paths (or, once Branch 6 ships, full URLs); there is deliberately **no mechanism for an override to reference an admin-uploaded local file** — no uploads root, no copy-from-local branch — and none is planned absent a concrete non-filesystem curation surface (e.g. a Discord bot upload flow). The supported path for curating art on a title with no TMDB match is to **place the file directly at the convention filename** with no override set: a manual file at the canonical name survives reconcile (subject only to the force-wipe caveat above).

---

### `.blurhash` sidecar files

Every image file may carry a `<image-path>.blurhash` sidecar holding its encoded blurhash. These have their own entangled lifecycle because **three pipelines populate them and almost nothing cleans them up**:

1. **Download-inline** — `imageDownloader.mjs` `downloadImageWithBlurhash()` (a wrapper around the blurhash-unaware `downloadImage()`) generates the sidecar immediately after fetching an image (and deletes a pre-existing sidecar before any re-download so it regenerates from the new bytes).
2. **Scanner-lazy** — `node/utils/utils.mjs` `getStoredBlurhash()` generates a missing sidecar on demand whenever the scanners resolve an image during asset processing (`movie-scanner.mjs`, `tv-scanner.mjs` — show images, season posters, episode thumbnails). This is how manually-placed images acquire sidecars.
3. **Scheduled sweep** — the blurhash-hashes job (`node/sqlite/blurhashHashes.mjs`, enqueued at minutes 8, 26, and 44 past each hour — roughly every 18–24 minutes — from `node/app.mjs`, plus a full pass at startup) walks DB-known image paths and calls the same `getStoredBlurhash()`, backfilling any sidecar the other two pipelines missed.

Cleanup paths: (a) `_safeUnlinkOwned()` removes the sidecar alongside its image — **only in reconcile `enforce` mode**, which is not the shipped default; (b) `_forceWipeImage()` removes it during a forceRefresh wipe; (c) the downloader's pre-re-download delete; (d) the scheduled sweep's version-upgrade unlink — `updateAllMovieBlurhashHashes()` in `node/sqlite/blurhashHashes.mjs` deletes a movie poster/backdrop/logo sidecar whose row's `generation_version` is below `BLURHASH_GENERATION_VERSION` (gated by `shouldRegenerateBlurhash()`), forcing `getStoredBlurhash()` to regenerate it under the current sizing policy. There is no orphan sweep: an image deleted by any path outside those four leaves its sidecar behind indefinitely. Under the current `dry-run` default, (a) never fires, so the practical cleanup surface is forceRefresh, re-download, and version upgrades only. Decided 2026‑07‑07 (I‑1, **not yet implemented**): flipping the reconcile default to `enforce` makes (a) the normal path and closes most of the accumulation.

The `.blurhash` sidecars are also the *only* blurhash source the DB/frontend actually consumes — the separate TMDB-blurhash fields embedded into `metadata.json` by the fetch pipeline are written but never read back by either scanner (tracked as B‑1).

---

### Override (`tmdb.config.metadata` / `override_<kind>`)

Operator-supplied field-level replacements, applied by the generator on every write path (fresh fetch, image-only refresh, and the frozen path via `_applyOverridesWhileFrozen()`).

- **Managed-or-not is presence; application is still truthiness (G‑2, shipped in Branch 2).** `hasMetadataOverrideKey()` in `tmdbConfig.mjs` is the single source of truth for "is this title override-managed": a present `metadata` key — even `{}` or `null` — is an explicit opt-in distinct from absence, and the scanners' frozen-metadata retry gate consumes it. Override *application* is unchanged for now: `getOverride()` returns `config["override_" + field] || null` (an empty-string image override is identical to no override), `getMetadataOverrides()` returns `config.metadata || null`, and a present-but-empty `{}` merges as a no-op. The presence signal becomes fully load-bearing when the pristine-base merge/revert semantics land — any new "override-managed?" check must call `hasMetadataOverrideKey()`, never truthiness or `Object.keys().length`.
- **Merge is shallow, and that is permanent.** `applyMetadataOverrides()` is a one-level spread: `{ ...tmdbData, ...overrides }`. Overriding *any* nested field replaces the **entire top-level key** — e.g. overriding one genre name means supplying the whole `genres` array; overriding a single `cast` entry means supplying the whole cast. Decided 2026‑07‑07 (G‑4): shallow one-level merge is an **accepted permanent limitation**, not a bug to fix — operators overriding structured fields must supply the complete top-level value. Document this in any operator-facing override guide; it is the single most common override-authoring mistake.
- **Overrides survive the events that reset everything else**: they apply during frozen state (their whole point), they re-apply after a forceRefresh wipe-and-repull, and `override_<kind>` image URLs win precedence over freshly-fetched TMDB paths. The one event they do *not* survive is `tmdb.config` deletion (see that entity's terminal hazard).

---

**Derived-state entities** — the remaining entries live in SQLite, in-process memory, or temp/cache directories. With two exceptions called out explicitly (cooldown rows and `discord_intros`), every one of them is **derived state**: deletable and rebuildable from the filesystem plus TMDB, never a source for reconstructing `metadata.json`, `tmdb.config`, or images.

| Entity | Store | Derivable? | Deletion path exists? |
|---|---|---|---|
| `movies` / `tv_shows` row | SQLite `main` | Yes (rebuilt by scan) | Yes — scan removal loop |
| TMDB cache row | SQLite `tmdb_cache` | Yes | Yes — probabilistic sweep + admin routes |
| TMDB blurhash cache row | SQLite `tmdb_blurhash_cache` | Yes | **No live path** (helpers exist, zero callers) |
| `metadata_hashes` row | SQLite `main` | Yes (lazily regenerable) | Yes — removal-loop cascade (`deleteHashesForMedia`, Branch 5) |
| Cooldown rows (`missing_data_media`, `episode_metadata_missing`) | SQLite `main` | **No** — genuinely non-derivable | Partial (cleared on resolution; no removal cascade) |
| `process_queue` row | SQLite `processTracking` | Operational telemetry — fully disposable | No delete in production paths; upsert-bounded |
| In-memory task/job registries | Process memory | Disposable by design | Lost on restart |
| `discord_intros` row | SQLite `discordIntros` | **No** — records an external side effect | Manual helpers only |
| Caption temp files | `CAPTIONS_TMP_DIR` | Yes | Per-job `finally` + startup orphan sweep |
| Chapter `.vtt` files | Media directories | Yes (from mp4 chapter atoms) | **None** — generated-if-absent, never invalidated |
| Pristine-base column (`pristine_metadata`) | SQLite `main` | Yes (from a genuine TMDB fetch) | Column + population shipped (Branch 1, this tree); trust/merge semantics are Branch 2 — unshipped |

### DB row (`movies` / `tv_shows`)

*Nonexistent* → *inserted* → *updated* → *deleted* (directory removed from disk).

Owned exclusively by the repository layer (`node/components/media-scanner/data-access/scanner-repository.mjs`, delegating to `node/sqliteDatabase.mjs`). The two upserts are deliberately asymmetric:

- `insertOrUpdateMovie()` carries a change-guard: the `ON CONFLICT ... DO UPDATE` only fires when `directory_hash` moved, with two backfill escape hatches for rows written before a column existed (`backdrop_focal_suggested IS NULL`, and — Branch 1 — `movies.metadata IS NULL AND excluded.metadata IS NOT NULL`) — an unchanged movie is otherwise not rewritten. The metadata hatch is driven by a one-shot scanner-side backfill: `movie-scanner.mjs` skips its unchanged-directory early return once per row while `movies.metadata` is NULL and a `metadata.json` exists.
- `insertOrUpdateTVShow()` has no guard and always rewrites.

Decided 2026-07-07 (P-2): the asymmetry is intentional, not an oversight — TV's shallower directory-hash depth plus the episode-backfill fall-through means a movies-style guard on TV could silently drop a real write. A "make it symmetric" refactor would reintroduce that bug.

Schema note: `tv_shows` has a `metadata TEXT` column carrying the show's metadata content; historically `movies` had no equivalent, which was the root cause of the movie hash-clobber defect (F-1, below) and one of the two pristine-base hazards (G-5, below). **Implemented (Branch 1, this tree):** one startup migration (`migrateToSchemaParityColumns()` in `node/sqliteDatabase.mjs`, ALTER TABLE ADD COLUMN only, idempotent) adds `movies.metadata` (F-1) plus `pristine_metadata` on both tables (G-5) plus the three I-3 `*_source_url` columns on both tables (schema only — their population/reconcile logic is a separate decided branch).

---

### TMDB cache row — the most defect-dense entity in the system

Table `tmdb_cache` (its own DB file, `tmdb_cache.db`; schema in `node/sqliteDatabase.mjs`): `cache_key` (UNIQUE), `endpoint`, `request_params`, `response_data`, `created_at`, `expires_at`, `last_accessed`. There is **no ETag column**.

**Creation.** Every TMDB call flows through `node/utils/tmdb.mjs` `makeTmdbRequest()`. On a 200 response the (optionally blurhash-enhanced) payload is upserted via `setTmdbCache()` in `node/sqliteDatabase.mjs`, keyed by `md5(endpoint + sorted params)` — or, for blurhash-enhanced responses, a distinct plain-text key suffixed `_blurhash` (`node/utils/tmdbBlurhash.mjs` `generateBlurhashCacheKey()`). Reads (`getTmdbCache()`) filter on `expires_at > now`; `forceRefresh` bypasses the read but still writes back.

**TTL.** Uniform 60 days (`ttlHours = 1440` default in both `makeTmdbRequest()` and `setTmdbCache()`), across every endpoint — search, details, credits, images, episodes. Decided 2026-07-07 (T-2): the uniform TTL **stays**; endpoint-specific TTLs (e.g. shorter for rating-bearing details) were considered and rejected.

**Eviction.** Two live paths: a probabilistic sweep — each `makeTmdbRequest()` call has a 10% chance of fire-and-forget deleting all expired rows — and admin routes on the `/api/tmdb` router (`DELETE /cache`, `DELETE /cache/expired`, both `authenticateUser + requireAdmin`). No scheduled job.

**Dead ETag plumbing (T-1).** Conditional revalidation is wired in code but dead end-to-end, in three compounding ways, all verified current:

1. `makeTmdbRequest()` accepts an `ifNoneMatch` parameter and would send `If-None-Match` and handle a 304 — but **no caller anywhere passes it** (every call site supplies at most 6 arguments; `ifNoneMatch` is the 7th).
2. `makeTmdbRequest()` captures the response ETag and passes it as a **6th argument to `setTmdbCache()` — whose signature has only 5 parameters.** The ETag is silently discarded at the call boundary.
3. Even if it weren't discarded, `tmdb_cache` has no column to store it, so there is nothing to send on a later conditional request. The `_etag` field returned to callers is likewise never persisted by anyone.

The 304-handling branch and the log line claiming a response was "cached … with ETag" are therefore unreachable/misleading. Decided 2026-07-07 (T-1): the plumbing is to be **wired up for real** — an `etag` column on `tmdb_cache`, a `setTmdbCache()` signature that actually persists the captured ETag, and a real caller passing the stored value as `If-None-Match` on revalidation so the 304 branch becomes reachable (Branch 7, not yet implemented). Until that ships, treat every ETag mention in `tmdb.mjs` as inert.

**Cache-write telemetry always reports `cache_hit=false` (T-6).** The write is wrapped in `withApiCacheSpan({operation: 'SET', ...})` (`node/lib/apiTracer.mjs`), which derives `api.cache_hit` from whether the wrapped function returned a non-null value. `setTmdbCache()` returns `undefined` on **every** path (success, invalid-TTL early return, and caught error), so every cache write is recorded as a miss on the same metric that read-side hits use. Any dashboard computing a TMDB hit ratio from `api.cache_hit` is polluted by writes. Planned fix (Branch 7, not yet implemented): explicit `return true/false` from `setTmdbCache` and a distinctly named write-success attribute.

**Admin "refresh" refetches eagerly (A-3, implemented in Branch 9).** `POST /api/tmdb/cache/refresh` (admin) drops the matching row via `refreshTmdbCacheEntry()` in `node/sqliteDatabase.mjs`, then calls `makeTmdbRequest()` with `forceRefresh` so the fresh response is fetched live and re-cached through the normal `setTmdbCache()` upsert. Response contract: `refreshed` keeps its original meaning ("a cached row existed and was dropped"), and a new `fetched` field reports the eager refetch; if the refetch fails after the delete, the route returns **502** with `fetched: false` — the stale entry is already gone, and the next organic read refetches. One sharp edge remains by design: the endpoint computes the plain `generateTmdbCacheKey()`, so it can never address a blurhash-enhanced entry's custom key (`generateBlurhashCacheKey` in `node/utils/tmdbBlurhash.mjs`) — those variants are unreachable from this endpoint and age out via TTL (documented limitation, accepted with the A-3 decision).

---

### TMDB blurhash cache row

Table `tmdb_blurhash_cache` (co-located in `tmdb_cache.db`; `node/sqlite/tmdbBlurhashCache.mjs`): one row per TMDB image URL with its computed blurhash, 90-day TTL (`ttlHours = 2160` default in `cacheTmdbBlurhash()`), plus `last_accessed` refreshed at most every 6 hours on read.

*Absent* → *written on first blurhash computation* (`cacheTmdbBlurhashWithDb()`) → *logically expired* (reads filter `expires_at > now`) → **never physically deleted**.

Eviction was verified directly, since it had never been checked: **no eviction path is live.** Three deletion helpers exist — `clearExpiredTmdbBlurhashCache()` (TTL sweep), `cleanupOldTmdbBlurhashCache()` (LRU by `last_accessed`), `clearTmdbBlurhashCache()` (admin wipe) — and none has a single call site. `clearExpiredTmdbBlurhashCacheWithDb` is even imported by `node/utils/tmdbBlurhash.mjs` and then never invoked (a dead import). The `tmdb_cache` probabilistic sweep and the admin `DELETE /cache*` routes touch only the `tmdb_cache` table, never this one. Expired rows accumulate forever; growth is bounded only by the number of distinct TMDB image URLs ever blurhashed (rows are upserted by URL, so re-processing does not duplicate).

---

### Process-tracking queue (`process_queue` + in-memory task registry)

Two genuinely separate mechanisms share the "what is the backend doing right now" role:

**1. SQLite `process_queue`** (`node/sqlite/processTracking.mjs`, its own DB file). One row per `file_key` (UNIQUE), tracking `process_type` (`spritesheet`, `vtt`, `caption`), step counters, `status`, and a message.

*Absent* → *created/upserted* (`createOrUpdateProcessQueue()`, called from `node/sprite-route.mjs` for spritesheet/VTT jobs and `node/components/caption-generator/entry-points/caption-controller.mjs` `trackProcess()` for caption jobs) → *stepped* (`updateProcessQueue()`) → *finalized* (`finalizeProcessQueue()` → `completed` or `error`) → *interrupted* (startup: `node/app.mjs` calls `markInProgressAsInterrupted()`, flipping any `in-progress` row to `interrupted`).

There is **no deletion in any production path**: `resetProcessQueue()` and `removeInProgressProcesses()` exist (the latter is even imported by `app.mjs`) but are never called. Terminal rows persist indefinitely; growth is bounded because `file_key` upserts in place — one row per media item × process type, ever. Note the startup log line says "Process queue has been reset", which overstates what `markInProgressAsInterrupted()` does (it marks, it does not delete).

Read surface: `GET /processes` and `GET /processes/:fileKey` in `node/app.mjs`, both behind `authenticateWebhookOrUser`, with optional `processType`/`status` filters.

**Tier, honestly:** this is *operational telemetry*, not durable state and not a real queue — nothing dequeues from it, and losing the file costs nothing but progress display history. It is the most disposable table in the system; it does not merit the non-derivable durability posture of the cooldown or intro tables.

**2. In-memory task manager** (`node/lib/taskManager.mjs`): `activeTasks`/`taskQueues` Maps plus a 3-entry-per-type completion history. This is the actual concurrency/scheduling mechanism (`enqueueTask()`, priority + concurrency limits + exclusivity groups). Purely process-local, lost on restart by design, surfaced read-only via `getTaskStatus()` (consumed by `node/routes/systemStatus.mjs` and the caption health endpoint). `TaskType.BLURHASH` exists in both the enum and the concurrency-limit map in this tree — the historical enqueue-under-nonexistent-type bug (S-1) is fixed.

---

### Cooldown / bookkeeping rows — the non-derivable exception

Two tables in the `main` DB, owned by the repository layer. These are the canonical exception to "SQLite is disposable": they encode when the scanner last attempted a retry, which cannot be reconstructed from disk or TMDB.

**`missing_data_media`** (show/movie-level metadata cooldown): *absent* → **marked on confirmed failure** (Branch 3, G-1a + R-1 + R-2) — the scanner invokes the generator first and stamps the row only when metadata is still missing afterward for a non-frozen reason (`resolveCooldownAction()` in `cooldown-policy.mjs`; frozen no-overrides outcomes *clear* instead) → *cooldown-active* (24h, `RETRY_INTERVAL_HOURS`) → *cleared* when both metadata and images resolve (clears are skipped when no row exists, avoiding no-op DELETEs). A row's presence now genuinely means "the last attempt failed".

**`episode_metadata_missing`** (air-date-aware sparse-episode backfill): *absent* → *inserted with attempt counter* → *retried every ≥3 days* (`EPISODE_MISSING_RETRY_DAYS`) → *cleared on resolution* (`clearEpisodeRetry`) → *given up* past 90 days after air date (`EPISODE_MISSING_WINDOW_DAYS` in `node/lib/metadataGenerator.mjs`; `isEpisodeBackfillExpired()` reports it terminally) — **given-up rows are pruned** (Branch 3, R-3): `refreshMissingEpisodes()` surfaces `expired: true` and the scanner clears the row, gated on the row actually existing so permanently-thin episodes don't cost a no-op DELETE per tick.

Both tables cascade on removal (R-4, shipped in Branch 5): the scanners' removal loops clear the title's `missing_data_media` row and — for shows — every `episode_metadata_missing` row via `clearEpisodeRetryForShow()`, alongside the `metadata_hashes` cascade. A same-named title re-added later starts with clean retry history.

---

### `discord_intros` row — non-derivable

Table in its own DB file (`node/sqlite/discordIntros.mjs`): one row per Discord `user_id` (UNIQUE) recording that an introduction DM was sent, with username, timestamp, and bot version.

Write side, verified in `node/integrations/discord/utils/introductionDM.mjs` `sendIntroductionDM()`: check `hasReceivedIntro()` → skip if present → send the DM via the Discord API → `recordIntroSent()` **only after a successful send**. Triggered from `node/integrations/discord/routes.mjs` `processUserAuthorization()` (the `APPLICATION_AUTHORIZED` webhook event) and from the bot runtime (`bot.mjs`).

This table is **genuinely non-derivable**: it records an external side effect (a DM that already landed in someone's inbox). Losing it does not lose data the system can refetch — it loses the *guard*, and every configured notify-user would receive a duplicate onboarding DM. Deletion exists only as manual helpers (`removeIntroRecord()`, `clearAllIntroRecords()`) with no route or scheduled caller; the documented resend procedure is a manual script (`WEBHOOK_EVENTS_SETUP.md`). Decided 2026-07-07 (P-3): the shared relaxed-durability SQLite posture is accepted even for this table — worst case is one duplicate DM, bounded and idempotency-guarded going forward.

---

### Caption temp files + in-memory dedupe registry + orphan sweep

All in `node/components/caption-generator/entry-points/caption-controller.mjs`.

**Temp files.** Each job derives a `sha1(videoPath)`-prefixed `.wav` and `.srt` in `CAPTIONS_TMP_DIR` (default `<cache>/captions`). Lifecycle: *created during `runJob()`* → *consumed* (post-processed SRT is atomically renamed into the media folder as the durable artifact) → *deleted in the job's `finally`* regardless of success. Only a crash mid-job can strand them.

**In-memory registry.** `jobs` (jobId → state) and `dedupeIndex` (`videoPath::lang` → jobId) Maps. *Queued* → *running* → *succeeded/failed*; the dedupe entry is removed on terminal state, so a concurrent request for the same (video, language) joins the in-flight job instead of double-transcribing (`findInflightJob()`). Capped at 500 entries with LRU pruning of terminal jobs (`pruneJobsIfNeeded()`). Explicitly lost on restart by design — the `.auto.srt` on disk is the durable record, so re-enqueue is cheap and self-healing. Job status mirrors into `process_queue` (type `caption`) via best-effort `trackProcess()` writes that swallow SQLite errors.

**Startup orphan sweep.** `sweepOrphanTempFiles()` — invoked once from `node/app.mjs` startup — deletes any file in `CAPTIONS_TMP_DIR` older than 1 hour (`ORPHAN_AGE_MS`), reclaiming the crash-stranded case above. There is no recurring sweep; a long-lived process that crashes jobs *after* startup re-strands files until the next restart.

---

### Chapter `.vtt` files

Derived from mp4 chapter atoms (`chapterInfo()` in `node/ffmpeg/ffprobe.mjs` → `node/chapter-generator.mjs` `generateChapters()`, which returns VTT text and **never writes to disk itself**). Written into `chapters/` subdirectories alongside the media.

*Absent* → *generated* → **terminal**. There is no staleness or cleanup path anywhere: every writer is generate-if-absent, so a chapters file is never regenerated when its source mp4 is replaced, and never deleted when the media is removed.

Three generation entry points, with a critical asymmetry:

1. **Lazy, on first playback request** — `node/app.mjs` `handleChapterRequest()` → its local `generateChapterFileIfNotExists()`: probes `chapterInfo()`, generates, writes the file, serves it. Fully working, for movies and TV.
2. **TV scan-time pregeneration** — `tv-scanner.mjs` `generateChapterFileIfNotExists()`: probes, generates, `mkdir` + `writeFile`. Fully working.
3. **Movie scan-time pregeneration — a silent no-op (C-1), verified in this tree.** `movie-scanner.mjs` `generateChapterFileIfNotExists()` calls `generateChapters(mediaPath, quietMode)` — passing the boolean `quietMode` (`true`) into `generateChapters`'s **second parameter, which is `chapterData`**. The truthy `true` short-circuits the real `chapterInfo()` probe, the chapter loop iterates zero times, and the returned VTT string is **discarded** (the movie-scanner helper never writes anything to disk). Net effect per scan tick, for every movie without an existing chapters file: one real ffprobe call (`getVideoDuration()` inside `generateChapters`) burned, no file produced. `processChapters()` then finds no file and returns no chapters URL, so movie chapters only ever materialize via path 1.

Decided 2026-07-07 (C-1): **wire real movie pregeneration to match TV** — fix the call so it actually probes the chapter atoms and writes the VTT file at scan time, mirroring the working TV helper — not yet implemented. The scan already pays the ffprobe cost today; the fix makes that cost produce the file. Until it ships, the movie-scanner call is dead weight and movie chapters only materialize via the lazy path (1).

---

### `metadata_hashes` row

Table in the `main` DB (`node/sqlite/metadataHashes.mjs`): one row per logical key (`media_type`, `title`, `season_number`, `episode_key`) with `hash`, `content_hash` (show-level aggregate), `last_modified`, and `data_version`. This is the gate the frontend sync uses to skip unchanged items, so a wrong-but-stable hash means silently stale frontend data.

Lifecycle: *absent* → *generated* (scanner immediate path, scheduled sweep, or lazy read-side backfill) → *replaced* (delete-then-insert in `storeHash()`, which is what collapses the historical NULL-key duplicate rows) → *mixed at read time* with an autoCaptions-config fingerprint on most read paths (`mixAutoCaptionsHash()` in `getMediaTypeHashes()`, `getShowHashes()`, and `getSeasonHashes()` — the stored hash never reflects caption-stub state, so it is combined per-request; the one exception is the single-title **movie** branch of `GET /api/metadata-hashes/:mediaType/:title` in `node/routes/metadataHashes.mjs`, which serves the raw stored hash unmixed, so an autoCaptions config toggle moves the bulk and TV hashes but not that endpoint's — arguably a code gap worth tracking) → deleted, in principle, by `deleteHashesForMedia()` — see F-3.

**Writers, and who is content-aware:**

- **Scanner immediate path (content-aware).** `movie-scanner.mjs` parses `metadata.json` into a canonical fingerprint string, persists it to `movies.metadata` via `saveMovie()`, then re-reads the row through `getMovieByName()` and hashes THAT (so its hash input is the column value verbatim); `tv-scanner.mjs` calls `generateTVShowHashes()` with the freshly saved show (whose `tv_shows.metadata` column carries content).
- **Scheduled sweep (content-aware for both types — F-1 fixed, Branch 1, this tree).** A cron at minutes 5/20/35/50 (`node/app.mjs`) runs `updateAllMovieHashes(sinceTimestamp)` / `updateAllTVShowHashes(sinceTimestamp)` with `sinceTimestamp = now − 16 min`, processing titles whose media mtime moved in that window. Both are content-aware: `getTVShows()` rows include `metadata`, and `getMovies()` rows now return `movies.metadata` verbatim, so both writers fold byte-identical content for the same on-disk state and cannot flip the stored hash back and forth. (Historically the movie sweep hashed `metadata: undefined` and could clobber the scanner's content-aware hash — the F-1 defect.) Expected one-time effect of the fix: titles whose stored hash was last written by the content-blind sweep re-sync once on their first content-aware pass; a one-shot scanner-side backfill (see the DB-row entry above) drives that pass proactively for pre-migration rows.
- **First-scan hash (F-2, shipped in Branch 4).** Both scanners now regenerate the stored hash **unconditionally** after every save on their full-process path — including a brand-new title's very first scan, so a new title reaches the bulk sync endpoint within one 3-minute scan tick instead of waiting on the sweep's 16-minute mtime lookback or a per-title GET. Unconditional (rather than the once-planned `dirHashChanged`-shaped gates) is deliberate: every pass that reaches the rehash point either inserted or rewrote the row, and a `dirHashChanged`-only gate would miss image-retry passes that change the row without the tick-start hash having moved — the post-download save makes the *next* tick's hash compare clean, so the pass that did the work is the only one that sees it.

**Read-side lazy generation, with one broken leg.** All three fetch functions attempt backfill, but only two work:

- `getShowHashes()` / `getSeasonHashes()` — on a missing row, regenerate via `generateTVShowHashes(db, show)`. Working.
- `getMediaTypeHashes()` (backs the bulk endpoint `GET /api/metadata-hashes/:mediaType`) — on an empty table, runs a full-library `updateAllMovieHashes()` / `updateAllTVShowHashes()` bootstrap. **Fixed in this tree (with Branch 1):** it previously passed the `db` handle into the functions' `sinceTimestamp` parameter, so the truthy object became an Invalid `Date`, every mtime comparison evaluated false, and the bootstrap silently processed zero rows.
- The single-title route (`node/routes/metadataHashes.mjs`) additionally backfills a missing movie hash via `generateMovieHashes()` behind a plain GET — deliberately guarded (404-before-write, generate only when no row exists) and accepted as safe (A-5, decided 2026-07-07). Since Branch 1 `getMovieByName()` carries the `movies.metadata` fingerprint verbatim, so this fallback now writes the same content-aware hash the scanner and sweep would — the code comment there still explains why it must stay a missing-row-only fallback (regenerating on every GET would be a redundant DB write per request; the scanner and sweep are the writers of record).

**Dead `data_version` field (F-4).** `HASH_DATA_VERSION` is written into every row and **never read back or compared anywhere** — bumping it does nothing. The sibling table gets this right: `node/sqlite/blurhashHashes.mjs` `shouldRegenerateBlurhash()` compares each row's stored `generation_version` against `BLURHASH_GENERATION_VERSION` and regenerates on mismatch. Decided 2026-07-07 (F-4): wire real version-based invalidation for `metadata_hashes` mirroring that pattern — not yet implemented. (This exact gap has already caused one manual-resync incident when hashing logic changed.)

**Removal-loop deletion (F-3, shipped in Branch 5).** `deleteHashesForMedia()` is called from both scanners' removal loops, alongside the cooldown cascade — removed titles drop their hash rows immediately, so a same-named re-added title generates a fresh hash on its first scan (F-2) instead of serving the stale predecessor's.

---

### Pristine-base column — schema + population shipped (Branch 1, this tree); trust semantics unshipped (Branch 2)

This entry describes the converged Branch 1–2 design. **Branch 1 is implemented in this tree**: the `pristine_metadata` column exists on both tables and is faithfully populated from genuine fetches. The *trust/merge* lifecycle stages below (trusted-as-merge-base, forced-empty, by-id bootstrap) are **Branch 2 — not yet implemented**. (Why it is a SQLite column rather than a file: the design note at the end of §1.5.)

A `pristine_metadata` column on **both** `movies` and `tv_shows`, holding the raw pre-override TMDB payload, to serve as the trusted merge base for override application:

*never-fetched* → *populated* — **shipped**: written **only** from a genuine TMDB fetch this invocation (`generateForMovie()` / `generateForShow()` return `pristineMetadata` — `tmdbData` serialized before `applyMetadataOverrides()` — and the scanners persist it opaquely through `saveMovie()`/`saveTVShow()`; a save without a fresh payload COALESCE-preserves the stored value), never re-synced from `metadata.json` content → *trusted as merge base* — **Branch 2**: **iff** a `tmdb_id` is currently set in `tmdb.config` → *forced-empty* — **Branch 2**: when the id is absent or cleared (the wrong-auto-match correction case: clearing the id must also distrust the base) → *bootstrapped* — **Branch 2**: a one-time **by-id-only** fetch for existing libraries; never a by-name search.

Two hazards the design accounted for:

- **Movie/TV schema asymmetry (G-5) — resolved by Branch 1.** `tv_shows` already had a raw-content-adjacent `metadata` column; `movies` had neither it nor `pristine_metadata`. The shipped migration adds columns to both tables (with the F-1 `metadata` column and the I-3 `*_source_url` columns folded into the same migration to avoid a third ad hoc schema change).
- **Unvalidated-id trust leak from the "already up to date" branch (G-3) — resolved by Branch 2.** `node/lib/metadataGenerator.mjs` `generateForShow()` has a branch where show metadata is fresh but a TMDB id is still needed for season processing. It now adopts the trusted id from the fresh `metadata.json` (written by a previous full generation) and persists it via the add-only ratchet; the unvalidated **name search** (first result, no disambiguation) runs only as a last resort when the file carries no usable id — e.g. an override-only file recreated while frozen. The residual search fallback still carries the auto-match risk T-3's year heuristic will reduce.

One cross-cutting constraint bears repeating here (A-2, decided 2026-07-07): the config-update endpoint's full-replace-drops-omitted-keys behavior is the mechanism the override/pristine-base design relies on to express "revert this override". It must **not** be "fixed" into a merge-on-omit endpoint (see the warning block in §4.6).

## 4. Contracts & boundaries between subsystems

The rules below are hard contracts. Each one exists because a past bug (or a near-miss) showed what happens when it is violated, and each has an explicitly bounded list of known exceptions. A change that breaks one of these is not a refactor — it is an architecture change and needs explicit sign-off. Where a 2026-07-07 decision touches a contract, it is labeled; decided-but-unshipped changes are **not** current behavior.

### 4.1 Scanner ⇄ TMDB schema: the scanner does not know TMDB field names

**Contract.** The scanners (`node/components/media-scanner/domain/movie-scanner.mjs`, `node/components/media-scanner/domain/tv-scanner.mjs`) must never interpret TMDB schema — no field-name knowledge, no reading `metadata.json` *content* to make decisions. Scanner gates are computed only from file presence, mtimes, and cooldown rows. All TMDB-schema, air-date, and metadata-content decisions live in `node/lib/metadataGenerator.mjs` and `node/utils/imageDownloader.mjs`.

**Rationale.** The scanner is a filesystem-inventory layer. Keeping it schema-blind means a TMDB API/schema change is localized to the generator and downloader, and the scanner's retry gates stay explainable purely in terms of what is on disk.

**Blessed, bounded exceptions (the only two):**

1. **Opaque content reads for hash fingerprinting and persistence.** `movie-scanner.mjs` `scanMovies()` parses `metadata.json` into a canonically-serialized `metadataFingerprint` string (compact `JSON.stringify(JSON.parse(file))`, with a serialized `{mtimeMs, size}` stat marker as the unparseable-file fallback), persists it to `movies.metadata` via `saveMovie()`, and both movie-hash writers then consume the **stored column value verbatim** through the DB read-side view (`getMovieByName()` for the scanner's inline rehash, `getMovies()` for the scheduled sweep) — byte-identical input, so the two writers cannot oscillate (F-1). `tv-scanner.mjs` `processShowMetadata()` similarly parse-and-re-serializes the file into an opaque `metadata` string for the DB column and show hash (same stat-marker fallback for an unparseable-but-present file). In both cases the parse only normalizes bytes — no individual field is ever inspected or branched on.
2. **A single-field `id` extraction to seed episode backfill.** Both `backfillMissingEpisodes` call sites in `tv-scanner.mjs` read `JSON.parse(metadataResult.metadata)?.id` to obtain the TMDB id without an extra `tmdb.config` read. This is deliberately bounded to exactly one field; everything else about backfill (sparse-episode definition, air-date window, cooldown math, fetch) lives in `metadataGenerator.mjs` `refreshMissingEpisodes()`.

Anything outside these two shapes — a scanner branch that reads a TMDB field to decide behavior — is a contract violation, even if convenient.

### 4.2 Scanner ⇄ freeze switch: mostly freeze-blind gates, freeze-aware callees, fail-closed

**Contract (narrowed by Branch 3 — see below).** The scanner's *state detection* (`missingMetadata`, image staleness, cooldown math) stays **freeze-blind**: it never consults `update_metadata` to decide what is missing or stale. Enforcement of the freeze belongs to the generator — `metadataGenerator.mjs` `generateForShow()` / `generateForMovie()` both check `isUpdateAllowed(tmdbConfig)` and no-op TMDB writes when frozen. **However**, anything the scanner calls that can *independently* trigger a TMDB write must have freeze-awareness threaded in explicitly, and it must **fail closed** (no argument ⇒ no write). The same fail-closed doctrine covers an unreadable config: both scanners tolerate a `loadTmdbConfig()` parse failure per item (warn-and-continue, so one corrupt file cannot abort the pass or the removal loop) but substitute `update_metadata: false` — an unknown freeze state must not open TMDB write paths off assumed defaults.

**Shipped example (the template for future features).** `tv-scanner.mjs` `backfillMissingEpisodes(showName, showPath, tmdbId, seasons, now, updateAllowed = false)` — the parameter defaults to `false` and the function returns immediately unless the caller explicitly passes `isUpdateAllowed(...)`. Both call sites (the fast-skip path and the full-process path) compute and pass it. A future call site that forgets the argument gets zero backfill rather than silently re-pulling a frozen show.

**Rationale.** `update_metadata: false` is the operator's recovery tool after a bad TMDB auto-match. The episode-backfill feature originally bypassed it (fixed 2026-07-05): the top-level gate was frozen but a side channel kept writing TMDB data. Stated generally so the next scanner-adjacent TMDB writer does not reintroduce the same hole.

**Narrowed contract (R-2, shipped in Branch 3).** The scanners' *retry-gate decision* now consults the freeze flag in exactly two places, and their post-attempt bookkeeping consumes one generator-owned signal. The bounded list:

1. **Images-missing retry gate**: `missingImages && updateAllowed`. A frozen title with a permanently missing image (e.g. TMDB has no logo) is no longer re-offered to the generator every tick — the old R-2 unbounded round trip is gone. An unfreeze is picked up immediately because the `tmdb.config` edit bumps its mtime, flipping `dirHashChanged`, which bypasses every gate.
2. **Metadata-missing retry gate**: `missingMetadata && metadataGateAllowsRetry && (updateAllowed || hasOverrides)` where `hasOverrides = getMetadataOverrides(tmdbConfig) !== null`. A frozen title with metadata overrides still reaches the generator so `_applyOverridesWhileFrozen()` can run (and self-resolves by writing `metadata.json`); a frozen title with *no* overrides is deliberately not re-offered — its post-attempt bookkeeping clears the cooldown row (paused is not failing), so an ungated branch would otherwise loop the full per-title reprocess every tick. Config edits / unfreezes are again covered by `dirHashChanged`.
3. **Reason-string channel (post-attempt bookkeeping)**: the scanners branch on the generator's returned `reason` via `isFrozenReason()` exported from `metadataGenerator.mjs` (`'updates-disabled'` / `'updates-disabled-overrides-applied'`, exported as `REASON_UPDATES_DISABLED*` constants). This is a **contract, not drift**: the reason values are the generator's scanner-facing return contract and must only change in lockstep with `isFrozenReason()`. The mark/clear decision table itself lives in one shared place, `node/components/media-scanner/domain/cooldown-policy.mjs` `resolveCooldownAction()`, consumed by both scanners.

Everything else stays freeze-blind: `missingMetadata`/`missingImages` detection, `dirHashChanged`, `staleByConfig`, and the 24 h cooldown math never consult `update_metadata`. Any freeze-awareness beyond the three items above (plus the pre-existing `backfillMissingEpisodes` threading) is a contract violation requiring sign-off, exactly as before.

### 4.3 Generator ⇄ downloader: the downloader is a dumb existence-check writer

**Contract.** `node/utils/imageDownloader.mjs` never decides whether a file is *stale*. `downloadImage()` / `downloadMediaImages()` do an existence check (`pathExists`) plus retries, concurrency limiting, and blurhash sidecars — nothing else. The generator alone forces a re-fetch, and it does so by **deleting the file first**: `metadataGenerator.mjs` `_wipeManagedImagesForForceRefresh()` (forceRefresh / `tmdb.config` id change) and `_reconcileImageOwnership()` (orphan/stale cleanup; modes `off` / `dry-run` / `enforce`, default `dry-run` via `SCANNER_RECONCILE_MODE`). Do not grow downloader-side staleness logic.

**Rationale.** "Is this file current" must have exactly one owner. Two independent staleness engines (generator deciding via config mtime / overrides, downloader deciding via its own TTL) would disagree, and the losing one silently wins whichever runs last.

**Known bounded exception (grandfathered, must not spread).** `downloadSeasonPoster()` and `downloadEpisodeThumbnail()` carry their own age-based refresh checks inside the downloader (`SEASON_POSTER_REFRESH_DAYS`, `EPISODE_THUMBNAIL_REFRESH_DAYS`). These two per-season/per-episode image kinds have no generator-side reconcile or override coverage, so the TTL lives where the download happens. The top-level kinds (poster / backdrop / logo via `downloadMediaImages()`) are pure existence-check + `forceDownload`, and must stay that way. Decided 2026-07-07 (I-4) — not yet implemented: season posters and episode thumbnails gain the **full per-slot override + DB-tracked provenance model**, mirroring the top-level kinds; once that ships, this grandfathered TTL exception is expected to narrow or disappear rather than spread.

### 4.4 Generator ⇄ DB: the generator never queries the database

**Contract.** `metadataGenerator.mjs` has no database imports and performs no DB reads or writes. When the generator needs prior state (previously-managed image file paths, for orphan detection in reconcile), the **scanner** reads them from the DB row and hands them down — see the `previousPaths` objects built in `movie-scanner.mjs` `scanMovies()` and `tv-scanner.mjs`, threaded through `app.mjs` `runDownloadTmdbImages()` into `MetadataGenerator.generateImages()`. The same pattern runs in the write direction: the Branch 1 pristine-base population (`pristine_metadata`) is a **return value** — `generateForMovie()`/`generateForShow()` return the raw pre-override payload as `pristineMetadata` (non-null only when a genuine fetch ran that invocation) and the scanners persist it opaquely through `saveMovie()`/`saveTVShow()` — the generator still never touches SQLite.

**Rationale.** The generator is instantiated standalone by the admin routes (`routes/admin.mjs` creates `MetadataGenerator` instances with no scanner in sight) and must stay runnable that way. DB schema changes then never ripple into the generator, and the scanner remains the single component that owns SQLite access for the scan pipeline.

### 4.5 SQLite ⇄ filesystem: one-way sink, never a source

**Contract.** The SQLite tables are derived from disk plus TMDB — never the other way around. No feature may reconstruct `metadata.json`, `tmdb.config`, or image files *from DB column content*. The DB may inform **which** items to refresh (the fast-skip backfill path in `tv-scanner.mjs` walks DB-stored `dbShow.seasons` to find thin-episode candidates, and cooldown tables gate retry timing), but the bytes written to disk must always originate from a filesystem scan or a TMDB fetch, never from a DB column.

**Rationale.** The filesystem (plus TMDB as upstream) is ground truth; SQLite is derived, rebuildable state. The moment a DB column becomes a disk-write source, a DB rebuild is no longer safe and every DB bug becomes a potential disk-corruption bug.

**Enforcement clause.** Any proposed feature that writes disk state from a DB column is a presumptive architecture violation and requires explicit sign-off — it is not a judgment call an individual change gets to make in passing.

### 4.6 `tmdb.config` schema ⇄ everyone: only the config module interprets the file

**Contract.** Only `node/utils/tmdbConfig.mjs` parses, validates, or interprets `tmdb.config`. Every consumer goes through its exported accessors — `loadTmdbConfig()`, `saveTmdbConfig()`, `updateTmdbConfigWithId()`, `isUpdateAllowed()`, `getOverride()`, `applyMetadataOverrides()`, `getTmdbConfigFilePath()`. This holds in all live code paths today: `tv-scanner.mjs`, `metadataGenerator.mjs`, and `routes/admin.mjs` all import from the module rather than hand-parsing JSON.

**Rationale.** The file's semantics (defaults injection, `tmdb_id` validation, `update_metadata` truthiness, `backdrop_focal` whitelist) are non-obvious; a second hand-rolled parser would drift from `validateTmdbConfig()` and the two would disagree about what "frozen" or "overridden" means.

**Dead-code hazard.** `movie-scanner.mjs` `extractTMDBId()` hand-parses `tmdb.config` directly, but has zero call sites. If it is ever revived it must be rewritten on top of the config module first; as written it violates this contract.

> **⚠️ Load-bearing sharp edge — do not "fix" (Decided 2026-07-07, A-2).**
> `PUT /api/admin/metadata/config` (`routes/admin.mjs`) is a **full-file replace**: `saveTmdbConfig()` writes exactly the validated client-supplied object, and any key the client omits is **dropped** from the file (only the two baseline defaults, `update_metadata: true` and `backdrop_focal: null`, are re-injected by `validateTmdbConfig()`). This is **intentional and load-bearing**: omit-to-drop is the planned override-revert mechanism for the pristine-base override design — removing an `override_*` or `metadata` key from the submitted config is how an operator expresses "revert this override to the TMDB base." It must **never** be converted to merge-on-omit / PATCH semantics; doing so would silently break override-revert with no obvious connection between the two changes. Clients that want to toggle one field must read-modify-write the whole object (`GET` then `PUT`). If single-field PATCH semantics are ever genuinely needed, they must be a **new, additive endpoint**, leaving this one untouched.

### 4.7 Backend ⇄ frontend: the contract is the hash surface plus the sync push

**Contract.** The only propagation contract with the nextjs-stream frontend is:

- the unauthenticated **hash surface** — `GET /api/metadata-hashes/:mediaType`, `/:mediaType/:title`, `/:mediaType/:title/:seasonNumber` (`routes/metadataHashes.mjs`);
- the webhook-or-admin-authenticated **list endpoints** — `GET /media/movies`, `GET /media/tv` (`app.mjs`);
- the outbound **sync push** — `autoSync()` in `app.mjs` POSTs to `${FRONT_END_1}/api/authenticated/admin/sync` with an `X-Webhook-ID` header, gated by the Mongo-backed `checkAutoSync()` setting.

The backend must not encode assumptions about frontend internals beyond the hash-input fields it already publishes; the frontend decides what to re-pull purely from hash movement.

**Related decisions:**

- **Decided 2026-07-07 (S-3) — not yet implemented:** `POST /media/scan` currently rescans **movies only** (`generateListMovies`). The decision is to **add the symmetric TV on-demand scan path** (routed through the task manager per S-2's gating decision). Frontend adoption is the part that stays open: the nextjs-stream frontend does not call these routes today, so both the movie and TV variants are documented as available-but-unadopted (TBD on the frontend side).
- **Decided 2026-07-07 (P-1a):** `getMovieById()` and `getTVShowById()` in `node/sqliteDatabase.mjs` have zero in-repo callers, and that is deliberate — the by-name/by-id getter pair mirrors the pattern used in the sister nextjs-stream frontend repo, and keeping both codebases on the same idiom makes them easier to reason about together (the by-id surface also stays ready-made). Treat them as a **maintenance contract, not dead code**: do not delete them, and any column added to the by-name getters' processing (image-hash cache-busting, metadata cache-busting, focal fields) must be mirrored into the by-id variants.

### 4.8 Caption concurrency: the task manager owns it

**Contract.** Caption generation concurrency is owned solely by the hardcoded limit in `node/lib/taskManager.mjs`: `concurrencyLimits[TaskType.CAPTION_GENERATE] = 1`. The `maxConcurrent` field in `node/components/caption-generator/data-access/caption-config.mjs` `DEFAULTS` is **dead** — nothing anywhere reads it, and it does not feed the task manager despite appearing to be the tunable for exactly that.

**Decided 2026-07-07 (C-2) — not yet implemented:** the dead `maxConcurrent` field is to be **removed** from the caption-config defaults (and corrected in the plan document that claims it works). The task manager's hardcoded limit stays the single, sole owner of caption concurrency; if per-deployment tuning is ever wanted, it must be built through a task-manager setter, never a second reader of a config field. Until the removal ships, changing the field has no effect, and nothing may start reading it in the interim (a second reader would create exactly the two-owner failure mode below).

**Rationale.** A config field that looks authoritative but is ignored is worse than no field — an operator "tuning" it gets silent non-behavior, and a feature that wired it in *alongside* the hardcoded limit (rather than through the task manager's own setter) would create two owners.

### 4.9 Auth posture summary

The auth levels used throughout the endpoint inventory are defined in `node/middleware/auth.mjs` and `node/middleware/webhookAuth.mjs`; the canonical level table is in Appendix A. (One additional combination, `authenticateUser` + `requireFullAccess` — an authenticated non-limited user — exists in the middleware but appears on full-access user routes rather than anything in the inventory tables.)

Two decisions define the edges of this posture:

- **Decided 2026-07-07 (V-5) — accepted trust boundary:** the **absence of auth (and rate limiting) on ffmpeg-triggering generation routes** — frame extraction (`/frame/...` → `generateFrame`), on-demand transcode/clip serving (`/video/...`), chapter generation, sprite/preview generation — is an **accepted, documented** trust boundary, not an oversight. Network-level protection (private deployment / reverse-proxy controls) is assumed. This extends the pre-existing unauthenticated-streaming-reads precedent to cover generation-triggering requests. Any future change that wants auth here is a posture change, not a bug fix.
- **Decided 2026-07-07 (A-1) — implemented (Branch 9, this tree):** `GET /rescan/tmdb` (`app.mjs`) triggers the single most privileged mutation in the surface — a full-library forceRefresh (`runDownloadTmdbImages({ fullScan: true })`), which wipes managed images and re-pulls everything — and historically had **no authentication**. Unlike V-5, that was *not* an accepted boundary: the route now requires `authenticateWebhookOrUser`, the same level as its sibling scan route `POST /media/scan`.

## Appendix A — HTTP endpoint inventory

The HTTP surface is registered in two places:

1. **Directly on the Express app** in `node/app.mjs` (streaming, frames, chapters, clips, media listings, process tracking, logs, and the root health endpoint), plus the sprite/VTT router from `node/sprite-route.mjs` (`createSpriteRoutes()`) mounted with no path prefix.
2. **The modular `/api` router** built by `node/routes/index.mjs` `setupRoutes()`, which wraps every route in OpenTelemetry middleware and mounts: `node/routes/blurhash.mjs`, `node/routes/metadataHashes.mjs`, and `node/routes/systemStatus.mjs` at `/api`; `node/routes/tmdb.mjs` at `/api/tmdb`; `node/routes/admin.mjs` at `/api/admin`; `node/routes/captions.mjs` at `/api` (it declares both `/captions/*` and `/admin/captions/*` paths itself); and `node/integrations/discord/routes.mjs` at `/api`.

A JSON body parser (`express.json({ limit: '30mb' })`) is applied globally in `node/app.mjs` through a conditional wrapper that **skips `/api/discord/events`** — that route needs the raw, unparsed body for Discord webhook signature verification and applies its own `express.raw()` parser (D-1 fix, shipped). Any future body-consuming global middleware must preserve this carve-out.

**Auth levels** (see `node/middleware/auth.mjs`, `node/middleware/webhookAuth.mjs`; posture decisions in §4.9):

| Level | Middleware | Meaning |
|---|---|---|
| none | — | No authentication of any kind (streaming/generation surface and the public hash surface). |
| user | `authenticateUser` | Valid frontend session (Bearer token or `nextjs-stream.session_token` cookie) validated against the frontend session store, with multi-tier caching; user must be approved or admin. |
| user + rate | `authenticateUser` + `createRateLimiter(800, 60000)` | As above, plus 800 requests/min per user. |
| webhook-or-admin | `authenticateWebhookOrUser` | Valid `x-webhook-id` header matched against `WEBHOOK_ID_*` env shared secrets (no DB hit), **or** a session belonging to an admin user. Non-admin users are rejected. Machine-to-machine sync surface. |
| admin | `authenticateUser` + `requireAdmin` | Authenticated session with the admin flag. |
| signature | route-internal | Discord Ed25519 request-signature verification against `DISCORD_PUBLIC_KEY` (not user auth). |

### A.1 Core app routes (`node/app.mjs`, `node/sprite-route.mjs`)

| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| GET | `/` | none | Server info / welcome payload with endpoint catalog. | |
| GET | `/frame/movie/:movieName/:timestamp{.:ext}` | none | Extract (and cache) a single AVIF frame from a movie at a timestamp. | |
| GET | `/frame/tv/:showName/:season/:episode/:timestamp{.:ext}` | none | Same, for a TV episode. | |
| GET | `/spritesheet/movie/:movieName` | none | Serve (generating on demand) the scrub-preview spritesheet for a movie. | |
| GET | `/spritesheet/tv/:showName/:season/:episode` | none | Same, for a TV episode. | |
| GET | `/vtt/movie/:movieName` | none | Serve the WebVTT index for the movie spritesheet. | |
| GET | `/vtt/tv/:showName/:season/:episode` | none | Same, for a TV episode. | |
| GET | `/chapters/movie/:movieName` | none | Serve (generating if absent) the chapter VTT for a movie. | |
| GET | `/chapters/tv/:showName` | none | Bulk-generate chapter VTTs for **every** episode of a show; returns a status string, not a file. | |
| GET | `/chapters/tv/:showName/:season/:episode` | none | Serve (generating if absent) the chapter VTT for one episode. | |
| GET | `/video/movie/:movieName` | none | Stream a movie (range requests, optional transcode via query params). | |
| GET | `/video/tv/:showName/:season/:episode` | none | Stream a TV episode. | |
| GET | `/videoClip/movie/:movieName` | none | Generate and serve a bounded video clip of a movie. | |
| GET | `/videoClip/tv/:showName/:season/:episode` | none | Same, for a TV episode. | |
| GET | `/rescan/tmdb` | webhook-or-admin | Full-library TMDB force-refresh: runs `runDownloadTmdbImages({ fullScan: true })`, which wipes and re-downloads managed images library-wide. | The single most privileged mutation in the surface; auth added by A-1 (Branch 9). **Not** in the decided S-2 task-manager gating scope (that covers only the write-heavy `/api/admin/metadata/*` routes); if S-2 gating is ever extended here, it must wrap — not replace or revert — the A-1 auth middleware. |
| GET | `/media/movies` | webhook-or-admin | List all movies from SQLite (scanning first only if the table is empty); injects auto-caption stubs at read time. | |
| GET | `/media/tv` | webhook-or-admin | Same, for TV shows. | |
| POST | `/media/scan` | webhook-or-admin | Trigger an on-demand **movies-only** library scan (`generateListMovies`, which delegates to the scanner component's `scanMovies`). | No TV equivalent exists. Decided 2026-07-07 (S-3) — not yet implemented: a symmetric TV path is to be added; frontend adoption of both variants is TBD (see §4.7). |
| GET | `/processes` | webhook-or-admin | List process-tracking queue entries; filterable by `processType` / `status` query params. | |
| GET | `/processes/:fileKey` | webhook-or-admin | Fetch one process-tracking entry. | |
| GET | `/api/logs` | none | Return server logs as JSON/plaintext, or stream via SSE with `?stream=true`. | Sets its own `Access-Control-Allow-Origin` from `FRONT_END_1`. |
| GET | `/api/logs/categories` | none | List available log categories. | |

### A.2 `/api` core routes (`node/routes/blurhash.mjs`, `node/routes/metadataHashes.mjs`, `node/routes/systemStatus.mjs`)

| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| GET | `/api/blurhash-changes` | none | Blurhash hash rows modified since a `?since=` ISO timestamp, with resolved relative paths. | |
| GET | `/api/blurhash/movie/:movieName` | none | All blurhash hashes for one movie. | |
| GET | `/api/blurhash/tv/:showName` | none | All blurhash hashes for one show (show/season/episode levels). | |
| POST | `/api/blurhash/bulk` | none | Batch blurhash lookup for up to 50 `{type, name}` items. | |
| GET | `/api/metadata-hashes/:mediaType` | none | All metadata hashes for `movies` or `tv` (the frontend's bulk sync poll). | |
| GET | `/api/metadata-hashes/:mediaType/:title` | none | Hash for a single title. | For movies, lazily generates and **writes** a hash row when none exists (read-triggered write behind an unauthenticated GET; guarded by only generating when no row exists — accepted pattern, A-5). |
| GET | `/api/metadata-hashes/:mediaType/:title/:seasonNumber` | none | Season-level hashes (TV only). | |
| GET | `/api/system-status` | webhook-or-admin | CPU/memory/disk status snapshot with severity levels (cached ~60 s). | |
| POST | `/api/trigger-system-status` | webhook-or-admin | Force an immediate status re-evaluation/notification pass. | |
| GET | `/api/tasks` | webhook-or-admin | Task-manager status report (queues, running tasks, concurrency limits). | |
| GET | `/api/health` | none | Lightweight health check. | |

### A.3 `/api/tmdb` routes (`node/routes/tmdb.mjs`)

All user-facing routes here proxy the shared TMDB client in `node/utils/tmdb.mjs` (with its SQLite response cache) and take query parameters, not path parameters.

| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| GET | `/api/tmdb/search/:type` | user + rate | Name search for `movie`/`tv` (`?query=`, `?page=`, `?blurhash=`). | Registered before `/search/collection`, so it also captures that path (see below). |
| GET | `/api/tmdb/comprehensive/:type` | user + rate | Aggregated details+cast+images+videos+rating fetch by `?name=` or `?tmdb_id=`. | |
| GET | `/api/tmdb/details/:type` | user + rate | Details by `?tmdb_id=`. | |
| GET | `/api/tmdb/cast/:type` | user + rate | Cast list by `?tmdb_id=`. | |
| GET | `/api/tmdb/structured-cast/:type` | user + rate | Cast split into main/recurring (and optionally guest) groups. | |
| GET | `/api/tmdb/videos/:type` | user + rate | Trailers/videos by `?tmdb_id=`. | |
| GET | `/api/tmdb/images/:type` | user + rate | Posters/backdrops/logos by `?tmdb_id=`. | |
| GET | `/api/tmdb/rating/:type` | user + rate | Content rating by `?tmdb_id=`. | |
| GET | `/api/tmdb/episode` | user + rate | Episode details (`?tmdb_id=&season=&episode=`). | |
| GET | `/api/tmdb/episode/images` | user + rate | Episode stills (`?tmdb_id=&season=&episode=`). | |
| GET | `/api/tmdb/search/collection` | user + rate | Collection name search. | As registered, unreachable: `/search/:type` is declared earlier in the same router and matches first with `type = 'collection'`. |
| GET | `/api/tmdb/collection` | user + rate | Collection details by `?tmdb_id=`; `?enhanced=true` fans out per-movie detail fetches. | |
| GET | `/api/tmdb/collection/images` | user + rate | Collection images by `?tmdb_id=`. | |
| GET | `/api/tmdb/config` | admin | Global TMDB integration status (API-key presence, cache stats, limits). | Unrelated to the per-media `tmdb.config` resource at `/api/admin/metadata/config`; the two share the word "config" only. Decided 2026-07-07 (A-4a) — not yet implemented: **one of the two resources is to be renamed** to end the collision (which one: chosen at implementation time; a breaking change requiring frontend coordination). Branch 9's cross-reference comments between the two handlers (A-4b) are the interim remediation until the rename ships. Response body hardcodes `requests_per_minute: 100`, but the actual limiter on these routes is 800/min. |
| GET | `/api/tmdb/cache/stats` | admin | TMDB response-cache statistics. | |
| DELETE | `/api/tmdb/cache` | admin | Clear the TMDB response cache (optionally by `?pattern=`). | |
| DELETE | `/api/tmdb/cache/expired` | admin | Clear only expired cache rows. | |
| POST | `/api/tmdb/cache/refresh` | admin | Refresh a cache entry for `{endpoint, params}`: drops the row, then eagerly refetches via `makeTmdbRequest(forceRefresh)` and re-caches. | A-3, implemented in Branch 9. `refreshed` = a row existed; `fetched` = refetch succeeded; 502 if the refetch fails after the delete. Cannot address blurhash-suffixed cache keys (documented limitation). |
| GET | `/api/tmdb/health` | none | TMDB route-module health check. | |

### A.4 `/api/admin` routes (`node/routes/admin.mjs`)

Every route in this module is `admin`. The title/name path segments in this module are joined onto `BASE_PATH` through the `safeJoin()` path-traversal guard (SEC-1 fix, shipped); traversal attempts return 400.

| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| POST | `/api/admin/subtitles/save` | admin | Write edited subtitle content (WebVTT auto-converted to SRT) next to the media file. | |
| POST | `/api/admin/metadata/show` | admin | Run `MetadataGenerator.generateForShow()` for one show (optional `forceRefresh`, `generateBlurhash`). | Decided 2026-07-07 (S-2): route write-heavy admin metadata routes through the task manager so they cannot race scheduled scans / force-refresh image wipes — not yet implemented. |
| POST | `/api/admin/metadata/movie` | admin | Run `MetadataGenerator.generateForMovie()` for one movie. | Same S-2 note. |
| POST | `/api/admin/metadata/bulk` | admin | Run `MetadataGenerator.processDirectory()` over all `tv` or `movies` (optional `maxConcurrent`). | Same S-2 note. |
| GET | `/api/admin/metadata/config` | admin | Read one title's `tmdb.config` (validated, with defaults applied). | Per-media resource; distinct from `/api/tmdb/config` (see A-4a note above). |
| PUT | `/api/admin/metadata/config` | admin | Replace one title's `tmdb.config` with the supplied object. | **Full-replace, no merge**: omitted keys are dropped. This is deliberate — it is the mechanism for reverting an override (A-2; see the warning block in §4.6) — and must not be "fixed" into merge-on-omit semantics. |
| GET | `/api/admin/metadata/test` | admin | Connectivity self-test: TMDB API key, live search, generator init. | |
| GET | `/api/admin/session-cache/stats` | admin | Session-cache hit/size statistics. | |
| POST | `/api/admin/session-cache/clear` | admin | Flush the session cache. | |

### A.5 Captions routes (`node/routes/captions.mjs`)

| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| GET | `/api/captions/track/movie/:title/:lang` | none to read; user to trigger | 302-redirect to an existing caption file, or report an in-flight job; if neither exists, requires an authenticated user (rate-limited) to enqueue generation. | Split-auth by design: reads are public, generation is not. |
| GET | `/api/captions/track/tv/:show/:lang/:season/:episode` | none to read; user to trigger | Same, for a TV episode. | |
| GET | `/api/captions/jobs/:jobId` | none | Poll a caption job's status. | Job IDs are `cap-<ms timestamp>-<8 random hex chars>` (~32 bits of entropy) — hard to enumerate over HTTP but not full UUIDs; the unauthenticated poll relies on that plus the jobs map being small and short-lived. |
| GET | `/api/captions/health` | webhook-or-admin | Caption subsystem health/queue snapshot. | |
| POST | `/api/admin/captions/generate` | admin (+ rate limit) | Manually enqueue a caption-generation job (optional `force`). | |

### A.6 Discord integration (`node/integrations/discord/routes.mjs`)

| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| POST | `/api/discord/events` | signature | Discord webhook events endpoint (PING, `APPLICATION_AUTHORIZED` → intro DM, `APPLICATION_DEAUTHORIZED`), with in-memory event-ID idempotency. | **Raw-body requirement:** verification calls `verifyKey()` over the exact request bytes. The route uses `express.raw({ type: 'application/json' })`, and the global JSON parser in `node/app.mjs` explicitly skips this path (D-1 fix, shipped). |

## Appendix B — `tmdb.config` field reference

A `tmdb.config` file is an optional per-title JSON file in the title's media directory (`node/utils/tmdbConfig.mjs` `getTmdbConfigFilePath()`). `loadTmdbConfig()` returns defaults when the file is absent, and `validateTmdbConfig()` spreads the parsed file over the defaults — so **unknown keys are preserved verbatim**, and only the fields below get active validation. `saveTmdbConfig()` runs the same validation before writing. A deleted `tmdb.config` silently reverts the title to defaults (unfrozen, no pinned id, no overrides — the terminal hazard detailed in the §3 `tmdb.config` entry).

| Field | Type | Default | Effect |
|---|---|---|---|
| `update_metadata` | boolean | `true` | **The freeze switch.** `isUpdateAllowed()` treats anything other than exactly `false` as allowed. When `false`, `MetadataGenerator.generateForShow()`/`generateForMovie()` return early (`reason: 'updates-disabled'`, or `'updates-disabled-overrides-applied'` when a pending override still had to be applied) and no TMDB fetch or `metadata.json` write occurs. Non-boolean values are coerced to `true` with a warning. The freeze is reversible, not a tombstone — flipping it back resumes normal refresh. |
| `tmdb_id` | positive integer | *(absent)* | **The trust anchor**: pins which TMDB entity this directory is. Set by an operator, or written once by the pipeline after a name-search match (`updateTmdbConfigWithId()` only ever *adds* an id, never overwrites — a one-way ratchet). Changing it marks the title stale-by-config and forces a force-refresh repull (managed images wiped, then re-downloaded). Invalid values (non-integer, ≤ 0) are deleted by the validator. In the pristine-base design (the `pristine_metadata` column and its population shipped with Branch 1; trust semantics are Branch 2, not yet implemented), the pristine-base snapshot is trusted as a merge base *iff* an id is currently set. |
| `metadata` | object | *(absent)* | **The metadata override block.** `applyMetadataOverrides()` spreads it over the TMDB response — a **shallow one-level merge**: overriding any nested field replaces the entire top-level key. Decided 2026-07-07 (G-4): shallow merge is the accepted permanent contract; document, don't deep-merge. Key *presence* (even as `{}`) is an explicit "override-managed" opt-in via `hasMetadataOverrideKey()` (G-2, shipped) — the scanners' frozen-metadata gate consumes it; the merge itself still produces identical output for `{}` and absent until the pristine-base merge/revert semantics land. Fields inside it named `<kind>_path` (e.g. `poster_path`) also act as the middle tier of the image-URL precedence below. |
| `override_poster`, `override_backdrop`, `override_logo` | string | *(absent)* | **Per-image override.** Highest tier of the effective image-URL precedence: `override_<kind>` > `metadata.<kind>_path` > TMDB response value. Consumed in two independently-implemented places: `node/utils/imageDownloader.mjs` `downloadMediaImages()` (which always prefixes the TMDB CDN base onto the override value, so a full external URL gets mangled) and `node/lib/metadataGenerator.mjs` `_reconcileImageOwnership()` (which does not prefix). Decided 2026-07-07 (Branch 6, I-5/I-7a): extract one shared `resolveEffectiveImageUrl()` and fix the external-URL handling — not yet implemented. Override-sourced art survives a force-refresh wipe because it is re-fetched immediately after. The `getOverride()` accessor in `node/utils/tmdbConfig.mjs` exists for this field family but currently has no callers. |
| `backdrop_focal` | `'left'` \| `'right'` \| `'center'` \| `null` | `null` | **Manual backdrop focal point.** Mirrored by the scanners into the `backdrop_focal` DB column and exposed to the frontend as `backdropFocal`. Validator gap: the auto-detector (`node/utils/backdropFocalDetector.mjs` `detectBackdropFocal()`) also produces `'center-left'`/`'center-right'`, which this validator rejects and resets to `null` — decided 2026-07-07 (I-6a, Branch 6): add both values to the valid list — not yet implemented. |

**Not a `tmdb.config` field, but adjacent:** `backdrop_focal_suggested` is the *auto-detected* focal point, computed by the scanner from the backdrop image and stored only in SQLite (`backdrop_focal_suggested` column), exposed as `backdropFocalSuggested`. Both values are exposed raw with no backend-side resolution, and — decided 2026-07-07 (I-6b) — **that stays the contract**: precedence is deliberately the frontend's to resolve (manual-wins is the recommended convention), which keeps an accept/reject-suggestion UI possible. No backend effective-value computation is planned.

**Full-replace contract (A-2):** `PUT /api/admin/metadata/config` replaces the whole file with the validated request payload; omitting a key deletes it, which is exactly how an override is *reverted*. This is load-bearing and must not be converted to merge-on-omit semantics — see the A-2 warning block in §4.6.

## Appendix C — Glossary

- **Freeze** — `update_metadata: false` in a title's `tmdb.config`. A reversible halt to all TMDB fetches and `metadata.json` writes for that title, enforced primarily one layer below the scanner in `MetadataGenerator`; the scanners' retry gates additionally consult the flag in the two narrowed places §4.2 lists (Branch 3). Overrides still apply while frozen (`reason: 'updates-disabled-overrides-applied'`). Not a "no TMDB match" marker — the generator's returned `reason` distinguishes frozen (`'updates-disabled'` / `'updates-disabled-overrides-applied'`, tested via `isFrozenReason()` in `metadataGenerator.mjs`) from `'no-match'` and `'transient-error'`, and the scanners' cooldown bookkeeping (`resolveCooldownAction()` in `cooldown-policy.mjs`) branches on it: a frozen no-overrides title *clears* its cooldown row rather than marking one (paused is not failing).

- **Two-gate retry model** — the scanner's TMDB-retry decision in `node/components/media-scanner/domain/movie-scanner.mjs` / `tv-scanner.mjs`: the **metadata gate** (missing `metadata.json` → retry only after the 24 h cooldown in `missing_data_media`, because a lookup failure isn't worth retrying every 3-minute tick) and the **images gate** (missing image files → retry with no cooldown, because image failures are typically transient). A directory-hash change forces a retry regardless of either gate. The gates run at their stated cadence only in the TV scanner, which computes them every tick before its unchanged-hash fast-skip; the movie scanner early-returns on an unchanged directory hash *before* either gate is evaluated, so for movies both gates fire only when the directory contents change. Both gates are freeze-aware (Branch 3): the images gate opens only while `isUpdateAllowed()`, and the metadata gate re-offers a frozen title only when `tmdb.config` carries metadata overrides — the narrowed contract in §4.2. The cooldown row is stamped after a confirmed failure, not before the attempt (`resolveCooldownAction()` in `cooldown-policy.mjs`).

- **Pristine base** — a SQLite column (`pristine_metadata`, on both `movies` and `tv_shows`) holding the raw, pre-override TMDB response for a title. *Schema + population shipped (Branch 1, this tree)*: populated only by a genuine fetch (never re-synced from `metadata.json`), preserved through saves that fetched nothing. *Trust semantics planned (Branch 2, not yet implemented)*: trusted as the merge base for override application iff `tmdb_id` is currently set, and forced empty when the id is cleared (the wrong-auto-match correction path). Lives in SQLite rather than a file because it is derived state — a cache of TMDB's response — not ground truth.

- **Content-aware vs. content-blind hash** — a metadata hash is *content-aware* when the `metadata.json` content is folded into its input, so TMDB-content edits move the hash and propagate to the frontend; *content-blind* when computed from a row carrying no metadata content. **Since Branch 1 (F-1, this tree) both movie-hash writers are content-aware**: the scanner persists a canonical fingerprint to `movies.metadata` and both the inline rehash (`getMovieByName()`) and the scheduled `updateAllMovieHashes()` sweep (`getMovies()`) hash the stored column verbatim — the sweep can no longer clobber a fresh content-aware hash with a content-blind one. TV show hashes were already content-aware in both paths via `tv_shows.metadata`.

- **Reconcile modes** — `SCANNER_RECONCILE_MODE` env var gating `MetadataGenerator._reconcileImageOwnership()` deletions: `off` (never delete), `dry-run` (log "would delete", touch nothing), `enforce` (actually unlink the orphan/stale file plus its `.blurhash` sidecar so the downloader re-fetches). Current default is `dry-run`; unknown values fall back to `dry-run`. Decided 2026-07-07 (I-1): flip the default to `enforce` with a startup log line announcing the active mode — not yet implemented. The force-refresh wipe (`_forceWipeImage()`) deliberately bypasses this gate entirely: an id change or `/rescan/tmdb` is explicit operator intent.

- **Managed vs. manual image files** — a *managed* file is one the pipeline wrote itself: its path is DB-tracked and matches what the current effective URL would produce (`previousPath === expectedPath` in `_reconcileImageOwnership()`). Only managed files are ever deleted by reconcile. A *manual* file is user-placed art whose name/extension doesn't match the current expected target (or was never DB-tracked) — reconcile preserves it forever. The one exception is force-refresh, which wipes **every** file in every conventional image slot regardless of tracking (I-2 — accepted behavior: an id change means the old art is wrong; overrides survive because they are re-fetched after the wipe).

- **Ground truth vs. derived state** — the filesystem (media directories, `metadata.json`, `tmdb.config`, image files) is ground truth; SQLite is derived, rebuildable state fed one-way from disk. Deleting the media DB rebuilds the derived state; `GET /rescan/tmdb` rebuilds ground truth itself. Exceptions that are *not* derivable and must be treated as real state: the cooldown/bookkeeping tables (`missing_data_media`, `episode_metadata_missing`) and Discord bot history — plus the non-media cache directories (frames, spritesheets, clips, transcodes), which are on the filesystem but are derived, disposable state, not ground truth.

- **Track A / Track B** — the two-lane remediation plan for the 2026-07 backend gaps triage. **Track A** = immediate hotfixes shipped directly off `main`, all three of which are present in the current tree: SEC-1 (`safeJoin()` path-traversal guard in `node/routes/admin.mjs`), S-1 (`TaskType.BLURHASH` enum fix for the scheduled blurhash job in `node/app.mjs`), and D-1 (the conditional `express.json` wrapper that skips `/api/discord/events`). **Track B** = thirteen theme-grouped branches of decided changes (schema parity, scanner cooldown fixes, reconcile/override consolidation, TMDB client hardening, route hardening, etc.) — Branches 1–5, 8, and 12 are merged to `main`, Branch 9 (admin/rescan route hardening: A-1, A-3, A-4b) is implemented in this tree, Branch 13 (the Discord webhook signature fix, D-1) was promoted into Track A and shipped (retained in the numbering for traceability), and Branches 6, 7, 10, and 11 remain unshipped. Every unshipped Track B item referenced in this document is labeled "Decided 2026-07-07 — not yet implemented" and describes *future* behavior, not the current tree.
