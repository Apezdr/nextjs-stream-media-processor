# TMDB Database Initialization Fix Plan

## Problem Analysis

From the Docker logs, we're seeing:

### Issue 1: Missing `tmdb_cache` Table
```
Error clearing expired TMDB cache: SQLITE_ERROR: no such table: tmdb_cache
Error getting TMDB cache: SQLITE_ERROR: no such table: tmdb_cache
Error setting TMDB cache: SQLITE_ERROR: no such table: tmdb_cache
```

### Issue 2: Excessive Table Initialization
```
"TMDB blurhash cache table initialized" appears 33+ times
SQLITE_BUSY encountered. Retrying 1/15 after 277ms...
```

## Root Causes

1. **Main Cache Table Not Initialized**: The `tmdb_cache` table is never created, but the code tries to use it
2. **No Initialization Guard**: Table initialization runs on every request instead of once at startup
3. **Database Contention**: Multiple concurrent requests cause SQLITE_BUSY errors

## Solution Plan

### Step 1: Create Main TMDB Cache Table Initialization

File: `node/sqliteDatabase.mjs`

Add function to initialize the main TMDB cache table:

```javascript
export async function initializeTmdbCacheTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tmdb_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      params TEXT NOT NULL,
      response_data TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      UNIQUE(endpoint, params)
    );
    
    CREATE INDEX IF NOT EXISTS idx_tmdb_cache_endpoint ON tmdb_cache(endpoint);
    CREATE INDEX IF NOT EXISTS idx_tmdb_cache_expires ON tmdb_cache(expires_at);
  `);
}
```

### Step 2: Add Singleton Pattern for Table Initialization

Create a module-level flag to track if tables have been initialized:

```javascript
// At the top of sqliteDatabase.mjs
let tablesInitialized = false;

export async function ensureTmdbTablesInitialized(db) {
  if (tablesInitialized) return;
  
  // Initialize both tables
  await initializeTmdbCacheTable(db);
  await initializeTmdbBlurhashCacheTable(db);
  
  tablesInitialized = true;
  logger.info('TMDB database tables initialized');
}
```

### Step 3: Call Initialization Once at Startup

File: `node/app.mjs` or main application file

Add initialization during app startup:

```javascript
// During application startup
const tmdbDb = await initializeDatabase('tmdbCache');
await ensureTmdbTablesInitialized(tmdbDb);
await releaseDatabase(tmdbDb);
```

### Step 4: Remove Per-Request Initialization

Files to modify:
- `node/sqlite/tmdbBlurhashCache.mjs` - Remove `initializeTmdbBlurhashCacheTable()` calls from high-level functions
- `node/utils/tmdb.mjs` - Remove any table initialization calls

Change from:
```javascript
export async function getCachedTmdbBlurhashWithDb(imageUrl) {
  const cacheDb = await initializeDatabase('tmdbBlurhashCache');
  try {
    await initializeTmdbBlurhashCacheTable(cacheDb);  // REMOVE THIS
    return await getCachedTmdbBlurhash(cacheDb, imageUrl);
  } finally {
    await releaseDatabase(cacheDb);
  }
}
```

To:
```javascript
export async function getCachedTmdbBlurhashWithDb(imageUrl) {
  const cacheDb = await initializeDatabase('tmdbBlurhashCache');
  try {
    // Table initialization happens at startup
    return await getCachedTmdbBlurhash(cacheDb, imageUrl);
  } finally {
    await releaseDatabase(cacheDb);
  }
}
```

### Step 5: Import Missing Function

File: `node/sqlite/tmdbBlurhashCache.mjs`

The `initializeTmdbBlurhashCacheTable` function needs to be exported from this file and imported by `sqliteDatabase.mjs`:

```javascript
// Already exists in tmdbBlurhashCache.mjs - just ensure it's exported
export async function initializeTmdbBlurhashCacheTable(db) {
  // ... existing code ...
}
```

## Implementation Status

### Already Implemented in `sqliteDatabase.mjs`:
1. ✅ **TMDB Cache Table Creation** (lines 172-193)
   - Table created with proper schema when `dbType === 'tmdbCache'`
   - Includes all required fields and indexes

2. ✅ **Singleton Pattern** (lines 26-30, 170, 198)
   - `hasInitialized.tmdbCache` flag prevents re-initialization
   - Tables created once on first `initializeDatabase('tmdbCache')` call

3. ✅ **Blurhash Table Initialization** (line 196)
   - `initializeTmdbBlurhashCacheTable(db)` called during setup
   - Already imported from `tmdbBlurhashCache.mjs` (line 7)

### Completed Fixes:
4. ✅ **Remove Per-Request Initialization** (`tmdbBlurhashCache.mjs`)
   - Removed `initializeTmdbBlurhashCacheTable()` from high-level functions
   - Changed database type from `'tmdbBlurhashCache'` to `'tmdbCache'`
   - Functions now rely on startup initialization

### Key Fix Applied:
The root cause was that high-level blurhash functions were using the wrong database type (`'tmdbBlurhashCache'` instead of `'tmdbCache'`), causing them to try accessing a different database file where tables didn't exist. Changed all references to use `'tmdbCache'` consistently.

## Expected Results

After implementation:
- ✅ No more "no such table: tmdb_cache" errors
- ✅ "TMDB blurhash cache table initialized" appears only once at startup
- ✅ Reduced SQLITE_BUSY errors due to less database contention
- ✅ Faster request processing (no repeated table creation)

## Testing Checklist

After applying fixes, verify:
- [ ] Docker container starts without "no such table: tmdb_cache" errors
- [ ] Only ONE "TMDB blurhash cache table initialized" message at startup
- [ ] Multiple TMDB API requests with `?blurhash=true` work correctly
- [ ] No SQLITE_ERROR messages in logs
- [ ] Blurhash data is being cached and retrieved successfully
- [ ] Reduced SQLITE_BUSY errors (should be rare or none)
- [ ] Both `tmdb_cache` and `tmdb_blurhash_cache` tables exist in `tmdb_cache.db`

## Summary of Changes

### Files Modified:
1. **node/sqlite/tmdbBlurhashCache.mjs**
   - `getCachedTmdbBlurhashWithDb()`: Changed database type to `'tmdbCache'`, removed table init
   - `cacheTmdbBlurhashWithDb()`: Changed database type to `'tmdbCache'`, removed table init
   - `clearExpiredTmdbBlurhashCacheWithDb()`: Changed database type to `'tmdbCache'`, removed table init

### Root Cause:
The blurhash cache functions were using a non-existent database type (`'tmdbBlurhashCache'`), causing them to try accessing a database file that didn't have the required tables initialized. By changing to `'tmdbCache'`, they now use the same database where tables are properly initialized once at startup.