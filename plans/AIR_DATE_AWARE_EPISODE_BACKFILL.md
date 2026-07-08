# Air-Date-Aware Episode Metadata Backfill

## Context

When an episode video is present but TMDB's per-episode metadata is missing or thin (common right after broadcast — TMDB contributors fill in `name`/`overview`/`still_path` over the following hours/days), there's currently **no mechanism to re-check and fill it in** once nothing on disk is changing.

The scanner's existing missing-data retry is **show-level** (`missing_data_media`, keyed by show name, gated by `RETRY_INTERVAL_HOURS = 24`) and is driven by the **show** `metadata.json` being absent — it doesn't notice a present-but-thin *per-episode* file. The run gate is `dirHashChanged || missingImages || (missingMetadata && retry)` ([tv-scanner.mjs:570](../node/components/media-scanner/domain/tv-scanner.mjs#L570)). So:

- New episode added → dir hash changes → generator runs → episode fetched once (may come back thin).
- Days later TMDB fills the details → nothing on disk changed → **no re-run** → episode stays thin indefinitely (until the long `episode_metadata_refresh_days` age refresh happens to fire during some other-triggered run).

This adds a **second, additive trigger** (the existing age-based refresh is unchanged) that targets the missing/thin case on its own cadence, gated by the episode's TMDB `air_date` so we only poll when there's a real chance of new data.

## Locked decisions

- **Sparse** = `!name || !overview || !still_path` on the per-episode metadata.
- **Give-up** = retry every **3 days**, only while within **30 days** of `air_date`; after that the age-based refresh owns it.
- **TBA** (`air_date` null/empty) = **wait** — don't poll without a date (no benefit, only server load).
- **Wiring** = folded into the scan loop.
- **Refresh** = **surgical** — fetch only the due episodes; no image churn, no full-show regeneration.
- **State** = episode-level table.

## Design

### 1. Episode-level retry table — `node/sqliteDatabase.mjs`
Mirror `missing_data_media` ([:166](../node/sqliteDatabase.mjs#L166)):
```sql
CREATE TABLE IF NOT EXISTS episode_metadata_missing (
  show_name TEXT,
  season_number INTEGER,
  episode_number INTEGER,
  air_date TEXT,
  last_attempt TEXT,
  attempts INTEGER DEFAULT 0,
  PRIMARY KEY (show_name, season_number, episode_number)
);
```
Accessors (mirror `getMissingDataMedia` / `insertOrUpdateMissingDataMedia` patterns — `withDb` read, `withWriteTx` write, `withRetry`):
- `getEpisodeRetryRows(showName)` → rows for one show.
- `recordEpisodeMetadataAttempt(showName, season, episode, airDate)` → upsert, set `last_attempt = now`, `attempts = attempts + 1`, store `air_date`.
- (Optional) `clearEpisodeMetadataMissing(showName, season, episode)` for cleanup once resolved.

Re-export thin wrappers from `node/components/media-scanner/data-access/scanner-repository.mjs` next to `markMediaAsMissingData` ([:214](../node/components/media-scanner/data-access/scanner-repository.mjs#L214)).

### 2. Layer split (scanner I/O contract)
The scanner must not read `metadata.json` or know TMDB schema field names — that lives in `MetadataGenerator`. The split:

- **Scanner (cheap, schema-free)** — a zero-I/O pre-filter using presence flags `processEpisode` already put on `episodeData` in the built `sortedSeasons`: a candidate is `ep.metadata && !ep.thumbnail` (per-episode file present, no still downloaded; a complete episode has a thumbnail and falls through with zero I/O). Plus cooldown-table bookkeeping. It annotates candidates with their `lastAttempt`, hands them to the generator, and persists the outcome.
- **Generator (schema + content)** — reads each candidate's per-episode file, judges sparseness (`!name || !overview || !still_path`), reads `air_date`, applies the due-gate, and fetches + writes only when due.

> **Scope:** pure missing-file episodes (`!ep.metadata`) are left to the existing `dirHashChanged` generator path; this targets "file present but TMDB was thin at fetch time".
> **Trade-off:** the `!ep.thumbnail` proxy catches missing-`still_path` (the dominant thin signal) but would miss an episode that has a still yet lacks `overview`/`name` — rare; the age-based refresh fills it. Keeps detection O(incomplete episodes), not O(all episodes).

### 3. Gate + sparse helpers — in `node/lib/metadataGenerator.mjs`
Co-located with the generator (the schema-aware layer), not the scanner: `EPISODE_MISSING_RETRY_DAYS = 3` / `EPISODE_MISSING_WINDOW_DAYS = 30` (env-overridable), `isEpisodeMetadataSparse(data)` (`!name||!overview||!still_path`), and the pure date gate `isEpisodeBackfillDue({ airDate, lastAttempt, now })` (TBA→wait; not-aired→wait; `>` window→give up; `<` cooldown→wait).

### 4. Backfill in the generator — `refreshMissingEpisodes(tmdbId, candidates, { now, showName })`
Standalone export (no `MetadataGenerator` instance), reusing the module's existing imports (`getEpisodeDetails`, `readMetadataFile`/`writeMetadataFile`/`getEpisodeMetadataPath`, `downloadEpisodeThumbnail`). For each candidate `{seasonNumber, episodeNumber, seasonPath, lastAttempt}`:
- read the existing per-episode file → if **non-sparse**, return `{resolved:true}` (the scanner clears the cooldown row);
- else read `air_date`, run `isEpisodeBackfillDue`; if not due, return `{attempted:false}`;
- if due, `getEpisodeDetails` and **write only on a non-sparse result** (no mtime bump / false hash move on a still-thin response), download the thumbnail when `still_path` appears.

Returns `{seasonNumber, episodeNumber, attempted, written, resolved, airDate}` per candidate.

### 5. Scanner orchestration — `backfillMissingEpisodes(showName, showPath, tmdbId, seasons, now)`
Called at the **end of the per-show iteration** (after `generateTVShowHashes`) — i.e. **after** `finalHash` is stored, so rewrites are picked up on the *next* scan (see propagation):
1. `tmdbId` from `JSON.parse(metadataResult.metadata).id` (skip if absent).
2. Zero-I/O proxy over `sortedSeasons` → candidates; return early if none (healthy show = in-memory walk only).
3. `getEpisodeRetryRows(showName)` → annotate each candidate with `lastAttempt`.
4. `refreshMissingEpisodes(tmdbId, candidates, { now, showName })`.
5. Persist from outcomes only: `clearEpisodeRetry` on `resolved`, `recordEpisodeAttempt` on `attempted`. No file reads, no schema.

### Propagation (free, via existing machinery)
`calculateDirectoryHash` hashes `name:size:mtimeMs` per file ([utils.mjs:661](../node/utils/utils.mjs#L661)). Backfill runs *after* the show's `finalHash` is stored, so:
- **Scan N:** backfill writes/overwrites the per-episode file + records the attempt.
- **Scan N+1:** the file's new mtime/size flips `dirHashChanged` → full reprocess → seasons JSON rebuilt with the fresh 2A URL token → `generateTVShowHashes` → episode hash moves → frontend re-syncs the now-complete episode. (~3–6 min end-to-end.) The just-written file is age-fresh, so the generator's normal age gate skips re-fetching it; the episode is now non-sparse so backfill won't re-attempt.

## Edge cases
- TBA / no `air_date` → never polled (wait for an age-based pull).
- Aired but TMDB stays thin → retried every 3 days until `air_date + 30d`, then dropped to the age-based path.
- New episode just added → handled by the existing `dirHashChanged` generator run; backfill only covers the "filled in later" gap.
- Episode not in TMDB's season list (beyond the 50-cap or unknown) → `air_date` unknown → wait.
- Specials (Season 0) with odd/missing dates → wait unless a real `air_date` is present.

## Config / constants
- `EPISODE_MISSING_RETRY_DAYS = 3`, `EPISODE_MISSING_WINDOW_DAYS = 30` (consider env overrides, mirroring `EPISODE_METADATA_REFRESH_DAYS`).

## Files touched
- `node/sqliteDatabase.mjs` — table + 2–3 accessors.
- `node/components/media-scanner/data-access/scanner-repository.mjs` — re-export wrappers.
- `node/lib/metadataGenerator.mjs` — constants + `isEpisodeMetadataSparse` + `isEpisodeBackfillDue` + `refreshMissingEpisodes` (owns all schema/content/air-date logic).
- `node/components/media-scanner/domain/tv-scanner.mjs` — schema-free `backfillMissingEpisodes` (proxy + cooldown bookkeeping) + end-of-loop call + imports.

## Testing
- `node --check` each edited file.
- Unit-style check of `isEpisodeBackfillDue` (TBA, future, in-window/out-of-window, cooldown).
- Functional: pick a recently-aired thin episode (or temporarily blank a per-episode file's `overview`/`still_path`), confirm one scan writes the attempt row + (when TMDB has data) rewrites the file, and the next scan moves the episode hash → re-sync. Confirm a complete episode and a TBA episode are never touched.
