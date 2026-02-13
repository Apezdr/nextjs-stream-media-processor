# Enterprise Scanner Architecture - Performance-Critical Design

## Executive Summary

This document defines an enterprise-grade, performance-critical media scanning system that balances:
- **Speed**: New content indexed in <5 minutes
- **Safety**: Zero TMDB API rate limit violations  
- **Efficiency**: Only scan what needs scanning
- **Scale**: Handle 10,000+ item libraries
- **Intelligence**: Learn and adapt to patterns

The architecture is based on **three core principles**:

1. **State-Driven Processing**: Track lifecycle states (NEW, INDEXED, STALE, CHANGED) to avoid redundant work
2. **Multi-Tier Scanning**: Different scan modes for different needs (Quick, Refresh, Full)
3. **Proactive Rate Limiting**: Token bucket algorithm prevents API abuse before it happens

---

## Table of Contents

### Part 1: Foundation Architecture
1. [Content Lifecycle States](#1-content-lifecycle-states)
2. [Scan Strategies](#2-scan-strategies)
3. [Rate Limiting Architecture](#3-rate-limiting-architecture)
4. [Priority Queue System](#4-priority-queue-system)
5. [Database Schema](#5-database-schema-for-state-tracking)
6. [Scheduled Jobs](#6-scheduled-job-configuration)
7. [User Experience](#7-user-experience-guidelines)
8. [Performance Benchmarks](#8-performance-benchmarks)
9. [Error Handling](#9-error-handling--recovery)
10. [Migration Strategy](#10-migration-strategy)
11. [Before vs After Comparison](#11-comparison-before-vs-after)

### Part 2: Advanced Performance Optimization
12. [Parallel Processing Architecture](#12-parallel-processing-architecture)
13. [Predictive Caching & Prefetching](#13-predictive-caching--prefetching)
14. [Resource-Aware Scheduling](#14-resource-aware-scheduling)
15. [Memory & CPU Optimization](#15-memory--cpu-optimization)
16. [Network Optimization](#16-network-optimization)
17. [Advanced Queue Management](#17-advanced-queue-management)
18. [Real-Time Performance Metrics](#18-real-time-performance-metrics)
19. [Smart Scheduling Based on Patterns](#19-smart-scheduling-based-on-patterns)
20. [Performance Benchmarks (Target Goals)](#20-performance-benchmarks-target-goals)
21. [The Ideal Scanner - Complete Flow](#21-the-ideal-scanner---complete-flow)

---

# Part 1: Foundation Architecture

## 1. Content Lifecycle States

Every media item (movie/show/episode) exists in one of these states:

```
┌─────────────────────────────────────────────────────────────┐
│                   CONTENT LIFECYCLE                          │
└─────────────────────────────────────────────────────────────┘

    NEW                    File exists, no metadata
     │
     ├─> Initial Scan ──> INDEXED          Metadata current
     │                      │
     │                      ├─> Time passes (30d) ──> STALE
     │                      │
     │                      ├─> File modified ────> CHANGED
     │                      │
     │                      └─> File deleted ─────> MISSING
     │
     └─> Scan Failed ────> ERROR           Needs attention
```

### State Definitions

| State | Description | Action Required | TMDB API Calls |
|-------|-------------|----------------|----------------|
| **NEW** | File exists, no metadata.json | Fetch all metadata | 5-6 calls |
| **INDEXED** | Metadata exists & current | None | 0 calls (cache hit) |
| **STALE** | Metadata > 30 days old | Refresh from TMDB | 1-2 calls (ETag check) |
| **CHANGED** | File modified since last scan | Re-fetch metadata | 5-6 calls |
| **MISSING** | File deleted, metadata orphaned | Cleanup database | 0 calls |
| **ERROR** | Previous scan failed | Retry with backoff | Varies |

---

## 2. Scan Strategies

### 2.1 Quick Scan (Default - Every 15 minutes)
**Purpose**: Index new content fast, keep database synchronized with filesystem.

**Process**:
1. Check filesystem for new/changed files (mtime comparison)
2. Process only NEW and CHANGED items
3. Skip INDEXED items (already up-to-date)
4. **Time Estimate**: 1-5 minutes (typically <50 items)
5. **TMDB Calls**: ~200-300 requests max

**User Experience**: New media appears within 15 minutes of adding files.

```javascript
// Pseudocode
async quickScan() {
  const newItems = await findNewItems();        // No metadata.json
  const changedItems = await findChangedItems(); // mtime > last_scan
  
  await processInPriority([
    ...newItems,      // Priority 1: New content
    ...changedItems   // Priority 2: Changed content
  ], { maxConcurrent: 2, throttle: true });
}
```

### 2.2 Metadata Refresh (Daily at 3 AM)
**Purpose**: Keep TMDB data fresh (vote counts, ratings, new images).

**Process**:
1. Find STALE items (metadata older than 30 days)
2. Use ETag-based conditional requests (304 = no change)
3. Only fetch changed data
4. **Time Estimate**: 10-30 minutes (500-1000 items)
5. **TMDB Calls**: ~500-1000 requests (mostly 304 Not Modified)

**User Experience**: Background process, no user impact.

```javascript
async metadataRefresh() {
  const staleItems = await findStaleItems(30); // > 30 days old
  
  await processInBatches(staleItems, {
    batchSize: 50,
    delayBetweenBatches: 30000, // 30 sec between batches
    useETags: true,
    maxConcurrent: 1 // Conservative for background job
  });
}
```

### 2.3 Full Scan (Manual - Admin Only)
**Purpose**: Complete reindex, fix corrupted metadata, force refresh everything.

**Process**:
1. Scan entire filesystem
2. Force refresh all TMDB data (ignore cache, ignore ETags)
3. Download all missing images
4. **Time Estimate**: 1-3 hours (5000+ items)
5. **TMDB Calls**: 10,000+ requests

**User Experience**: Admin initiates, progress bar shown, ETA displayed.

```javascript
async fullScan({ forceRefresh = true }) {
  const allItems = await findAllItems();
  
  await processWithProgress(allItems, {
    maxConcurrent: 2,
    throttle: true,
    forceRefresh: true,
    progressCallback: (current, total, eta) => {
      notifyProgress({ current, total, eta });
    }
  });
}
```

---

## 3. Rate Limiting Architecture

### 3.1 TMDB API Limits
- **Official Limit**: 40 requests per 10 seconds
- **Our Target**: 35 requests per 10 seconds (87.5% utilization, 5 req buffer)
- **Burst Protection**: Never exceed 35 req in rolling 10-second window

### 3.2 Rate Limiter Implementation

```javascript
class TokenBucketRateLimiter {
  constructor(maxTokens = 35, refillRate = 3.5) { // 35 tokens, refill 3.5/sec
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate; // tokens per second
    this.lastRefill = Date.now();
  }

  async acquire(cost = 1) {
    await this.refill();
    
    while (this.tokens < cost) {
      const waitMs = ((cost - this.tokens) / this.refillRate) * 1000;
      await sleep(waitMs + 100); // +100ms buffer
      await this.refill();
    }
    
    this.tokens -= cost;
    return true;
  }

  async refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}
```

### 3.3 Request Patterns (OPTIMIZED with append_to_response)

**CRITICAL OPTIMIZATION**: Use TMDB's `append_to_response` to collapse multiple endpoints into single requests.

**Movie (NEW/CHANGED) - 1 Request Total**:
```javascript
// BEFORE (naive approach): 5-6 separate requests
// /movie/{id}, /movie/{id}/credits, /movie/{id}/videos, etc.

// AFTER (optimized): 1 request
GET /movie/{id}?append_to_response=credits,videos,images,release_dates,external_ids,keywords

// Returns ALL data in one response:
{
  id, title, overview, ...           // Base details
  credits: { cast: [...], crew: [...] }
  videos: { results: [...] }
  images: { posters: [...], backdrops: [...] }
  release_dates: { results: [...] }  // For rating extraction
  external_ids: { imdb_id, ... }
}
```

**TV Show (NEW/CHANGED) - 1 + N Requests**:
```javascript
// 1. Show metadata (1 request)
GET /tv/{id}?append_to_response=credits,videos,images,content_ratings,external_ids,keywords

// 2. Seasons (N requests for N seasons on disk)
GET /tv/{id}/season/{season_number}

// Season endpoint returns ALL episode metadata in one call:
{
  episodes: [
    { episode_number: 1, name: "...", still_path: "...", ... },
    { episode_number: 2, ... },
    // All 10-20 episodes included
  ]
}

// TV Show with 3 seasons × 10 episodes:
// BEFORE: 1 (show) + 5 (credits, etc) + 3 (seasons) + 30 (episodes) = 39 requests
// AFTER:  1 (show) + 3 (seasons) = 4 requests
// 🎯 90% reduction!
```

**With Rate Limiting**:
- Movie: 1 request → Instant
- TV Show (3 seasons): 4 requests → <2 seconds
- **No rate limit hit** ✓
- **10x faster than naive approach** 🚀

---

### 3.4 Rate Limiting Hardening (Real-World Battle Scars)

#### Multi-Instance Warning ⚠️
TMDB rate limits are **by IP address**, not per-process. If you run multiple scanner instances/containers on the same host/NAT, a per-process limiter is insufficient.

**Solutions**:
1. **Shared limiter** (Redis-based token bucket) for multi-instance deployments
2. **Leader election** - Only one instance runs scanner at a time
3. **Conservative limits** - Budget for 2-3 instances sharing the same IP

#### 429 Handling (Production-Grade)
Even perfect clients get throttled sometimes (shared IPs, enforcement changes, retries).

```javascript
class ProductionRateLimiter extends TokenBucketRateLimiter {
  async makeTmdbRequest(endpoint, params) {
    let retries = 0;
    const maxRetries = 5;
    
    while (retries < maxRetries) {
      await this.acquire(); // Token bucket
      
      try {
        const response = await axios.get(endpoint, { params });
        return response.data;
        
      } catch (error) {
        if (error.response?.status === 429) {
          // Obey Retry-After header (TMDB sends this)
          const retryAfter = parseInt(error.response.headers['retry-after']) || 10;
          logger.warn(`429 hit, respecting Retry-After: ${retryAfter}s`);
          
          // Reduce rate limit dynamically
          this.reduceRateLimit();
          
          await sleep(retryAfter * 1000 + Math.random() * 1000); // +jitter
          retries++;
          continue;
        }
        
        // Classify other failures
        if (error.response?.status === 401) throw new ConfigError('Invalid API key');
        if (error.response?.status === 404) throw new NotFoundError('Item not found');
        if (error.response?.status >= 500) {
          // TMDB server error, retry with backoff
          await sleep(Math.pow(2, retries) * 1000);
          retries++;
          continue;
        }
        
        throw error;
      }
    }
    
    throw new Error(`Failed after ${maxRetries} retries`);
  }
  
  reduceRateLimit() {
    // Adaptive: back off when we hit limits
    this.maxTokens = Math.max(20, this.maxTokens * 0.8);
    this.refillRate = this.maxTokens / 10;
    logger.warn(`Reduced rate limit to ${this.maxTokens} req/10s`);
  }
}
```

#### Jitter and Sliding Window
Add randomization to prevent thundering herd:

```javascript
async acquire(cost = 1) {
  await this.refill();
  
  // Add jitter (0-50ms) to spread requests
  await sleep(Math.random() * 50);
  
  // ... rest of token bucket logic
}
```

---

## 4. Priority Queue System with Deduplication

### 4.1 The Deduplication Problem

**Scenario**: User adds 200 episodes of a TV show. Without deduplication:
- 200 queue entries for the same show
- 200 × 4 = 800 TMDB requests
- Wasted tokens, slow scan

**Solution**: Deduplicate by `(media_type, tmdb_id)` and `file_path`.

```javascript
class DeduplicatingPriorityQueue {
  constructor() {
    this.queue = [];
    this.inFlight = new Set();      // Currently processing
    this.dedupe = new Map();        // tmdb_id -> queue entry
    this.pathDedupe = new Set();    // file paths queued
  }

  enqueue(item, priority) {
    // Dedupe by TMDB ID
    if (item.tmdbId && this.dedupe.has(item.tmdbId)) {
      logger.debug(`Skipping duplicate: ${item.name} (tmdb:${item.tmdbId})`);
      return false;
    }
    
    // Dedupe by file path
    if (this.pathDedupe.has(item.path)) {
      logger.debug(`Skipping duplicate path: ${item.path}`);
      return false;
    }
    
    const entry = {
      item,
      priority,
      enqueuedAt: Date.now(),
      originalPriority: priority
    };
    
    this.queue.push(entry);
    if (item.tmdbId) this.dedupe.set(item.tmdbId, entry);
    this.pathDedupe.add(item.path);
    
    this.sort();
    return true;
  }

  dequeue() {
    const entry = this.queue.shift();
    if (!entry) return null;
    
    // Mark as in-flight
    this.inFlight.add(entry.item.tmdbId || entry.item.path);
    
    return entry.item;
  }

  complete(item) {
    // Remove from tracking
    this.inFlight.delete(item.tmdbId || item.path);
    if (item.tmdbId) this.dedupe.delete(item.tmdbId);
    this.pathDedupe.delete(item.path);
  }

  sort() {
    this.queue.sort((a, b) => a.priority - b.priority);
  }
}
```

### 4.2 Priority Levels

```javascript
const Priority = {
  CRITICAL:  0,  // User-initiated scan (admin request)
  HIGH:      1,  // New files (no metadata)
  MEDIUM:    2,  // Changed files (file modified)
  LOW:       3,  // Stale metadata (>30 days)
  VERY_LOW:  4   // Full refresh (background)
};
```

### 4.3 Idempotency (Critical for Reliability)

Every operation must be safe to retry:

```javascript
async processItem(item) {
  // Atomic state transition
  await db.run(`
    UPDATE media_scan_state 
    SET scan_state = 'PROCESSING',
        processing_started_at = ?
    WHERE media_path = ? AND scan_state != 'PROCESSING'
  `, [new Date().toISOString(), item.path]);
  
  // If no rows updated, another worker is processing this item
  if (db.changes === 0) {
    logger.debug(`Item already being processed: ${item.path}`);
    return;
  }
  
  try {
    // Fetch TMDB data (idempotent - GET request)
    const tmdbData = await fetchTmdbData(item);
    
    // Upsert metadata (idempotent - replace on conflict)
    await writeMetadataFile(item.path, tmdbData);
    
    // Upsert images (idempotent - check if exists before download)
    await downloadImages(item, tmdbData);
    
    // Success - mark INDEXED
    await db.run(`
      UPDATE media_scan_state 
      SET scan_state = 'INDEXED',
          last_scanned_at = ?,
          metadata_updated_at = ?,
          error_count = 0,
          last_error = NULL
      WHERE media_path = ?
    `, [new Date().toISOString(), new Date().toISOString(), item.path]);
    
  } catch (error) {
    // Failure - mark ERROR with exponential backoff
    await db.run(`
      UPDATE media_scan_state 
      SET scan_state = 'ERROR',
          error_count = error_count + 1,
          last_error = ?
      WHERE media_path = ?
    `, [error.message, item.path]);
  }
}
```

---

## 5. Database Schema for State Tracking

### 5.1 Core State Table

```sql
CREATE TABLE media_scan_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- Identity
  media_path TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,     -- 'movie' | 'tv' | 'season' | 'episode'
  media_name TEXT NOT NULL,
  parent_path TEXT,             -- For episodes: point to show/season
  
  -- TMDB Linkage
  tmdb_id INTEGER,              -- Show ID, not episode ID
  tmdb_type TEXT,               -- 'movie' | 'tv'
  season_number INTEGER,
  episode_number INTEGER,
  
  -- State Machine
  scan_state TEXT NOT NULL DEFAULT 'NEW',
  processing_started_at TEXT,   -- For detecting stuck items
  
  -- Timestamps
  first_scanned_at TEXT,
  last_scanned_at TEXT,
  last_modified_at TEXT,        -- File mtime (ISO string)
  last_modified_ms INTEGER,     -- File mtime (epoch ms, for fast comparison)
  metadata_updated_at TEXT,     -- When metadata.json was written
  
  -- Caching & ETags (optional, don't rely on this)
  tmdb_etag TEXT,
  last_response_hash TEXT,      -- SHA256 of last TMDB response
  
  -- Error Tracking
  error_count INTEGER DEFAULT 0,
  last_error TEXT,
  next_retry_after TEXT,        -- For exponential backoff
  
  -- Performance
  file_size_bytes INTEGER,
  last_scan_duration_ms INTEGER,
  
  -- Indexes
  INDEX idx_scan_state (scan_state),
  INDEX idx_tmdb_id (tmdb_id),
  INDEX idx_parent (parent_path),
  INDEX idx_metadata_age (metadata_updated_at),
  INDEX idx_mtime (last_modified_ms)
);
```

### 5.2 Smart Metadata Aging

Don't use "30 days for all" - be intelligent:

```javascript
function calculateOptimalRefreshDays(item) {
  const now = Date.now();
  const releaseDate = new Date(item.releaseDate);
  const daysSinceRelease = (now - releaseDate) / 86400000;
  
  // New releases: refresh often (ratings/images change rapidly)
  if (daysSinceRelease < 30) return 3;      // 3 days
  if (daysSinceRelease < 180) return 14;    // 2 weeks
  if (daysSinceRelease < 365) return 30;    // 1 month
  
  // Old content: refresh rarely
  if (daysSinceRelease < 1825) return 90;   // 3 months (< 5 years old)
  return 180;                               // 6 months (old classics)
}
```

### 5.3 Error Cooldown (Exponential Backoff)

```javascript
function calculateNextRetryTime(errorCount) {
  const baseDelayMs = 60000; // 1 minute
  const maxDelayMs = 86400000; // 24 hours
  
  const delayMs = Math.min(
    maxDelayMs,
    baseDelayMs * Math.pow(2, errorCount)
  );
  
  return new Date(Date.now() + delayMs).toISOString();
}

// Usage
await db.run(`
  UPDATE media_scan_state 
  SET scan_state = 'ERROR',
      error_count = error_count + 1,
      last_error = ?,
      next_retry_after = ?
  WHERE media_path = ?
`, [
  error.message, 
  calculateNextRetryTime(item.errorCount + 1),
  item.path
]);
```

---

## 6. Filesystem Scanning Optimization

### 6.1 Two-Stage Walk (Critical for 10K+ Items)

**Problem**: At scale, opening every video file to check metadata is slow.

**Solution**: Two-stage approach.

```javascript
// Stage A: Fast enumeration (paths + basic stats only)
async function* streamFilesystemFast(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const fullPath = path.join(rootDir, entry.name);
      
      // Quick stats (no file open)
      const stats = await fs.stat(fullPath);
      
      yield {
        path: fullPath,
        name: entry.name,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        type: 'directory'
      };
      
      // Recurse
      yield* streamFilesystemFast(fullPath);
    }
  }
}

// Stage B: Deep inspection (only for NEW/CHANGED)
async function inspectMediaFile(item) {
  // NOW we open the file and parse metadata
  const videoMetadata = await getVideoInfo(item.path);
  
  return {
    ...item,
    duration: videoMetadata.duration,
    resolution: videoMetadata.resolution,
    // ... other expensive data
  };
}

// Usage
for await (const item of streamFilesystemFast('/media')) {
  const dbState = await getStateFromDb(item.path);
  
  if (!dbState) {
    // NEW item - needs deep inspection
    const fullItem = await inspectMediaFile(item);
    queue.enqueue(fullItem, Priority.HIGH);
  } else if (item.mtimeMs > dbState.last_modified_ms) {
    // CHANGED item
    const fullItem = await inspectMediaFile(item);
    queue.enqueue(fullItem, Priority.MEDIUM);
  }
  // else: INDEXED, skip
}
```

### 6.2 Directory-Level Acceleration

```javascript
// Calculate signature for entire directory
function calculateDirSignature(dirPath, files) {
  const fileList = files
    .map(f => `${f.name}:${f.mtimeMs}:${f.size}`)
    .sort()
    .join('|');
  
  return crypto.createHash('sha256').update(fileList).digest('hex');
}

// Check if directory changed
const currentSig = calculateDirSignature(showDir, files);
const cachedSig = await db.get(
  'SELECT dir_signature FROM dir_cache WHERE path = ?',
  [showDir]
);

if (currentSig === cachedSig?.dir_signature) {
  logger.debug(`Directory unchanged, skipping: ${showDir}`);
  return; // Skip entire directory tree
}

// Process directory, then cache new signature
await processDirectory(showDir, files);
await db.run(
  'INSERT OR REPLACE INTO dir_cache (path, dir_signature, last_checked) VALUES (?, ?, ?)',
  [showDir, currentSig, new Date().toISOString()]
);
```

### 6.3 Hybrid Watch Strategy (Linux/macOS)

```javascript
import { watch } from 'fs';

// Set up filesystem watcher (instant updates)
const watcher = watch('/media', { recursive: true }, (eventType, filename) => {
  if (filename.endsWith('.mp4') || filename.endsWith('.mkv')) {
    logger.info(`File ${eventType}: ${filename}`);
    queue.enqueue({
      path: path.join('/media', filename),
      priority: Priority.HIGH
    });
  }
});

// Still run periodic Quick Scan as safety net
scheduleJob('*/15 * * * *', async () => {
  await quickScan(); // Catches missed watch events
});
```

---

## 7. ETag Refresh (Optional, Not Mission-Critical)

**Reality Check**: TMDB's ETag behavior is not guaranteed for all endpoints.

**Strategy**: Implement as enhancement, not dependency.

```javascript
async function fetchWithETag(endpoint, params, lastEtag) {
  const headers = {};
  if (lastEtag) {
    headers['If-None-Match'] = lastEtag;
  }
  
  try {
    const response = await axios.get(endpoint, { params, headers });
    
    if (response.status === 304) {
      logger.debug('304 Not Modified - using cached data');
      return { notModified: true };
    }
    
    return {
      data: response.data,
      etag: response.headers.etag,
      notModified: false
    };
    
  } catch (error) {
    if (error.response?.status === 304) {
      return { notModified: true };
    }
    throw error;
  }
}

// Fallback: Response hash comparison
function hasDataChanged(newData, oldData) {
  const newHash = crypto.createHash('sha256')
    .update(JSON.stringify(newData))
    .digest('hex');
  
  return newHash !== oldData.last_response_hash;
}
```

---

This document continues with sections 8-21 covering scheduling, UX, benchmarks, and advanced optimizations...

