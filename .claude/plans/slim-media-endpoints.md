# Plan: Slim Media Endpoints + Per-Item Detail Routes

## Context

The nextjs-stream sync system fetches `/media/tv` and `/media/movies` upfront before every sync run. As the library grows, these payloads become very large — `/media/tv` in particular embeds every episode's full data (videoURL, thumbnails, subtitles, codec metadata, `additionalMetadata`) for every season of every show in a single JSON response.

The nextjs-stream sync has recently gained hash-based skip logic: unchanged shows are skipped entirely after a single hash comparison. This means the full episode data is only needed for shows whose content hash has changed — typically a small fraction of the library on an incremental sync.

This plan adds:
1. `?slim=true` query parameter to existing `/media/tv` and `/media/movies` endpoints — lightweight response (season/episode keys only, no full episode data; no `fileNames`/`additional_metadata` for movies)
2. `GET /media/tv/:title` — full single-show detail (current `/media/tv` format for one show)
3. `GET /media/movies/:title` — full single-movie detail (current `/media/movies` format for one movie)

The nextjs-stream sync will fetch `?slim=true` upfront, then lazy-fetch `/media/tv/:title` only for shows whose hash has changed.

**No existing behaviour changes** when `?slim=true` is absent — all current clients continue to work.

---

## Critical Files

| File | Change |
|---|---|
| `app.mjs` | Modify `/media/tv` + `/media/movies` to support `?slim=true`; add `/media/tv/:title` and `/media/movies/:title` routes |
| `sqliteDatabase.mjs` | Verify `getTVShowByName(name)` and `getMovieByName(name)` return the right shape; add slim transform helpers |

---

## Phase 1 — `/media/tv?slim=true` (Lightweight TV Index)

### What changes

When `req.query.slim === 'true'`, the `/media/tv` handler transforms each show's `seasons` JSON by replacing episode objects with an `episodeKeys` array:

```javascript
// Current: seasons has full episode objects
{
  "Season 1": {
    "episodes": {
      "S01E01": { videoURL, thumbnail, thumbnailBlurhash, metadata, subtitles, hdr, mediaQuality, additionalMetadata, ... }
    },
    "lengths": { "S01E01": 2585120 },
    "dimensions": { "S01E01": "3840x2160" },
    "season_poster": "/tv/Show/Season 1/season_poster.jpg?hash=abc",
    "seasonPosterBlurhash": "/tv/Show/Season 1/season_poster.jpg.blurhash",
    "seasonNumber": 1
  }
}

// Slim: episodes replaced by episodeKeys array
{
  "Season 1": {
    "episodeKeys": ["S01E01", "S01E02", "S01E03"],
    "season_poster": "/tv/Show/Season 1/season_poster.jpg?hash=abc",
    "seasonPosterBlurhash": "/tv/Show/Season 1/season_poster.jpg.blurhash",
    "seasonNumber": 1
    // lengths and dimensions dropped — not needed without full episode data
  }
}
```

Show-level fields remain identical between slim and full responses:
`metadata`, `poster`, `posterBlurhash`, `logo`, `logoBlurhash`, `backdrop`, `backdropBlurhash`

### Implementation

Add a helper function near the existing `/media/tv` route:

```javascript
function slimifyTVSeasons(seasons) {
  if (!seasons || typeof seasons !== 'object') return seasons
  return Object.fromEntries(
    Object.entries(seasons).map(([seasonKey, seasonData]) => [
      seasonKey,
      {
        seasonNumber: seasonData.seasonNumber,
        season_poster: seasonData.season_poster,
        seasonPosterBlurhash: seasonData.seasonPosterBlurhash,
        episodeKeys: Object.keys(seasonData.episodes || {}),
      }
    ])
  )
}
```

Modify the `/media/tv` route handler:

```javascript
app.get("/media/tv", authenticateWebhookOrUser, async (req, res) => {
  try {
    const isSlim = req.query.slim === 'true'
    const db = await initializeDatabase()
    if (await isDatabaseEmpty("tv_shows")) {
      await generateListTV(db, `${BASE_PATH}/tv`)
    }
    const shows = await getTVShows()
    await releaseDatabase(db)

    const tvData = shows.reduce((acc, show) => {
      acc[show.name] = {
        metadata: show.metadata_path,
        poster: show.poster,
        posterBlurhash: show.posterBlurhash,
        logo: show.logo,
        logoBlurhash: show.logoBlurhash,
        backdrop: show.backdrop,
        backdropBlurhash: show.backdropBlurhash,
        seasons: isSlim ? slimifyTVSeasons(show.seasons) : show.seasons,
      }
      return acc
    }, {})

    res.json({ ...tvData, version: TV_LIST_VERSION })
  } catch (error) {
    logger.error(`Error fetching TV shows: ${error}`)
    res.status(500).send("Internal server error")
  }
})
```

### Cache headers consideration

