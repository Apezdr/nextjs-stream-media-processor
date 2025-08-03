# TMDB API Documentation

This document describes the TMDB (The Movie Database) API endpoints available in the Node.js backend for authenticated Next.js frontend users.

## Overview

The TMDB API integration provides access to movie, TV show, and collection information, including:
- Search functionality for movies, TV shows, and collections
- Detailed media information
- Cast and crew data
- Trailers and videos
- Images and logos
- Content ratings
- TV episode details
- **Movie collection support** for franchises and series
- **Intelligent caching system** with 60-day TTL to reduce API calls
- **Admin cache management** for performance optimization

## Authentication

All endpoints (except `/health`) require authentication using one of the following methods:

### 1. Authorization Header
```http
Authorization: Bearer <session_token>
```

### 2. Session Token Header
```http
x-session-token: <session_token>
```

### 3. Mobile Token Header
```http
x-mobile-token: <mobile_session_token>
```

## Rate Limiting

- **Limit**: 100 requests per minute per authenticated user
- **Response**: `429 Too Many Requests` when limit exceeded
- **Headers**: `retryAfter` field in response indicates seconds to wait

## Caching System

The TMDB API includes an intelligent caching system to reduce unnecessary API calls and improve performance:

- **Cache Duration**: 60 days (1440 hours) by default
- **Storage**: SQLite database for minimal overhead
- **Automatic Cleanup**: Expired entries are automatically removed
- **Cache Indicators**: Responses include `_cached`, `_cachedAt`, and `_expiresAt` fields
- **Admin Controls**: Full cache management for administrators

### Cache Response Fields

Cached responses include additional metadata:
```json
{
  "id": 27205,
  "title": "Inception",
  "_cached": true,
  "_cachedAt": "2025-01-28T02:00:00.000Z",
  "_expiresAt": "2025-03-29T02:00:00.000Z"
}
```

## Base URL

All endpoints are prefixed with `/api/tmdb`

## Endpoints

### 1. Search Media

Search for movies or TV shows.

**Endpoint**: `GET /api/tmdb/search/:type`

**Parameters**:
- `type` (path): `movie` or `tv`
- `query` (query): Search term (required)
- `page` (query): Page number (optional, default: 1)

**Example**:
```http
GET /api/tmdb/search/movie?query=inception&page=1
```

**Response**:
```json
{
  "page": 1,
  "results": [
    {
      "id": 27205,
      "title": "Inception",
      "overview": "Cobb, a skilled thief...",
      "release_date": "2010-07-16",
      "poster_path": "/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg"
    }
  ],
  "total_pages": 1,
  "total_results": 1
}
```

### 2. Get Media Details

Get detailed information for a specific movie or TV show.

**Endpoint**: `GET /api/tmdb/details/:type/:id`

**Parameters**:
- `type` (path): `movie` or `tv`
- `id` (path): TMDB ID

**Example**:
```http
GET /api/tmdb/details/movie/27205
```

**Response**:
```json
{
  "id": 27205,
  "title": "Inception",
  "overview": "Cobb, a skilled thief...",
  "runtime": 148,
  "genres": [
    {
      "id": 28,
      "name": "Action"
    }
  ],
  "last_updated": "2025-01-28T02:00:00.000Z"
}
```

### 3. Get Comprehensive Details

Get comprehensive media details including cast, trailer, logo, and rating (similar to Python script functionality).

**Endpoint**: `GET /api/tmdb/comprehensive/:type`

**Parameters**:
- `type` (path): `movie` or `tv`
- `name` (query): Media name for search (required if no tmdb_id)
- `tmdb_id` (query): TMDB ID (required if no name)

**Example**:
```http
GET /api/tmdb/comprehensive/movie?name=inception
```

**Response**:
```json
{
  "id": 27205,
  "title": "Inception",
  "overview": "Cobb, a skilled thief...",
  "cast": [
    {
      "id": 6193,
      "name": "Leonardo DiCaprio",
      "character": "Dom Cobb",
      "profile_path": "https://image.tmdb.org/t/p/original/wo2hJpn04vbtmh0B9utCFdsQhxM.jpg"
    }
  ],
  "trailer_url": "https://www.youtube.com/watch?v=YoHD9XEInc0",
  "logo_path": "https://image.tmdb.org/t/p/original/logo.png",
  "rating": "PG-13",
  "last_updated": "2025-01-28T02:00:00.000Z"
}
```

