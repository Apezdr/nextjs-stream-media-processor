# Backend Open Questions & Decision Log — nextjs-stream-media-processor

Companion to [`docs/BACKEND_ARCHITECTURE.md`](./BACKEND_ARCHITECTURE.md). That document describes how the backend works today; this one tracks everything that is known to be wrong, undecided, or deliberately accepted — a living backlog of design gaps, owner decisions, and their implementation status.

Items move through a fixed lifecycle:

> **Open** → **Decided** (a direction is chosen, nothing shipped) → **Implemented** (code merged) → **Documented** (current behavior absorbed into `BACKEND_ARCHITECTURE.md`, entry removed here)

Shrinking this file is the goal. An item that reaches "Documented" is deleted from this file, not archived in it.

**Where the 2026-07-07 triage round stands (as of 2026-07-12):** the round's entire implementation plan has shipped. Track A (SEC-1, S-1, D-1) landed in commit `4aeb30c`; all thirteen Track B branches are merged to `main` (one named merge commit per branch — `git log --first-parent` is the traceability record), and the decided S-4 exclusivity-pairing removal shipped as its planned post-Branch-11 follow-up. All of that behavior is absorbed into `BACKEND_ARCHITECTURE.md`, and per the lifecycle rule the corresponding entries have been removed from this file. What remains here is exactly: the **decided-but-unimplemented** items, one-line **records of docs-only resolutions** (so nobody re-opens them), the **accepted-as-documented** behaviors, and **future feature directions**.

**Critical reading rule:** everything in the "Decided — not yet implemented" section is *decided but not implemented* — it does not describe current behavior. Current behavior is what `BACKEND_ARCHITECTURE.md` and the "Accepted as documented" section describe.

## Contents