The slim and full versions of `/media/tv` are different resources sharing the same URL with a query parameter. If any caching layer (Nginx, CDN) caches by URL only, it could serve a slim response to a client expecting full data or vice versa. Add `Vary: Accept-Encoding` (already likely present) and ensure `?slim=true` is treated as a distinct cache key. The media processor does not appear to add explicit cache headers to `/media/tv` currently, so this is low risk.

---

## Phase 2 — `/media/tv/:title` (Per-Show Full Detail)

New route — returns the current full `/media/tv` format for a single show. Uses the already-existing `getTVShowByName(name)` database function.

Place this route **before** any catch-all routes, but after the base `/media/tv` route:

```javascript
app.get("/media/tv/:title", authenticateWebhookOrUser, async (req, res) => {
  try {
    const title = decodeURIComponent(req.params.title)
    const db = await initializeDatabase()
    const show = await getTVShowByName(title)
    await releaseDatabase(db)

    if (!show) {
      return res.status(404).json({ error: `TV show not found: ${title}` })
    }

    res.json({
      metadata: show.metadata_path,
      poster: show.poster,
      posterBlurhash: show.posterBlurhash,
      logo: show.logo,
      logoBlurhash: show.logoBlurhash,
      backdrop: show.backdrop,
      backdropBlurhash: show.backdropBlurhash,
      seasons: show.seasons,
    })
  } catch (error) {
    logger.error(`Error fetching TV show "${req.params.title}": ${error}`)
    res.status(500).json({ error: "Internal server error" })
  }
})
```

**Auth**: `authenticateWebhookOrUser` — same as the base `/media/tv` endpoint.

**Response shape**: identical to a single entry from the current `/media/tv` full response (no `version` field — this is a single resource, not a collection).

**Route ordering note**: Express matches routes in registration order. Register `/media/tv/:title` AFTER `/media/tv` to avoid the base route being swallowed. If `app.mjs` uses a router, ensure ordering is explicit.

---

## Phase 3 — `/media/movies?slim=true` (Lightweight Movie Index)

When `req.query.slim === 'true'`, strip `fileNames` and `additional_metadata` from each movie. All other fields remain:

```javascript
// Current full movie response entry:
{
  "65": {
    "_id": "bc82e43d...",
    "fileNames": ["65.2023.HDR.mp4", "65.en.srt", ...],   // ← DROP in slim
    "length": { "65.2023.HDR.mp4": 5561056 },
    "dimensions": { "65.2023.HDR.mp4": "3840x1604" },
    "urls": { "poster": "...", "backdrop": "...", "mp4": "...", ... },
    "hdr": "HDR10",
    "mediaQuality": { ... },
    "additional_metadata": { "duration": ..., "size": ..., "audio": [...], "video": [...] }  // ← DROP in slim
  }
}

// Slim version:
{
  "65": {
    "_id": "bc82e43d...",
    "length": { "65.2023.HDR.mp4": 5561056 },
    "dimensions": { "65.2023.HDR.mp4": "3840x1604" },
    "urls": { "poster": "...", "backdrop": "...", "mp4": "...", ... },
    "hdr": "HDR10",
    "mediaQuality": { ... }
  }
}
```

**Why these fields specifically:**
- `fileNames`: array of raw filenames — not read by any sync strategy
- `additional_metadata`: contains `duration`, `size`, `audio[]`, `video[]` codec details — `duration` and `size` are already available via `length` and `urls.mediaLastModified`; the full codec tree is only needed for the media info page, not sync

Modify the `/media/movies` route handler:

```javascript
app.get("/media/movies", authenticateWebhookOrUser, async (req, res) => {
  try {
    const isSlim = req.query.slim === 'true'
    const db = await initializeDatabase()
    if (await isDatabaseEmpty()) {
      await generateListMovies(db, `${BASE_PATH}/movies`)
    }
    const movies = await getMovies()
    await releaseDatabase(db)

    const movieData = movies.reduce((acc, movie) => {
      const entry = {
        _id: movie._id,
        length: movie.lengths,
        dimensions: movie.dimensions,
        urls: movie.urls,
        hdr: movie.hdr,
        mediaQuality: movie.mediaQuality,
      }
      if (!isSlim) {
        entry.fileNames = movie.fileNames
        entry.additional_metadata = movie.additional_metadata
      }
      acc[movie.name] = entry
      return acc
    }, {})

    res.json({ ...movieData, version: MOVIE_LIST_VERSION })
  } catch (error) {
    logger.error(`Error fetching movies: ${error}`)
    res.status(500).send("Internal server error")
  }
})
```

---

## Phase 4 — `/media/movies/:title` (Per-Movie Full Detail)

New route using the existing `getMovieByName(name)` function:

