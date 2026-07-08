# TV Metadata Staleness Hardening Plan

## Overview

The movie sync path was recently hardened against three "frontend shows stale/wrong metadata even though the on-disk `metadata.json` is correct" failure modes. TV (shows + episodes) is exposed to the **same** failure modes — and on the *spent-gate* axis it is exposed *more* than movies, because the frontend stamps the TV `syncHash` unconditionally.

This work spans **two repos**:

- **This repo** — `nextjs-stream-media-processor` (backend / scanner / Express API / SQLite). The hash-generation, metadata-URL, and cache-bust changes live here.
- **Frontend** — `nextjs-stream` (sibling repo, `C:\Users\Adrum\Documents\github\nextjs-stream`). The sync-gate / stamping changes live there; a companion plan is at `nextjs-stream/plans/tv-metadata-staleness-hardening.md`.

No TV symptom has been *reported* yet — this is preventative, the TV analogue of the movie fixes already shipped. Recommended ordering: **Phase 1 (show-level) first**, **Phase 2 (episode-level) second**. Run **Phase 0 detection** first to see if anything is already stuck.

---

## Background: the three failure modes (and the movie precedent)

Metadata flow: scanner writes `metadata.json` + computes a hash into SQLite `metadata_hashes` → serves `GET /api/metadata-hashes/{movies,tv}` (the gate hash) and the `metadata.json` file (the content) → webhook triggers a frontend sync → the frontend compares the incoming hash vs its stored hash and, if different, fetches `metadata.json` and writes it to MongoDB.

1. **Frozen hash** — the upstream hash doesn't change when only `metadata.json` *content* changes (e.g. a tmdb_id edit with unchanged images). Stored hash keeps matching → frontend skips forever.
2. **Stale fetch** — the frontend fetches `metadata.json` via `fetchMetadataMultiServer` keyed by **URL**, with a 1h Redis cache + conditional-304 path. A URL with no content-version token serves stale content after a change.
3. **Spent gate** — the frontend's stored gate hash (`syncHash`) advances even though metadata wasn't actually refreshed (asset-only change, stale fetch, or failed fetch). Once it matches, the early-skip fires forever and the entity is locked on stale metadata.

### What was already done for movies (templates for the TV work)

This repo:
- **Frozen hash** — `generateMovieHashes` folds `metadata` content into the hash: [`../node/sqlite/metadataHashes.mjs`](../node/sqlite/metadataHashes.mjs) (the `metadata: movie.metadata` field, ~L419).
- **Stale fetch** — `urls.metadata` is cache-busted with `directory_hash` via `buildImageUrl` in `getMovies` / `getMovieById` / `getMovieByName`: [`../node/sqliteDatabase.mjs`](../node/sqliteDatabase.mjs) (~L777 / L843 / L896). `buildImageUrl` (~L582) appends `?hash=<token>` and is a no-op when either arg is falsy.

Frontend repo (`nextjs-stream`):
- **Spent gate** — `MovieMetadataStrategy` preserves existing metadata + returns `SyncStatus.Failed` on a failed fetch (no `_metadataHash` stamp); `MovieSyncService` stamps `syncHash` only when no metadata op reported `Failed`.

Cross-repo chain + access points are documented in the memory file `project_metadata_propagation_chain.md`.

---

## Verified TV exposure matrix

| Level | Frozen hash | Stale fetch | Spent gate |
|---|---|---|---|
| **Show** | ❌ exposed — show hash uses `metadata_path` (a path string), not content | ❌ exposed — `metadata_path` URL not cache-busted | ❌ exposed — `syncHash` stamped **unconditionally** (frontend) |
| **Episode** | ✅ protected — episode hash already includes `metadata` content | ❌ exposed — episode metadata URL not cache-busted (mitigated by an inline fallback) | ❌ exposed — `syncHash` stamped **unconditionally** (frontend) |
| **Season** | ✅ n/a — sourced inline from the parent show | ✅ protected — inline, no fetch | ✅ protected — no separate hash stamp |

### Evidence (this repo)