- [Decided — not yet implemented](#decided--not-yet-implemented)
  - [Image reconcile / override system](#image-reconcile--override-system)
  - [TMDB client](#tmdb-client)
  - [Pristine-base trust/merge semantics](#pristine-base-trustmerge-semantics)
  - [SQLite / hash consistency](#sqlite--hash-consistency)
  - [Admin / config / rescan routes](#admin--config--rescan-routes)
  - [Scheduling / concurrency](#scheduling--concurrency)
  - [Captions / chapters / blurhash](#captions--chapters--blurhash)
  - [Mongo tier / Discord](#mongo-tier--discord)
- [Resolved decision records (docs-only)](#resolved-decision-records-docs-only)
- [Accepted as documented](#accepted-as-documented)
- [Future feature directions](#future-feature-directions)
  - [Radarr/Sonarr integration (extends T-3)](#radarrsonarr-integration-extends-t-3)
  - [On-demand scan routes (extends S-3)](#on-demand-scan-routes-extends-s-3)

---

## Decided — not yet implemented

Every entry records an owner decision from the 2026-07-07 triage round whose implementation has not shipped. None of these describe current behavior.

### Image reconcile / override system

**I-1 — Image reconcile ships inert.**
The orphan/stale-image reconcile mode defaults to `dry-run` (`node/lib/metadataGenerator.mjs` reads `SCANNER_RECONCILE_MODE` with a `'dry-run'` fallback) and nothing in the repository or deployment config overrides it, so the fix system never actually deletes anything by default.
**Decision:** flip the default to `enforce`, and emit a startup log line stating the active reconcile mode. **Rationale:** a feature that is a silent no-op until someone remembers an env var is worse than a visible default, and the deletion candidate set is naturally small (config mtimes are stable across normal scans; dry-run candidates are recomputed per tick, not accumulated), with re-downloads bounded by the download and TMDB concurrency limits. **⚠ Scrutiny finding (2026-07-12) — the "manual files are never touched" premise does not hold in code:** the `*_file_path` columns that reconcile treats as ownership are populated by `resolveImage()` from *whatever file sits at the canonical path*, manual or downloaded — there is no true provenance signal. Under enforce, a manual file with a different extension than the effective URL is deleted by the orphan branch (no mtime guard), and a manual file at the exact canonical name+ext is deleted by the stale branch after any later `tmdb.config` edit. **Revised sequencing:** I-3's population + `stale-source-url` reconcile logic is merged and deployed to production (2026-07-13, dry-run monitoring in progress) — but the I-1 branch itself must still (a) gate the pre-existing orphan/stale deletion branches on a recorded source URL (only delete slots we can prove we downloaded — the source-url branch already requires it; the two older branches do not yet), noting the 2026-07-13 skim finding that *adopted* provenance is weaker than *download* provenance (decide: mark adoption distinguishably, or accept the stale-by-config-equivalent manual-file exposure), and (b) observe the production dry-run "would delete" volume for false positives before flipping the default. **Lands:** new branch TBD, after the dry-run observation window. *Status: Decided — not yet implemented.*

**I-4 — Season posters and episode thumbnails can silently clobber manual files.**
These slots have no override mechanism, and their day-based refresh cadence overwrites whatever file sits at the canonical path — including a manually placed one — with no DB provenance tracking and no `SCANNER_RECONCILE_MODE` gate. *(Cadence/clobber detail carried from the triage round; not re-verified line-by-line.)*
**Decision:** build the **full override model per slot** — per-season-poster and per-episode-thumbnail override keys, DB-tracked provenance for downloaded files, and reconcile coverage, mirroring the top-level image model. The refresh cadence survives, but with provenance tracking it only ever overwrites system-downloaded files, closing the manual-file clobber as a consequence rather than a special case. **Rationale:** the complete curation mechanism was chosen over the minimal ownership-guard stopgap — it fixes the clobber risk *and* gives season/episode art the same override surface top-level art has. **⚠ Scrutiny finding (2026-07-12) — design preconditions:** (1) there is no per-season/per-episode row structure to hang provenance on — `tv_shows.seasons` is a single JSON blob, so this needs a real schema decision (embed provenance in the blob vs. new keyed tables), making it the largest remaining item; (2) bootstrap rule required: existing on-disk season/episode art has no provenance record, and a naive "only refresh what we own" gate would freeze all existing art out of the refresh cadence — unknown provenance must mean "adopt and populate", not "stop refreshing" (same NULL-bootstrap shape as I-3, one level deeper); (3) the `_forceWipeImage()` season-poster and episode-thumbnail calls on the forceRefresh path must become provenance-aware too, or the manual-file clobber survives on exactly that path — and the design should explicitly decide whether per-slot manual art survives forceRefresh the way top-level `override_*` art does. **Lands:** new branch TBD. *Status: Decided — not yet implemented.*

### TMDB client

**T-3 — Name search blindly takes the first result.**
`node/utils/tmdb.mjs` `fetchComprehensiveMediaDetails()`'s search fallbacks take `results[0]` with zero disambiguation — reachable for every newly scanned title with no pinned `tmdb_id`. The wrong-auto-match failure mode this produces is exactly what the pristine-base redesign exists to make recoverable.
**Decision:** add a year-match heuristic upstream — extract a `(YYYY)` year from the directory name when present, score results by release/first-air-date year, and fall back to the popularity-sorted first result only when no year is present or nothing matches. This is the near-term fix only; the long-term direction is pulling authoritative ids from Radarr/Sonarr; see **Future feature directions**. *Status: Implemented (this branch).* `pickSearchResultByYear()` in `node/utils/tmdb.mjs` selects exact-year first, then ±1 year (regional release dates and December/January premieres straddle the folder year), then the pre-T-3 popularity-first fallback — always in TMDB's popularity order, always strictly inside the `if (!id)` block (the year comes from the original name even on the year-stripped retry), and never manufacturing a match for an empty result set, so the no-match/cooldown contract and the pin-on-match ratchet invariant are untouched. Unit-tested including the classic remake-outranks-original case. Entry removed once absorbed post-merge (behavior is in `BACKEND_ARCHITECTURE.md` §3 pristine-base entry, G-3 note).

### Pristine-base trust/merge semantics

**Pristine base — the merge/revert semantics have not landed.**
Branch 1 shipped the `pristine_metadata` column and its faithful population; Branch 2 shipped the override helpers (G-2 presence-based opt-in, G-3 trusted-id adoption). What has **not** shipped is the design's payoff: trusting the stored pristine payload as the merge base for override application (**iff** a `tmdb_id` is currently set), forcing it empty when the id is cleared (the wrong-auto-match correction path), and the one-time by-id-only bootstrap for existing libraries. Until it lands, override application keeps its current behavior (shallow merge onto the current invocation's fetch, or onto `metadata.json` content in the frozen path). Full planned lifecycle: `BACKEND_ARCHITECTURE.md` §3, pristine-base entry.
**Constraint (A-2):** `PUT /api/admin/metadata/config`'s full-replace semantics are the override-revert mechanism this design relies on — any implementation must treat that as a hard invariant (§4.6 warning block).
**⚠ Scrutiny findings (2026-07-12) — two design amendments needed:**
1. *The frozen path must keep merging onto current `metadata.json`, never onto pristine.* `_applyOverridesWhileFrozen()` runs no fetch, so pristine is not refreshed there; switching its merge base to the stored pristine would apply overrides onto a snapshot older than the title's own `metadata.json` — a real behavior change for frozen titles that the decided design doesn't call out.
2. *Implement "forced-empty on id clear" as a current-state check, not a diff.* Nothing in the code compares old-vs-new config ids (the config is full-replace; the scanner sees only mtime), so "detect the id being cleared" has no primitive. The equivalent, implementable rule: **trust pristine as merge base iff `tmdb_id` is currently set** — no old/new comparison needed. The id-*swap* case is already safe by consequence: `staleByConfig` → `forceRefresh` → fresh fetch recaptures pristine from the new id before any merge could consume the stale one.
Two reassurances also verified: `pristineMetadata` is serialized from the exact same `tmdbData` that (after overrides) becomes `metadata.json`, so merge-onto-pristine drops no fields when the pristine is same-id; and the COALESCE-preserve on both save paths is correct (image-only/backfill/frozen passes never null it). The one-time bootstrap for existing libraries must be by-id-only, gated on `tmdb_id` being set — never a name search. **Lands:** new branch TBD. *Status: Decided — not yet implemented.*

### SQLite / hash consistency

**F-4 — Hash `data_version` is written but never read back.**
`node/sqlite/metadataHashes.mjs` writes `HASH_DATA_VERSION` into every `metadata_hashes` row's `data_version` column but nothing ever compares it, so a hashing-logic change has no automated invalidation path. The sibling `node/sqlite/blurhashHashes.mjs` wires the equivalent versioning into its rows for real. This exact gap has already cost a manual full re-sync once (the 2026-05-27 array-replacer fix).
**Decision:** wire up a real invalidation sweep — find rows where `data_version < HASH_DATA_VERSION` and force-regenerate, mirroring the blurhash table's pattern. **Rationale:** the failure mode has already bitten this repository once, and the working pattern to copy sits next door. **Scrutiny (2026-07-12) — safe with named preconditions:** (1) the sweep must bypass the scheduled sweep's 16-minute `sinceTimestamp` media-mtime filter — a version-stale row whose media hasn't changed is invisible to it; (2) drive regeneration from the live media list (`getMovies()`/`getTVShows()`), not from the stale-row title set — orphan rows for removed titles are never rewritten and a naive stale-row loop busy-spins on them forever (add an orphan prune); (3) gate per-row, not on a global "any stale row exists" boolean — `generateMovieHashes()`/`generateTVShowHashes()` swallow per-item errors without writing, so a permanently failing item must not re-trigger a full-library pass every tick. Convergence is otherwise guaranteed (`storeHash()` always stamps the current version, and its delete-then-insert collapses rather than resurrects the historical NULL-key duplicates). Wiring the sweep without bumping the version is a true no-op; a real bump regenerates rows to *identical* hashes unless hashing logic changed — the designed one-shot full re-sync, same class as the F-1/V-4 convergence storms. One caveat to verify frontend-side: `hash_generated`/the aggregate media-type hash *do* move on regeneration even when per-item hashes are identical — confirm the frontend skip-gate compares per-item `hash`, not `generated`. **Lands:** new branch TBD. *Status: Decided — not yet implemented.*

### Admin / config / rescan routes

**A-4a — Two unrelated resources share the name "config."**
`PUT /api/admin/metadata/config` (per-title tmdb.config) and `GET /api/tmdb/config` (global TMDB settings, `node/routes/tmdb.mjs`) are unrelated resources with the same trailing name. Pure naming clarity — no bug, and a rename breaks whatever external frontend calls either path.
**Decision:** rename one of the two resources, accepting the breaking-change coordination with the frontend. *Status: Implemented (this branch).* Per the scrutiny recommendation, the read-only global endpoint took the rename: `GET /api/tmdb/config` → **`GET /api/tmdb/status`** (it *is* a status report, and it sits beside `/api/tmdb/health`); the per-title `metadata/config` editor keeps its path because breaking its PUT would silently block config authoring. No alias — external callers of the old path get a 404, and since no in-repo caller or test referenced either path, the only remaining coordination is a **frontend release note** (⚠ flag `GET /api/tmdb/config` → `/api/tmdb/status` when deploying alongside the `nextjs-stream` frontend). The response's `requests_per_minute` field was also corrected to the real 800/min limiter (was hardcoded 100). Entry removed once absorbed post-merge (route table in `BACKEND_ARCHITECTURE.md` Appendix A.3 is updated).

### Scheduling / concurrency

**S-2 — On-demand routes bypass the task manager.**
`GET /media/tv`, `GET /media/movies`, `POST /media/scan`, `GET /rescan/tmdb`, and the admin metadata routes call scan/generate functions directly rather than through `enqueueTask()`, so they can run concurrently with the every-3-minute scheduled scan or each other. For the write-heavy admin routes this is a genuine correctness race, not just lock contention: a forceRefresh image wipe can interleave with a scan mid-read/write on the same title.
**Decision:** gate the write-heavy admin routes (`/api/admin/metadata/show`, `/movie`, `/bulk`) through `enqueueTask()` with the existing task types; leave the read-mostly listing endpoints as-is. **Rationale:** the listing endpoints' race window is essentially cold-start/operator-paced and low stakes; coupling their HTTP latency to the task queue buys little. **Sequencing:** if this gating is later extended to `/rescan/tmdb`, it must wrap the handler that A-1 (Branch 9, merged) authenticates — not replace or revert that middleware.
**⚠ Scrutiny findings (2026-07-12) — the decision is right but under-specified on HTTP blocking:**
- `enqueueTask()`'s promise resolves only on *completion* (queue-wait + run time), and the admin handlers today `await` generation inline and return the full result. A literal "await enqueueTask" implementation makes `/bulk` (a full-library walk) exceed reverse-proxy timeouts — work completes server-side, response is lost, caller retries, duplicate enqueue — and makes `/show`/`/movie` hang behind any running 3-minute scan.
- **Required shape:** the 202-async pattern already proven in `routes/captions.mjs` — enqueue fire-and-forget under `TaskType.MEDIA_SCAN` (the only type that gives mutual exclusion against scans, which is the point: closing the `_wipeManagedImagesForForceRefresh()` vs. scan race), return `202` with the existing `transactionId`, add a poll route. No HTTP route in the codebase currently blocks on an awaited `enqueueTask` — don't introduce the first one here.
- **Companion fix:** the every-3-minute scheduled scan enqueues unconditionally (the old `isScanning` guard is dead code and there is no skip-if-queued/coalescing, and task queues are unbounded FIFO). A long admin `/bulk` holding the `MEDIA_SCAN` slot would pile up redundant scheduled-scan tasks that then drain sequentially. Add a skip-if-already-queued/coalesce guard to the scheduler with (or before) this change.
- Admin tasks must be enqueued from the top level of the handler only — awaiting an exclusive-group task from *inside* a held `MEDIA_SCAN` slot self-deadlocks. *Status: Decided — not yet implemented.*

**S-3 — `POST /media/scan` only scans movies.**
The handler in `node/app.mjs` calls `generateListMovies()` only; no TV-only on-demand scan route exists. The asymmetry predates combined TV scanning and looks legacy, but code alone cannot confirm whether an external webhook caller depends on movie-only semantics.
**Decision:** add the symmetric TV on-demand scan path (a TV equivalent or a `mediaType` parameter, movies-only default preserved for existing callers), routed through the task manager per S-2's gating decision. Frontend adoption of both the movie and TV variants is explicitly TBD — the `nextjs-stream` frontend does not currently call these routes; they ship as available-but-unadopted surface. See **Future feature directions**. **Scrutiny (2026-07-12) — safe with preconditions:** the TV counterpart already exists and is scheduler-exercised (`generateListTV()` in `node/app.mjs`, wrapping `scanTVShows`), so this is wiring, not building. Preconditions: default `mediaType='movies'` to preserve the external-webhook contract; keep the plain-string response body backward-compatible (or make richer JSON strictly additive); map movies→`MOVIE_SCAN`, tv→`TV_SCAN`, both→`MEDIA_SCAN` and inherit S-2's 202-async shape so the request doesn't block behind a scheduled scan. **Lands:** new branch TBD. *Status: Decided — not yet implemented.*

### Captions / chapters / blurhash

**B-2b — Three unshared blurhash size-by-image-kind policies.**
`imageDownloader.mjs`, `utils.mjs`, and `tmdbBlurhash.mjs` each encoded their own size-per-image-kind rules; the two sidecar pipelines agreed, and the TMDB API-proxy pipeline diverged for posters.
**Decision:** unify the three sizing policies into one shared policy module, with the poster divergence made an explicit named choice rather than drift. *Status: Implemented (this branch), as the strict zero-behavior-change refactor the scrutiny required.* `node/utils/blurhashSizePolicy.mjs` is the single source: both sidecar writers share one table (`sidecarBlurhashSizeForImageType()` for the download-time writer, `sidecarBlurhashSizeForFilename()` for the lazy scanner path — backdrops/thumbnails `small`, posters `medium`, logos `large`, unknown → `large`), and every TMDB-proxy call site references a named `TMDB_PROXY_BLURHASH_SIZES` constant, with the details/collection-poster `large` documented in-module as the deliberate divergence (browse/search preview art vs. library storage). Freeze-tests pin every as-built value so a future size change is a visible policy decision — the module doc spells out its invalidation costs (sidecar version bump covers movies only, TV has no version-regen path; tmdb blurhash cache keys embed the size). Entry removed once absorbed post-merge (behavior is in `BACKEND_ARCHITECTURE.md` §2.5).

### Mongo tier / Discord

**M-4 — No documented backup plan for non-derivable Mongo state.**
The Users DB (real identities/sessions) and admin-customized `app_config.settings` are the only genuinely non-derivable Mongo state — and `app_config.settings` self-heals to hardcoded defaults when a document is missing, so a restore from a stale backup (or a wipe) silently and undetectably reverts deliberate admin customization. An external backup policy covering this state already exists (operator-confirmed 2026-07-07); the gap is purely that nothing in-repo points to it.
**Decision:** document the durability posture — name Users and `app_config` as the collections the existing external backup/snapshot policy covers, with a pointer in README/`.env.example` — and additionally log `app_config.settings` writes as a revert-detection audit trail. *Status: Implemented (this branch).* README gained a "MongoDB durability & backups" section and `.env.example`'s MongoDB block carries the matching note; both in-repo seed sites (`checkAutoSync()` in `node/database.mjs`, `getAutoCaptionsConfig()` in the caption config module) now emit a warn-level line with the grep marker `app_config.settings audit` — normal on first boot, a loss/revert signature on an established deployment. Scoping note preserved in the docs: deliberate setting *changes* are written by the frontend, so this backend only witnesses the loss/reseed half; a full change-audit would be a frontend-side counterpart. Entry removed once absorbed post-merge (behavior is in `BACKEND_ARCHITECTURE.md` §1.4). **⚠ Deploy note:** on the next production boot the autoCaptions/autoSync docs already exist, so the audit lines should stay silent — if one fires, that is the detector working, not a bug.

**D-2 — The Discord media-admin plan doc self-reports completion that never happened.**
`node/integrations/discord/MEDIA_ADMIN_COMMANDS_PLAN.md` marks its 17-item Phase 1-4 checklist complete, but roughly one item (the `/tasks` command and its admin-auth helper) actually shipped; the files the plan describes were never created in git history. *(Completion ratio carried from the triage round's git-history audit; not re-audited.)*
**Decision:** correct the checklist to reflect real completion and relabel the document as a proposal/backlog, not a finished-work record. *Status: Implemented (this branch).* The plan doc's title now says PROPOSAL/BACKLOG, a status banner records the D-2 correction and forbids citing it as shipped behavior, and the 17-item checklist is marked against git reality: 1 ✅ (the `/tasks` command), 1 🟡 (the `getAdminByDiscordId()` helper exists; the planned reusable middleware layer does not), 15 ❌. The design remains available for the Radarr/Sonarr-adjacent media-management direction. Entry removed once absorbed post-merge (`BACKEND_ARCHITECTURE.md` §0.4 table and §2.12 updated).

**D-3 — `/status` exposes host infrastructure metrics with no access control.**
`node/integrations/discord/commands/status.mjs` performs no admin check of any kind, while the sibling `tasks.mjs` gates on `getAdminByDiscordId()` — yet both expose live host CPU/memory/disk/process data, and the app supports user-installable Discord installs, so `/status` is potentially reachable by any Discord user who self-installs it.
**Decision:** gate `/status` (and its onboarding buttons) the same way `/tasks` is gated — admin-only via `getAdminByDiscordId()`. **Rationale:** host infrastructure metrics were never intended to be public, and the admin-check helper already exists one command over. **⚠ Scrutiny finding (2026-07-12) — the button surface is the hard part and forces a product decision:** five button IDs in `events/interactionCreate.mjs` (`check_status`, `status_simple`, `status_refresh_simple`, `status_detailed`, `status_refresh_detailed`) call `getSystemStatus()` directly, bypassing `status.mjs` entirely — gating only the slash command leaves an identical ungated data path. And the `check_status` button is built into the *onboarding introduction DM* template sent to `DISCORD_NOTIFY_USERS`, who are not necessarily admins: gating the buttons admin-only breaks that onboarding flow for exactly the users it targets. Before implementation, decide what a non-admin's onboarding "Check Status" button should do — drop it from the intro-DM template, or show a stripped non-infrastructure status — then gate all five button handlers plus the command consistently. **Lands:** new branch TBD (Discord lane). *Status: Decided — implementation blocked on the onboarding-button decision.*

---

## Resolved decision records (docs-only)

These 2026-07-07 decisions required no code — they resolved by documenting current behavior as intentional. One line each so nobody re-opens them; the full statement lives at the cited `BACKEND_ARCHITECTURE.md` location.

| ID | Decision (one line) | Documented at |
|----|----------------------|---------------|
| **G-4** | Override merge stays shallow, permanently; nested edits require supplying the whole top-level value. | §3 Override entry; Appendix B (`metadata` field) |
| **T-2** | The flat 60-day TMDB cache TTL stays uniform across endpoints. | §3 TMDB cache row (TTL paragraph) |
| **T-7** | No TMDB circuit breaker; layered retry + 24 h cooldown is the accepted posture. | §2.4 (accepted-posture block) |
| **P-1a** | Unused by-id SQLite getters are kept deliberately as a cross-repo parity contract (maintain in lockstep). | §4.7 |
| **A-2** | `PUT /api/admin/metadata/config` full-replace-on-omit is load-bearing override-revert; never convert to merge/PATCH. | §4.6 warning block |
| **I-6b** | Both `backdrop_focal` and `backdrop_focal_suggested` are exposed raw; precedence is deliberately the frontend's to resolve. | Appendix B (adjacency note) |
| **I-7b** | Local-art curation is direct file placement at the convention filename; overrides stay URL-only. | §3 image-files entry |
| **V-5** | No auth/rate limiting on ffmpeg-triggering generation routes is an accepted, documented trust boundary. | §4.9 |
| **M-5** | The Mongo tier and its three sub-kinds of state are documented architecture, no longer an omission. | §1.4 |

---

## Accepted as documented

Current behavior in each of these twelve items is correct, or an already-made and still-valid decision. No code changes are planned; each entry exists so the next reader does not re-open the question from scratch.

**I-2 — forceRefresh unconditionally wipes managed images.**
`node/lib/metadataGenerator.mjs` `_wipeManagedImagesForForceRefresh()` unlinks every accepted-extension file in each image slot on a forced refresh (tmdb.config id change/rescan), explicitly *not* gated by `SCANNER_RECONCILE_MODE` — a deliberate operator-intent signal: changing the pinned id means the old art is definitionally wrong. This matches a standing, explicit prior project decision. Overrides survive because they are re-applied from the freshly fetched, override-merged metadata immediately after the wipe.

**I-8 — The claimed logo-blurhash propagation gap does not hold.**
Verification across every layer that assembles the poster/backdrop/logo blurhash triplet (scanners, row mappers, routes, both hash tables) found the logo treated identically to poster and backdrop. The sole exception is SVG logos, which are correctly and intentionally skipped — an SVG cannot be encoded as a raster blurhash.

**T-8 — The survey-era "one TMDB field never surfaced by the image-lookup function" claim does not reproduce.**
The survey critique carried a one-line finding that "one metadata field TMDB provides is never surfaced by the image-lookup function that returns the rest," naming neither the field nor the function. Verification against the current client found no such gap: `getMediaImages()` (`node/utils/tmdb.mjs`) returns `backdrops`, `posters`, `logos`, and a derived `logo_path` — every image array TMDB's `/images` endpoint provides; `getEpisodeImages()` surfaces the full `stills` array plus a derived `thumbnail_url`; and `getCollectionImages()` returns both keys (`backdrops`, `posters`) the collection-images endpoint actually provides (confirmed against a live TMDB response — collections carry no `logos` array). The only unforwarded value anywhere is the redundant numeric `id` envelope on the images responses. Investigated and closed with no identified referent; reopen only with a concrete field-and-function citation.

**P-1c — The surrogate SQLite `id` invariant already holds.**
`movies.id`/`tv_shows.id` (`AUTOINCREMENT`) never cross a module boundary to an external consumer that could persist them across a `media.db` rebuild; the insert/update paths never capture `lastID` for external use. The code comment stating the invariant (stable external references must key on `name` or the TMDB-derived `_id`, never on `id`) landed with Branch 1 in `initializeSchema()`.

**P-2 — The movie/TV upsert-guard asymmetry is intentional.**
`node/sqliteDatabase.mjs` `insertOrUpdateMovie()` guards its update with `WHERE movies.directory_hash IS NULL OR movies.directory_hash <> excluded.directory_hash`; `insertOrUpdateTVShow()` always rewrites. This is deliberate: TV directory hashes are computed at a shallow depth (deep episode changes do not move them), and the episode-backfill fall-through can legitimately rewrite season/episode data when the top-level hash has not changed — a movies-style guard on TV would silently drop that write. The warning comment above the TV insert landed with Branch 1.

**P-3 — Uniform relaxed SQLite durability is acceptable.**
`PRAGMA synchronous = NORMAL` everywhere means the worst-case loss for the non-derivable bookkeeping tables is one extra premature retry (`missing_data_media`/`episode_metadata_missing` — self-healing on next write) or one duplicate Discord onboarding DM (`discord_intros` — already idempotency-guarded by `INSERT OR REPLACE`). Both bounded and self-correcting; a one-line `synchronous = FULL` branch for the discord connection is the ready remedy if the DM case is ever judged unacceptable.

**F-5 — ~20-minute worst-case hash-propagation staleness is accepted.**
Four independently reasonable freshness layers stack additively rather than overlapping: the auto-captions config cache (30 s), the 15-minute scheduled hash sweep, the hashes endpoint's `max-age=300` HTTP cache, and the frontend's own polling cache. Nothing coalesces them, so worst-case propagation approaches their sum. Accepted as the current SLA; the ceiling dropped substantially with Branch 4's F-2 fix (merged), because real content changes — including brand-new titles — now get their hash written within the 3-minute scan tick instead of waiting for the sweep.

**A-5 — The lazy DB write behind unauthenticated `GET /metadata-hashes/...` is already safely hardened.**
The write fires at most once per title (guarded by `!hash`), only after a 404 gate rejects unknown titles (`node/routes/metadataHashes.mjs`), uses only server-side authoritative data, and `storeHash`'s delete-then-insert pattern is self-healing against duplicates. No auth is consistent with this route being part of the public hash-sync contract the frontend polls, which carries no sensitive data. The comment explaining why the 404-before-write ordering and self-healing dedup make the pattern safe is in place.

**S-5 — The residual Python poster-collage script is correctly out of scope.**
`scripts/generate_poster_collage.py` makes no TMDB API calls — it is a pure filesystem walk plus Pillow composite of already-downloaded posters — so it is genuinely outside the "remove Python from the TMDB pipeline" effort, and `requirements.txt` already states this scoping decision explicitly. A fully Python-free image (reimplementing collage in Node with `sharp`, already a dependency) is a separate future initiative.

**V-0 — The video/transcode cache-directory subsystem is correctly modeled as disposable derived state.**
The five on-demand cache directories (`general`, `video_clips`, `spritesheet`, `video_transcode`, `frames`) are pure derived artifacts of the source mp4 files; SQLite's only footprint (`process_queue`) is wiped on restart. `cache/general` has no current producer anywhere in the codebase (orphaned/legacy — its scheduling disposition was folded into Branch 11's V-1 work, merged). The unauthenticated-*read* posture matches the intentional streaming precedent; the separate generation-triggering question was decided under V-5 (see the resolved records table).

**V-6 — atime-based cache eviction is fragile under `relatime` but low severity.**
The segment/spritesheet/frames sweeps in `node/utils/utils.mjs` key on `stats.atimeMs`, which under Linux `relatime` semantics can go stale for an actively read file — so a client scrubbing past the window could have a file unlinked mid-use. POSIX unlink of an open descriptor is safe (the in-progress stream keeps reading), so the only cost is the next request taking a cheap cache-miss regeneration. Self-healing failure mode; no change.

**D-4 — The in-memory, single-process webhook idempotency guard is an accepted tradeoff.**
`node/integrations/discord/IMPLEMENTATION_NOTES.md` already names Redis as the fix if this backend ever runs multi-instance; it runs as a single instance today. The real anti-duplicate-DM guard is the persistent, idempotent SQLite `discord_intros` table — multi-instance duplication would at worst produce redundant webhook-processing log noise, not duplicate DMs.

---

## Future feature directions

Intentions recorded 2026-07-07 that are larger than any single backlog item. Nothing here is scheduled.

### Radarr/Sonarr integration (extends T-3)

The T-3 year-match heuristic is the **near-term** fix for wrong auto-matches. The **long-term** direction is to stop guessing entirely: when a Radarr/Sonarr instance is configured, pull the authoritative `tmdb_id` for each title from its feed instead of running a TMDB name search — those tools have already done the disambiguation, and their library view maps one-to-one onto this backend's media directories. This is intended as part of a deeper media-management integration (library state, quality/upgrade awareness, possibly rename events feeding the V-4 file-identity question), not just an id-lookup shortcut. Design work should treat the year heuristic as the permanent fallback for titles no external manager knows about.

### On-demand scan routes (extends S-3)

S-3's decided outcome is to add the symmetric TV scan path (a TV equivalent of `POST /media/scan`, or a `mediaType` parameter), routed through the task manager per S-2's gating decision. What remains open is **frontend adoption**: the `nextjs-stream` frontend does not call the on-demand scan routes today, so both variants ship as available-but-unadopted surface. Whether the frontend ever drives per-type scans — or the routes are eventually retired in favor of the combined scheduled scan — is a frontend-side product decision, tracked there rather than here.