```javascript
app.get("/media/movies/:title", authenticateWebhookOrUser, async (req, res) => {
  try {
    const title = decodeURIComponent(req.params.title)
    const db = await initializeDatabase()
    const movie = await getMovieByName(title)
    await releaseDatabase(db)

    if (!movie) {
      return res.status(404).json({ error: `Movie not found: ${title}` })
    }

    res.json({
      _id: movie._id,
      fileNames: movie.fileNames,
      length: movie.lengths,
      dimensions: movie.dimensions,
      urls: movie.urls,
      hdr: movie.hdr,
      mediaQuality: movie.mediaQuality,
      additional_metadata: movie.additional_metadata,
    })
  } catch (error) {
    logger.error(`Error fetching movie "${req.params.title}": ${error}`)
    res.status(500).json({ error: "Internal server error" })
  }
})
```

**Route ordering**: Register AFTER `/media/movies` base route.

---

## Implementation Sequence

1. **Phase 1** — `slimifyTVSeasons()` helper + `?slim=true` on `/media/tv` (no new routes, lowest risk)
2. **Phase 2** — `GET /media/tv/:title` (new route, uses existing DB function)
3. **Phase 3** — `?slim=true` on `/media/movies` (modify existing route)
4. **Phase 4** — `GET /media/movies/:title` (new route, uses existing DB function)

Each phase is independently deployable and independently testable. Phases 1 and 3 can be deployed before nextjs-stream is updated — existing clients see no change (they don't send `?slim=true`).

---

## Required nextjs-stream Changes (Companion Work)

These changes live in the nextjs-stream repo and are implemented after the media processor endpoints are live.

### `src/utils/fileServerDataService.js` (or wherever `getFileServerData()` is defined)

Change the fetch URLs to add `?slim=true`:
```javascript
// Before
const tvUrl = `${serverConfig.baseUrl}/media/tv`
const moviesUrl = `${serverConfig.baseUrl}/media/movies`

// After
const tvUrl = `${serverConfig.baseUrl}/media/tv?slim=true`
const moviesUrl = `${serverConfig.baseUrl}/media/movies?slim=true`
```

### `src/utils/sync/domain/tv/EpisodeSyncService.ts`

`syncSeason()` currently reads `seasonFileData.episodes` to get the episode list. With slim data, `seasonFileData.episodeKeys` is used instead:

```typescript
// Current (full data)
for (const [key, fileData] of Object.entries(seasonFileData.episodes || {})) { ... }

// After (slim data — episodeKeys are the keys, fetch full data per show for changed shows only)
// The full episode data comes from context.fileServerData which is populated lazily
// per show via GET /media/tv/:title for changed shows
```

This requires the lazy-load flow: when a show's hash has changed and `context.fileServerData.tv[showTitle]` only has the slim payload, fetch `/media/tv/:title` and merge it into `context.fileServerData.tv[showTitle]` before calling `syncSeason`.

### `src/utils/sync/domain/tv/TVShowSyncService.ts`

Add lazy fetch step in `syncTVShow()` when the show hash has changed:

```typescript
// After hash check passes (show has changed), before buildTVShowEntity:
if (!context.fileServerData?.tv?.[showTitle]?.seasons?.['Season 1']?.episodes) {
  // Slim data detected (has episodeKeys not episodes) — fetch full detail
  const fullData = await this.fetchShowDetail(showTitle, context.serverConfig)
  if (fullData && context.fileServerData?.tv) {
    context.fileServerData.tv[showTitle] = fullData
  }
}
```

The `fetchShowDetail` method would call `GET /media/tv/:title` and return the full show data.

---

## Response Size Estimates

Rough savings based on the "A Man in Full" example (6 episodes shown, ~10KB per episode in full format):

| Endpoint | Approximate size per show | Notes |
|---|---|---|
| Current `/media/tv` | ~15–50KB per show (varies with episodes) | Includes full episode codec data |
| Slim `/media/tv?slim=true` | ~1–2KB per show | Season keys only |
| `/media/tv/:title` | ~15–50KB | Fetched on-demand for changed shows only |

For a library of 50 shows, the upfront payload drops from ~1–2MB to ~50–100KB. For changed shows (say 5 on an incremental sync), 5 × ~30KB = ~150KB additional fetches — total ~200–250KB vs the current ~1–2MB.

---

## Verification

After deploying the media processor changes:

1. **Smoke test slim endpoints:**
   ```
   GET /media/tv?slim=true
   # → Each show's seasons should have episodeKeys[] not episodes{}
   
   GET /media/movies?slim=true
   # → Each movie should lack fileNames and additional_metadata
   
   GET /media/tv/A%20Man%20in%20Full
   # → Full show data including all episode details
   
   GET /media/movies/65
   # → Full movie data including fileNames and additional_metadata
   ```

2. **Backward compatibility:**
   ```
   GET /media/tv        # → identical to current behaviour
   GET /media/movies    # → identical to current behaviour
   ```

3. **Auth verification**: All four new/modified endpoints should reject requests without valid `x-webhook-id` or admin session.

4. **404 handling**: `GET /media/tv/NonExistentShow` → `{ "error": "TV show not found: NonExistentShow" }` with 404 status.

5. **After nextjs-stream is updated**: Run two consecutive syncs. The second should show significantly reduced network traffic (check with browser dev tools or server access logs) and complete faster.