- Show hash uses path, not content — [`../node/sqlite/metadataHashes.mjs`](../node/sqlite/metadataHashes.mjs) `generateTVShowHashes`: `showHashableData = { name, metadata_path, poster, logo, backdrop, seasonKeys }` (~L451-458).
- Episode hash includes content — same file, `episodeHashableData` includes `metadata: episodeData.metadata` (~L496-507).
- Season hash — `{ seasonNumber, season_poster, episodeKeys }` (~L474-478), no metadata.
- Show metadata URL not cache-busted — [`../node/components/media-scanner/domain/tv-scanner.mjs`](../node/components/media-scanner/domain/tv-scanner.mjs#L221) builds `${prefixPath}/tv/${show}/metadata.json` (no `?hash=`); served raw via [`../node/app.mjs`](../node/app.mjs#L755) (`metadata: show.metadata_path`).
- Episode metadata URL not cache-busted — [`../node/components/media-scanner/domain/tv-scanner.mjs`](../node/components/media-scanner/domain/tv-scanner.mjs#L341).
- Show object source — `getTVShows` in [`../node/sqliteDatabase.mjs`](../node/sqliteDatabase.mjs) (~L693-731) returns `metadata` (inline content) and `metadata_path`; the raw `tv_shows` row also has `directory_hash`.

### Evidence (frontend repo, `nextjs-stream`)

- Show fetch via URL — `src/utils/sync/domain/tv/TVShowSyncService.ts` ~L225-244 (`fetchMetadataMultiServer(..., fileData.metadata, 'file', 'tv', ...)`).
- Show skip gate — same file ~L64-93 (`cached.syncHash === incoming.hash` + optional `contentHash` + episode-count check).
- Show stamp (unconditional) — same file ~L350-357 (`if (incomingShowHash) entity.syncHash = incomingShowHash`).
- Episode fetch via URL + inline fallback — `src/utils/sync/domain/tv/EpisodeSyncService.ts` ~L347-390.
- Episode stamp (unconditional, before fetch) — same file ~L116-117.
- Season inline source — `src/utils/sync/domain/tv/SeasonSyncService.ts` ~L175-206.

---

## Phase 0 — Detection pass (do first, read-only)

Mirror the movie reconciliation to see whether any TV is *already* stuck before writing code.

- **Shows**: for each `FlatTVShows` doc, compare `metadata.id` vs the on-disk `N:\html\tv\<originalTitle>\metadata.json` `id`.
- **Episodes**: for each `FlatEpisodes` doc, compare its metadata identity vs the parent show's on-disk `metadata.seasons[].episodes[]`.

Tools: MongoDB MCP (DB `Media`, collections `FlatTVShows`, `FlatEpisodes`, `FlatSeasons`); media-processor SQLite at `N:\docker_apps\nextjs-stream-media-processor\db\media.db` (read-only via `node` + `sqlite3` from the `node/` dir); on-disk media `/var/www/html` ↔ `N:\html`. If divergences exist, the `$unset syncHash + metadataHash` reset unsticks them once the code fixes ship.

---

## Phase 1 — Show-level hardening

### 1A. Frozen hash — THIS REPO
File: [`../node/sqlite/metadataHashes.mjs`](../node/sqlite/metadataHashes.mjs), `generateTVShowHashes`.
Fold show metadata **content** into the show hash, mirroring `generateMovieHashes`:
```js
const showHashableData = {
  name: show.name,
  metadata: show.metadata,        // ← add: fold content in (was metadata_path only)
  metadata_path: show.metadata_path,
  poster: show.poster,
  logo: show.logo,
  backdrop: show.backdrop,
  seasonKeys: Object.keys(show.seasons)
};
```
**Verify first:** confirm the `show` passed to `generateTVShowHashes` carries parsed metadata content in `show.metadata` (true via `getTVShows`), not just the path. If the call site passes a raw row without parsed metadata, parse/attach it there.

### 1B. Stale fetch — THIS REPO
File: [`../node/sqliteDatabase.mjs`](../node/sqliteDatabase.mjs), `getTVShows` (and `getTVShowById` / `getTVShowByName` for parity).
Cache-bust the served show metadata URL with `directory_hash`, mirroring movies. `/media/tv` serves `show.metadata_path` ([`../node/app.mjs`](../node/app.mjs#L755)), so transform it where the show object is built:
```js
// the tv_shows row has directory_hash even though the current return object omits it
metadata_path: buildImageUrl(show.metadata_path, show.directory_hash),
```

### 1C. Spent gate — FRONTEND REPO (`nextjs-stream`)
File: `src/utils/sync/domain/tv/TVShowSyncService.ts` (~L225-244 fetch, ~L350-357 stamp).
Make the `syncHash` stamp conditional on a **confirmed** show-metadata fetch:
- Track a `metadataFetchSucceeded` flag, true only when `fetchMetadataMultiServer` returned usable metadata (`showMetadata && !showMetadata.error`), false in the `catch`/`null`/`error` branches.
- Stamp `entity.syncHash = incomingShowHash` only when `metadataFetchSucceeded` (or when the show-level skip legitimately fired because the hash already matched). Leave it unstamped on fetch failure so the next sync retries.
- Keep `contentHash` stamping **unconditional** — it tracks video-file changes, not metadata, and isn't the metadata gate.
- On fetch failure, preserve existing `entity.metadata` (already the behavior ~L239-241) — just don't advance the gate alongside it.

---

## Phase 2 — Episode-level hardening

### 2A. Stale fetch — THIS REPO (more involved)
File: [`../node/components/media-scanner/domain/tv-scanner.mjs`](../node/components/media-scanner/domain/tv-scanner.mjs#L341) — the episode metadata URL is baked into the seasons JSON at scan time.
Append a content-version token to each episode's metadata URL:
- **Scan-time (preferred):** append the episode's content hash (or the show `directory_hash`) when building `episodeData.metadata`, so the stored seasons JSON already carries `?hash=`.
- **Serve-time:** in `getTVShows`, walk `seasons[].episodes[]` and rewrite each `metadata` URL with a token (avoids a rescan to populate, but adds per-request work).

### 2B. Spent gate — FRONTEND REPO (`nextjs-stream`)
File: `src/utils/sync/domain/tv/EpisodeSyncService.ts` (~L103-117 skip+stamp, ~L347-390 fetch+fallback).
Condition the `(merged).syncHash = incomingEpHash` stamp so it only advances when the episode metadata was **confirmed fetched fresh** — not when the inline parent fallback was used and not on fetch failure. (The inline fallback is fine for display, but must not stamp the gate, or a stale parent would lock the episode.)

---

## Season-level — no action required

Seasons source metadata inline from the parent show (`SeasonSyncService` ~L175-206) and stamp no separate gate hash. They self-correct when the parent show's metadata is corrected (Phase 1). Documented here for completeness.

---

## Testing & rollout

1. **This repo**: `node --check` the edited `.mjs` files; rebuild + redeploy the media-processor image (container on 192.168.1.39).
2. **Frontend**: `npx tsc --noEmit` (must stay at 0 errors); deploy `nextjs-stream`.
3. **Functional validation**: pick a test show, change its `tmdb_id` in `tmdb.config`, let the scanner regenerate, confirm `FlatTVShows.metadata.id` updates on the next sync (and the show page reflects it after the frontend's ~2-min render cache).
4. **Reconciliation**: for any shows/episodes found divergent in Phase 0 (or post-deploy), `$unset syncHash` + `metadataHash` on the affected `FlatTVShows` / `FlatEpisodes` docs so the next sync re-pulls fresh.

## Cross-repo coordination

- **This repo** (backend): 1A, 1B, 2A. Deploy this image **first** — so the gate hash moves on content changes and the metadata URLs are cache-busted.
- **Frontend** (`nextjs-stream`): 1C, 2B. Deploy after the backend.

## References

- Companion plan (frontend-framed): `nextjs-stream/plans/tv-metadata-staleness-hardening.md`.
- Cross-repo propagation chain + debug access points: memory `project_metadata_propagation_chain.md`.
- Movie precedent in this repo: `generateMovieHashes` and the `getMovies*` cache-bust in [`../node/sqliteDatabase.mjs`](../node/sqliteDatabase.mjs) and [`../node/sqlite/metadataHashes.mjs`](../node/sqlite/metadataHashes.mjs).