### 4. Get Cast Information

Get cast information for a movie or TV show.

**Endpoint**: `GET /api/tmdb/cast/:type/:id`

**Parameters**:
- `type` (path): `movie` or `tv`
- `id` (path): TMDB ID

**Example**:
```http
GET /api/tmdb/cast/movie/27205
```

**Response**:
```json
[
  {
    "id": 6193,
    "name": "Leonardo DiCaprio",
    "character": "Dom Cobb",
    "profile_path": "https://image.tmdb.org/t/p/original/wo2hJpn04vbtmh0B9utCFdsQhxM.jpg"
  }
]
```

### 5. Get Videos/Trailers

Get videos and trailers for a movie or TV show.

**Endpoint**: `GET /api/tmdb/videos/:type/:id`

**Parameters**:
- `type` (path): `movie` or `tv`
- `id` (path): TMDB ID

**Example**:
```http
GET /api/tmdb/videos/movie/27205
```

**Response**:
```json
{
  "trailer_url": "https://www.youtube.com/watch?v=YoHD9XEInc0",
  "videos": [
    {
      "id": "533ec654c3a36854480003eb",
      "key": "YoHD9XEInc0",
      "name": "Inception (2010) - Official Trailer",
      "site": "YouTube",
      "type": "Trailer"
    }
  ]
}
```

### 6. Get Images

Get images, logos, backdrops, and posters for a movie or TV show.

**Endpoint**: `GET /api/tmdb/images/:type/:id`

**Parameters**:
- `type` (path): `movie` or `tv`
- `id` (path): TMDB ID

**Example**:
```http
GET /api/tmdb/images/movie/27205
```

**Response**:
```json
{
  "logo_path": "https://image.tmdb.org/t/p/original/logo.png",
  "backdrops": [
    {
      "file_path": "/backdrop.jpg",
      "width": 1920,
      "height": 1080
    }
  ],
  "posters": [
    {
      "file_path": "/poster.jpg",
      "width": 500,
      "height": 750
    }
  ],
  "logos": [
    {
      "file_path": "/logo.png",
      "width": 500,
      "height": 200
    }
  ]
}
```

### 7. Get Content Rating

Get content rating for a movie or TV show.

**Endpoint**: `GET /api/tmdb/rating/:type/:id`

**Parameters**:
- `type` (path): `movie` or `tv`
- `id` (path): TMDB ID

**Example**:
```http
GET /api/tmdb/rating/movie/27205
```

**Response**:
```json
{
  "rating": "PG-13"
}
```

### 8. Get TV Episode Details

Get detailed information for a specific TV episode.

**Endpoint**: `GET /api/tmdb/episode/:showId/:season/:episode`

**Parameters**:
- `showId` (path): TMDB show ID
- `season` (path): Season number
- `episode` (path): Episode number

**Example**:
```http
GET /api/tmdb/episode/1399/1/1
```

**Response**:
```json
{
  "id": 63056,
  "name": "Winter Is Coming",
  "overview": "Eddard Stark is torn between his family...",
  "air_date": "2011-04-17",
  "episode_number": 1,
  "season_number": 1,
  "runtime": 62,
  "last_updated": "2025-01-28T02:00:00.000Z"
}
```

### 9. Get Episode Images

Get images for a specific TV episode.

**Endpoint**: `GET /api/tmdb/episode/:showId/:season/:episode/images`

**Parameters**:
- `showId` (path): TMDB show ID
- `season` (path): Season number
- `episode` (path): Episode number

**Example**:
```http
GET /api/tmdb/episode/1399/1/1/images
```

**Response**:
```json
{
  "thumbnail_url": "https://image.tmdb.org/t/p/original/episode_still.jpg",
  "stills": [
    {
      "file_path": "/episode_still.jpg",
      "width": 1920,
      "height": 1080
    }
  ]
}
```

### 10. Search Collections

Search for movie collections (franchises, series).

**Endpoint**: `GET /api/tmdb/search/collection`

**Parameters**:
- `query` (query): Search term (required)
- `page` (query): Page number (optional, default: 1)

**Example**:
```http
GET /api/tmdb/search/collection?query=marvel&page=1
```

