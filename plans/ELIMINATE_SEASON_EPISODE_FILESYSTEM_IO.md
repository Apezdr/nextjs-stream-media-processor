# Eliminate Season/Episode Filesystem I/O Performance Plan

## Executive Summary

The remaining read-path performance bottleneck in [`node/sqliteDatabase.mjs`](../node/sqliteDatabase.mjs) is **unnecessary filesystem I/O** for season/episode images. The scanner already embeds image hashes in URLs during write operations, but the read functions redundantly recalculate them via filesystem calls.

**Impact**: Eliminating ~3,000+ unnecessary `fs.stat()` calls per `getTVShows()` request.

---

## Current Architecture Analysis

### Write Path (Media Scanner)
✅ **Already optimized** - Scanner embeds hashes during write:

```javascript
// node/components/media-scanner/domain/tv-scanner.mjs

// Season poster (lines 357-366)
const seasonPosterStats = await fs.stat(seasonPosterPath);
const seasonPosterImageHash = createHash('md5')
  .update(seasonPosterStats.mtime.toISOString())
  .digest('hex')
  .substring(0, 10);

seasonData.season_poster = `${prefixPath}/tv/...?hash=${seasonPosterImageHash}`;

// Episode thumbnail (lines 263-274)
const thumbnailStats = await fs.stat(thumbnailPath);
const thumbnailImageHash = createHash('md5')
  .update(thumbnailStats.mtime.toISOString())
  .digest('hex')
  .substring(0, 10);

episodeData.thumbnail = `${prefixPath}/tv/...?hash=${thumbnailImageHash}`;
```

**Result**: URLs stored in seasons JSON blob already contain valid, up-to-date hashes.

### Read Path (Database Queries)
❌ **Currently inefficient** - Redundantly recalculates hashes:

```javascript
// node/sqliteDatabase.mjs (lines 598-601)

const updatedSeasons = {};
for (const [seasonName, season] of Object.entries(seasons)) {
  updatedSeasons[seasonName] = await refreshSeasonImageHashes(season, basePath, showPath, seasonName);
}
```

**Problem**: `refreshSeasonImageHashes()` does `fs.stat()` on:
- Every season poster path
- Every episode thumbnail path

**Scale**: 50 shows × 5 seasons × (1 season poster + 12 episode thumbnails) = **~3,250 syscalls per request**

---

## Root Cause

The code was written assuming URLs needed real-time hash refresh on every read. However:

1. Scanner **already embeds** hashes at write time
2. Hashes are based on **mtime**, not contents
3. Scanner refreshes hashes when it **detects file changes**
4. Between scans, cached hashes are **perfectly valid**

The `refreshSeasonImageHashes()` function is **redundant** because:
- It recalculates hashes that are already in the URLs
- It does unnecessary I/O for data that won't change until next scan
- It violates the same "read from cache, write on scan" pattern we use for show-level images

---

## Solution Architecture

### Strategy: Trust Cached Hashes

Apply the **same pattern** we use for show-level images (poster, logo, backdrop):

**Before** (current):
```javascript
// Show-level: Use cached hashes (NO filesystem I/O) ✅
const poster = buildImageUrl(show.poster, show.poster_hash);

// Season/episode: Recalculate hashes (filesystem I/O for every image) ❌
updatedSeasons[seasonName] = await refreshSeasonImageHashes(season, ...);
```

**After** (proposed):
```javascript
// Show-level: Use cached hashes (NO filesystem I/O) ✅
const poster = buildImageUrl(show.poster, show.poster_hash);

// Season/episode: Use cached hashes from URLs (NO filesystem I/O) ✅
const updatedSeasons = seasons; // URLs already have hashes!
```

### Implementation Changes

#### 1. Update `getTVShows()` (lines 581-624)

**Remove**:
```javascript
// Update each season's image URLs (still uses filesystem I/O - will optimize in episode normalization phase)
const updatedSeasons = {};
for (const [seasonName, season] of Object.entries(seasons)) {
  updatedSeasons[seasonName] = await refreshSeasonImageHashes(season, basePath, showPath, seasonName);
}
```

**Replace with**:
```javascript
// Use seasons directly - URLs already contain cached hashes from scanner
// No filesystem I/O needed since scanner embeds hashes during write operations
const updatedSeasons = seasons;
```

#### 2. Update `getTVShowById()` (lines 782-823)

Same change as above.

#### 3. Update `getTVShowByName()` (lines 825-866)

Same change as above.

#### 4. Keep `refreshImageUrlHash()` as Legacy Helper

Don't remove it immediately - might be useful for:
- Manual admin operations outside scanner
- Debugging/troubleshooting
- Potential future edge cases

