# Backdrop Focal Placement

## Goal

Detect (or manually tag) where the subject sits in a backdrop image and expose that
information via the API so the streaming-app's Hero component can mirror its text layout
and overlay-gradient direction to the opposite side.

---

## Scope split

| Layer | Repo | Status |
|---|---|---|
| `backdrop_focal` field in `tmdb.config` | **this repo** | planned |
| SQLite schema + migration | **this repo** | planned |
| Scanner reads config → stores in DB | **this repo** | planned |
| API exposes `backdropFocal` in list responses | **this repo** | planned |
| Auto-detection utility (luminance map) | **this repo** | planned |
| Hero layout variants (left / right / center) | frontend repo | separate |
| Admin UI focal dropdown | frontend repo | separate |

---

## Phase 1 — Manual tagging (curated featured items)

Covers the ~8 featured-hero items. Ten-second editorial decision per item, perfect
control, zero ML dependencies.

### 1.1  `tmdb.config` schema extension

File: `node/utils/tmdbConfig.mjs`

Add `backdrop_focal` to `createDefaultConfig()` and validate it in
`validateTmdbConfig()`.

```jsonc
{
  "tmdb_id": 603,
  "update_metadata": true,
  "backdrop_focal": "right"   // "left" | "right" | "center" | null (null = unset, use auto or default)
}
```

`backdrop_focal: null` (default) means "not set; front-end may fall back to center or
run client-side auto-detection."

### 1.2  SQLite schema migration

File: `node/sqliteDatabase.mjs`

Add `backdrop_focal TEXT` column to both `movies` and `tv_shows` tables.
Add it to the existing `migrateToHashColumns()` (or a sibling migration function) so
existing databases upgrade automatically on next start.

### 1.3  Scanner — write focal tag to DB

Files:
- `node/components/media-scanner/domain/movie-scanner.mjs`
- `node/components/media-scanner/domain/tv-scanner.mjs`

After loading `tmdb.config` (already done in both scanners), read
`config.backdrop_focal` and pass it through to the DB upsert call alongside the
existing image columns.

### 1.4  SQLite query layer — return focal tag in data objects

File: `node/sqliteDatabase.mjs`

Return `backdrop_focal` (mapped to camelCase `backdropFocal`) from `getMovies()` and
`getTVShows()` so the field is available to every consumer without hitting disk.

### 1.5  API responses — expose `backdropFocal`

File: `node/app.mjs`

The `/list` (movies) and `/tv-list` (TV shows) response-building reducers already
spread the DB row fields. Verify `backdropFocal` flows through automatically after
step 1.4; add it explicitly if the reducer allowlists fields.

### 1.6  Admin API — already covered

The existing `PUT /admin/metadata/config` route in `node/routes/admin.mjs` accepts an
arbitrary `config` object and writes it via `saveTmdbConfig()`. Once `validateTmdbConfig`
is updated (step 1.1) it will accept and persist `backdrop_focal` with no further
route changes.

The frontend admin UI just needs a dropdown that POPs the new field into the config
payload it already sends.

---

## Technology research findings (May 2026)

`sharp ^0.34.5` is **already a direct dependency** of this project. This is the central
finding — it unlocks the first two tiers below for free.

### Option A — `sharp` luminance map (zero new deps) ✅ RECOMMENDED PHASE 2

`sharp` exposes two relevant APIs:

- **`.stats()`** — returns per-channel `mean`, `stdev`, dominant colour, `entropy`,
  and `sharpness` (Laplacian std dev).  Running `.stats()` on three `.extract()`'ed
  column regions gives average luminance per column in a single pipeline.
- **`.extract({ left, top, width, height })`** — pulls a rectangular region before
  `.stats()` is called.

Result: ~2–5 ms per image, no new packages.

### Option B — `smartcrop` + `smartcrop-sharp` (2 small packages) ✅ RECOMMENDED PHASE 2b