**Response**:
```json
{
  "page": 1,
  "results": [
    {
      "id": 86311,
      "name": "The Avengers Collection",
      "overview": "A superhero film series based on the Marvel Comics superhero team of the same name.",
      "poster_path": "/yFSIUVTCvgYrpalUktulvk3Gi5Y.jpg",
      "backdrop_path": "/zuW6fOiusv4X9nnW3paHGfXcSll.jpg"
    }
  ],
  "total_pages": 1,
  "total_results": 12
}
```

### 11. Get Collection Details

Get detailed information for a specific movie collection.

**Endpoint**: `GET /api/tmdb/collection/:id`

**Parameters**:
- `id` (path): Collection ID (required)

**Example**:
```http
GET /api/tmdb/collection/86311
```

**Response**:
```json
{
  "id": 86311,
  "name": "The Avengers Collection",
  "overview": "A superhero film series based on the Marvel Comics superhero team of the same name.",
  "poster_path": "https://image.tmdb.org/t/p/original/yFSIUVTCvgYrpalUktulvk3Gi5Y.jpg",
  "backdrop_path": "https://image.tmdb.org/t/p/original/zuW6fOiusv4X9nnW3paHGfXcSll.jpg",
  "parts": [
    {
      "id": 24428,
      "title": "The Avengers",
      "overview": "When an unexpected enemy emerges...",
      "release_date": "2012-04-25",
      "poster_path": "https://image.tmdb.org/t/p/original/RYMX2wcKCBAr24UyPD7xwmjaTn.jpg",
      "backdrop_path": "https://image.tmdb.org/t/p/original/9BBTo63ANSmhC4e6r62OJFuK2GL.jpg"
    },
    {
      "id": 299536,
      "title": "Avengers: Infinity War",
      "overview": "As the Avengers and their allies...",
      "release_date": "2018-04-25",
      "poster_path": "https://image.tmdb.org/t/p/original/7WsyChQLEftFiDOVTGkv3hFpyyt.jpg",
      "backdrop_path": "https://image.tmdb.org/t/p/original/bOGkgRGdhrBYJSLpXaxhXVstddV.jpg"
    }
  ],
  "last_updated": "2025-01-28T02:00:00.000Z"
}
```

### 12. Get Collection Images

Get images (posters and backdrops) for a movie collection.

**Endpoint**: `GET /api/tmdb/collection/:id/images`

**Parameters**:
- `id` (path): Collection ID (required)

**Example**:
```http
GET /api/tmdb/collection/86311/images
```

**Response**:
```json
{
  "backdrops": [
    {
      "aspect_ratio": 1.778,
      "file_path": "https://image.tmdb.org/t/p/original/zuW6fOiusv4X9nnW3paHGfXcSll.jpg",
      "height": 2160,
      "width": 3840,
      "iso_639_1": null,
      "vote_average": 5.388,
      "vote_count": 4
    }
  ],
  "posters": [
    {
      "aspect_ratio": 0.667,
      "file_path": "https://image.tmdb.org/t/p/original/yFSIUVTCvgYrpalUktulvk3Gi5Y.jpg",
      "height": 3000,
      "width": 2000,
      "iso_639_1": "en",
      "vote_average": 5.312,
      "vote_count": 1
    }
  ]
}
```

### 13. Get TMDB Configuration (Admin Only)

Get TMDB API configuration and cache statistics.

**Endpoint**: `GET /api/tmdb/config`

**Authentication**: Requires admin privileges

**Example**:
```http
GET /api/tmdb/config
```

**Response**:
```json
{
  "tmdb_configured": true,
  "base_url": "https://api.themoviedb.org/3",
  "image_base_url": "https://image.tmdb.org/t/p/original",
  "rate_limits": {
    "requests_per_minute": 100,
    "window_ms": 60000
  },
  "cache": {
    "enabled": true,
    "default_ttl_hours": 1440,
    "stats": {
      "total": 150,
      "expired": 5,
      "active": 145,
      "byEndpoint": [
        {
          "endpoint": "/search/movie",
          "count": 45,
          "oldest": "2025-01-15T10:30:00.000Z",
          "most_recent": "2025-01-28T01:45:00.000Z"
        }
      ]
    }
  }
}
```

### 14. Get Cache Statistics (Admin Only)

Get detailed cache statistics.

**Endpoint**: `GET /api/tmdb/cache/stats`