Add deprecation notice:
```javascript
/**
 * DEPRECATED: For legacy/manual operations only.
 * 
 * Scanner embeds hashes in URLs during write operations. Read paths should use
 * those cached hashes instead of calling this function. This causes unnecessary
 * filesystem I/O.
 */
async function refreshImageUrlHash(url, filePath) { ... }
```

---

## Benefits

### Performance
- **~3,000+ fewer syscalls** per `getTVShows()` request
- **~50-200ms latency reduction** (depending on disk speed and library size)
- **Scales linearly** - larger libraries don't slow down reads

### Consistency
- **Matches show-level image pattern** (poster, logo, backdrop)
- **Unified caching strategy** across all media types
- **Predictable behavior** - reads never hit filesystem

### Maintainability
- **Simpler code** - no async loops through episodes
- **Fewer moving parts** - one source of truth (database)
- **Easier debugging** - no race conditions from filesystem state

---

## Trade-offs & Considerations

### ✅ Acceptable Trade-offs

1. **Slight delay in hash updates**: If someone manually replaces an image file, the old hash is served until next scan
   - **Mitigated by**: Scanner runs periodically/on-demand
   - **Impact**: Minimal - manual file changes are rare

2. **Browser cache may show old image**: If hash doesn't change immediately after file update
   - **Mitigated by**: Scanner will update hash on next run
   - **Impact**: Temporary - resolves within scan interval

### ✅ No Compatibility Issues

- **Backward compatible**: Existing URLs with hashes work unchanged
- **Forward compatible**: New scans continue embedding hashes
- **Migration-free**: No schema changes or data updates needed

### ✅ No Functional Regression

- **Cache busting still works**: URLs still have `?hash=` parameter
- **Freshness guarantee**: Scanner ensures hashes reflect file state
- **Same behavior as movies**: Matches already-deployed movie hash pattern

---

## Implementation Steps

### Phase 1: Code Changes
1. Remove `refreshSeasonImageHashes()` calls from `getTVShows()`
2. Remove `refreshSeasonImageHashes()` calls from `getTVShowById()`
3. Remove `refreshSeasonImageHashes()` calls from `getTVShowByName()`
4. Add deprecation notice to `refreshImageUrlHash()`
5. Update comments to reflect "trust cached hashes" architecture

### Phase 2: Testing
1. Test with existing TV show library
2. Verify URLs still contain `?hash=` parameters
3. Confirm no filesystem I/O during reads (add instrumentation)
4. Run load test comparing before/after performance
5. Verify browser cache busting still works

### Phase 3: Documentation
1. Update architecture documentation
2. Document hash refresh timing (scanner-driven)
3. Add performance metrics to README
4. Document legacy `refreshImageUrlHash()` use cases

---

## Performance Metrics

### Estimated Improvements

**Scenario**: Library with 50 TV shows, 5 seasons each, 12 episodes per season

**Before**:
- Per `getTVShows()` call: ~3,250 `fs.stat()` operations
- Estimated latency: 150-300ms (filesystem dependent)
- CPU: Moderate (async I/O waits)

**After**:
- Per `getTVShows()` call: 0 `fs.stat()` operations
- Estimated latency: <10ms (database query only)
- CPU: Minimal (simple JSON deserialization)

**Improvement**: ~95% reduction in read path latency

---

## Rollback Plan

If issues arise:

1. **Immediate**: Revert commits (pure code change, no schema migration)
2. **Fallback**: Restore `refreshSeasonImageHashes()` calls
3. **Investigation**: Check if scanner is properly embedding hashes

**Risk**: Minimal - read-only change with no data persistence impact

---

## Future Enhancements

After this change, consider:

1. **Episode normalization**: Separate `seasons` and `episodes` tables
2. **Hash columns**: Store season_poster_hash, episode_thumbnail_hash directly
3. **Blurhash optimization**: Apply same pattern to blurhash values
4. **Monitoring**: Add metrics to track hash refresh rates

---

## Conclusion

This is a **high-impact, low-risk** optimization that:
- ✅ Eliminates major read-path bottleneck
- ✅ Aligns with existing movie hash pattern
- ✅ Requires minimal code changes
- ✅ Has no schema migration overhead
- ✅ Maintains backward compatibility

The scanner already does the work of embedding hashes. We just need to **trust those cached values** instead of redundantly recalculating them on every read.

---

## References

- Review feedback: Initial performance analysis
- [`node/sqliteDatabase.mjs`](../node/sqliteDatabase.mjs): Database layer
- [`node/components/media-scanner/domain/tv-scanner.mjs`](../node/components/media-scanner/domain/tv-scanner.mjs): Scanner implementation
- Related: [`buildImageUrl()`](../node/sqliteDatabase.mjs:492) - show-level hash pattern