- [`smartcrop`](https://github.com/jwagner/smartcrop.js) — 13 k stars, MIT, v2.0.5
  (2021), tested in production on high-traffic sites.  Algorithm: Laplace edge
  detection + skin-tone regions + saturation boost → sliding-window candidate ranking.
- [`smartcrop-sharp`](https://github.com/jwagner/smartcrop-sharp) — official Node.js
  adapter that uses `sharp` (already installed) for image decoding, v2.0.8 (2023).

Returns a `topCrop` bounding box.  Bucket `topCrop.x + topCrop.width/2` into
left/center/right.  ~20 ms per image.  No native binary deps.

### Option C — ONNX Runtime + lightweight face model ✅ RECOMMENDED PHASE 2c

`onnxruntime-node` from Microsoft is the modern standard for running ML inference in
Node.js.  A quantized face-detection ONNX model (e.g. YuNet, RetinaFace ONNX, or
YOLOv8-face ONNX) gives face bounding boxes at ~30–80 ms per image with no Python
or TensorFlow dependency.

Install: `npm install onnxruntime-node` (~20 MB) + one ~5 MB `.onnx` model file.

### ❌ Options to avoid

| Library | Reason |
|---|---|
| `face-api.js` (original) | Abandoned — last commit March 2020 |
| `@vladmandic/face-api` | **Archived** February 2025 by author |
| `@vladmandic/human` | Heavyweight TFJS dep; last release Feb 2024; Node 23+ unsupported |
| `node-opencv` | Native build issues, dated Viola-Jones detector |

---

## Phase 2 — Auto-detection at upload/scan time

For rails, recommendation mini-heroes, and any item without a manual tag.

### 2.1  Luminance-map detector (no new runtime dependencies)

File: `node/utils/backdropFocalDetector.mjs`

Algorithm using existing `sharp`:
1. Load backdrop via `sharp(filePath)`.
2. Get image `width` from `.metadata()`.
3. Define three column regions: left third, center third, right third.
4. Run `.extract(region).stats()` on each — read the greyscale `mean` of the dominant
   channel (or compute luma as `0.299·R + 0.587·G + 0.114·B` from per-channel means).
5. Text goes in the **darkest column** (lowest mean → least competing brightness).
6. Return `'left' | 'right' | 'center'`.

Runs in ~2–5 ms. Works well for cinematic backdrops with strong dark/light column
asymmetry (most movie backdrops qualify).

### 2.2  Integration point

Call the detector inside both scanners after the backdrop file is confirmed present.
Store the result as `backdrop_focal_suggested` in `tmdb.config` (not `backdrop_focal`)
so the manual tag always wins:

```js
// Precedence: manual > auto-suggested > null
const focal = config.backdrop_focal ?? config.backdrop_focal_suggested ?? null;
```

Surface both fields in the DB and API so the admin UI can display the auto-suggestion
grayed out when no manual override exists.

### 2.3  Upgrade path

| Tier | Dep | New packages | Quality | ~Speed |
|---|---|---|---|---|
| Luminance map | `sharp` (installed) | 0 | Good (cinematic contrast) | 2–5 ms |
| `smartcrop-sharp` saliency | `smartcrop` + `smartcrop-sharp` | 2 small | Better (complex scenes) | ~20 ms |
| ONNX face detection | `onnxruntime-node` + `.onnx` model | 1 + model file | Best (actual faces) | 30–80 ms |

Tiers compose: face-detected bounding boxes can be passed as `boost` regions into
`smartcrop` for a combined result, then fall back to luminance if both return no
confident region.

---

## Implementation order

```
1.1 → 1.2 → 1.3 → 1.4 → 1.5   (Phase 1, backend fully wired)
     ↓
2.1 → 2.2                        (Phase 2, auto-detection)
     ↓
Frontend: Hero variants + admin dropdown (separate repo)
```

---

## Key files to touch

| File | Change |
|---|---|
| `node/utils/tmdbConfig.mjs` | add + validate `backdrop_focal` field |
| `node/sqliteDatabase.mjs` | schema migration + return field in queries |
| `node/components/media-scanner/domain/movie-scanner.mjs` | read + persist focal tag |
| `node/components/media-scanner/domain/tv-scanner.mjs` | read + persist focal tag |
| `node/app.mjs` | verify field flows through API response |
| `node/utils/backdropFocalDetector.mjs` | **new** — luminance-map utility |

No new routes needed for Phase 1. Admin config CRUD already exists.