**Authentication**: Requires admin privileges

**Example**:
```http
GET /api/tmdb/cache/stats
```

**Response**:
```json
{
  "total": 150,
  "expired": 5,
  "active": 145,
  "byEndpoint": [
    {
      "endpoint": "/search/movie",
      "count": 45,
      "oldest": "2025-01-15T10:30:00.000Z",
      "most_recent": "2025-01-28T01:45:00.000Z"
    },
    {
      "endpoint": "/movie/27205",
      "count": 1,
      "oldest": "2025-01-20T14:20:00.000Z",
      "most_recent": "2025-01-20T14:20:00.000Z"
    }
  ]
}
```

### 15. Clear Cache (Admin Only)

Clear all or specific cache entries.

**Endpoint**: `DELETE /api/tmdb/cache`

**Authentication**: Requires admin privileges

**Parameters**:
- `pattern` (query, optional): SQL LIKE pattern to match endpoints (e.g., `/search/%`)

**Examples**:
```http
# Clear all cache
DELETE /api/tmdb/cache

# Clear only search cache
DELETE /api/tmdb/cache?pattern=/search/%
```

**Response**:
```json
{
  "success": true,
  "deletedCount": 45,
  "message": "Cleared 45 cache entries matching pattern: /search/%"
}
```

### 16. Clear Expired Cache (Admin Only)

Clear only expired cache entries.

**Endpoint**: `DELETE /api/tmdb/cache/expired`

**Authentication**: Requires admin privileges

**Example**:
```http
DELETE /api/tmdb/cache/expired
```

**Response**:
```json
{
  "success": true,
  "deletedCount": 5,
  "message": "Cleared 5 expired cache entries"
}
```

### 17. Force Refresh Cache Entry (Admin Only)

Force refresh a specific cache entry.

**Endpoint**: `POST /api/tmdb/cache/refresh`

**Authentication**: Requires admin privileges

**Body**:
```json
{
  "endpoint": "/movie/27205",
  "params": {
    "language": "en-US"
  }
}
```

**Response**:
```json
{
  "success": true,
  "refreshed": true,
  "message": "Cache entry refreshed successfully"
}
```

### 18. Health Check

Check the health and status of the TMDB API service.

**Endpoint**: `GET /api/tmdb/health`

**Authentication**: None required

**Example**:
```http
GET /api/tmdb/health
```

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2025-01-28T02:00:00.000Z",
  "tmdb_configured": true,
  "service": "tmdb-api",
  "cache_enabled": true
}
```

## Error Responses

### Authentication Errors

**401 Unauthorized**:
```json
{
  "error": "No authentication provided"
}
```

**403 Forbidden**:
```json
{
  "error": "User not approved for access"
}
```

### Rate Limiting

**429 Too Many Requests**:
```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 60
}
```

### Validation Errors

**400 Bad Request**:
```json
{
  "error": "Type must be \"movie\" or \"tv\""
}
```

### Server Errors

**500 Internal Server Error**:
```json
{
  "error": "TMDB API request failed"
}
```

## Frontend Integration Examples

### JavaScript/TypeScript

```javascript
// Search for movies
const searchMovies = async (query) => {
  const response = await fetch('/api/tmdb/search/movie?query=' + encodeURIComponent(query), {
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      // or 'x-session-token': sessionToken,
      // or 'x-mobile-token': mobileToken
    }
  });
  
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  
  return response.json();
};

// Get movie details
const getMovieDetails = async (movieId) => {
  const response = await fetch(`/api/tmdb/details/movie/${movieId}`, {
    headers: {
      'Authorization': `Bearer ${sessionToken}`
    }
  });
  
  return response.json();
};

// Get comprehensive details
const getComprehensiveDetails = async (name, type = 'movie') => {
  const response = await fetch(`/api/tmdb/comprehensive/${type}?name=${encodeURIComponent(name)}`, {
    headers: {
      'Authorization': `Bearer ${sessionToken}`
    }
  });
  
  return response.json();
};

// Search collections
const searchCollections = async (query) => {
  const response = await fetch('/api/tmdb/search/collection?query=' + encodeURIComponent(query), {
    headers: {
      'Authorization': `Bearer ${sessionToken}`
    }
  });
  
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  
  return response.json();
};

// Get collection details
const getCollectionDetails = async (collectionId) => {
  const response = await fetch(`/api/tmdb/collection/${collectionId}`, {
    headers: {
      'Authorization': `Bearer ${sessionToken}`
    }
  });
  
  return response.json();
};

// Get collection images
const getCollectionImages = async (collectionId) => {
  const response = await fetch(`/api/tmdb/collection/${collectionId}/images`, {
    headers: {
      'Authorization': `Bearer ${sessionToken}`
    }
  });
  
  return response.json();
};
```

### React Hook Example

```javascript
import { useState, useEffect } from 'react';

const useTMDBSearch = (query, type = 'movie') => {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!query) return;

    const searchMedia = async () => {
      setLoading(true);
      setError(null);
      
      try {
        const response = await fetch(`/api/tmdb/search/${type}?query=${encodeURIComponent(query)}`, {
          headers: {
            'Authorization': `Bearer ${sessionToken}`
          }
        });
        
        if (!response.ok) {
          throw new Error(`Search failed: ${response.status}`);
        }
        
        const data = await response.json();
        setResults(data.results || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    const debounceTimer = setTimeout(searchMedia, 300);
    return () => clearTimeout(debounceTimer);
  }, [query, type]);

  return { results, loading, error };
};
```

## Cache Management

### Automatic Cache Management

- **TTL**: 60 days default (configurable per request)
- **Cleanup**: 10% chance of automatic cleanup on each request
- **Storage**: SQLite database in `node/db/media.db`
- **Indexing**: Optimized indexes for fast lookups and TTL cleanup

### Manual Cache Management (Admin)

Administrators can manage the cache through dedicated endpoints:

1. **View Statistics**: Monitor cache usage and performance
2. **Clear All Cache**: Remove all cached entries
3. **Clear by Pattern**: Remove specific endpoint caches
4. **Clear Expired**: Remove only expired entries
5. **Force Refresh**: Invalidate and refresh specific entries

### Cache Performance Benefits

- **Reduced API Calls**: Significant reduction in TMDB API usage
- **Faster Response Times**: Cached responses are served instantly
- **Rate Limit Protection**: Avoids hitting TMDB rate limits
- **Cost Savings**: Reduces external API costs
- **Offline Resilience**: Cached data available during API outages

## Architecture

### File Structure

```
node/
├── middleware/
│   └── auth.mjs              # Authentication middleware
├── utils/
│   └── tmdb.mjs             # TMDB API utility functions with caching
├── routes/
│   ├── index.mjs            # Route configuration
│   └── tmdb.mjs             # TMDB route handlers with cache management
├── database.mjs             # MongoDB functions including auth
└── sqliteDatabase.mjs       # SQLite functions including TMDB cache
```

### Key Features

1. **Modular Design**: Authentication, utilities, and routes are separated for maintainability
2. **Dual Database**: MongoDB for user auth, SQLite for TMDB caching
3. **Intelligent Caching**: 60-day TTL with automatic cleanup and admin controls
4. **Error Handling**: Comprehensive error handling with retry logic
5. **Rate Limiting**: Per-user rate limiting to prevent abuse
6. **Logging**: Detailed logging for monitoring and debugging
7. **Security**: User approval checking and admin privilege validation
8. **Performance**: Optimized caching reduces external API calls by 90%+

### Dependencies

- `express`: Web framework
- `axios`: HTTP client for TMDB API requests
- `mongodb`: Database driver for user authentication
- `sqlite3`: Database driver for TMDB caching
- `sqlite`: Promise-based SQLite wrapper
- Custom logging system

## Environment Variables

Ensure these environment variables are set:

```env
TMDB_API_KEY=your_tmdb_api_key_here
MONGODB_URI=mongodb://user:password@localhost:27017/database
```

## Notes

- All endpoints mirror the functionality of the existing Python TMDB script
- **Caching reduces TMDB API calls by 90%+** for repeated requests
- Image URLs are returned as full URLs with `https://image.tmdb.org/t/p/original` prefix
- Timestamps are in ISO 8601 format
- The API handles TMDB rate limiting with exponential backoff
- User authentication is validated against the Next.js frontend database
- Cache responses include metadata fields (`_cached`, `_cachedAt`, `_expiresAt`)
- Automatic cache cleanup prevents database bloat
- Admin users have full cache management capabilities