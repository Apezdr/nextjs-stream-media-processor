# TMDB Blurhash Enhancement

## Overview

The TMDB Blurhash Enhancement feature automatically generates compact, blurry placeholder representations of movie/TV show images (posters, backdrops, logos) that can be displayed while the full images are loading. This improves user experience by providing immediate visual feedback and reducing perceived loading times.

## What is Blurhash?

Blurhash is a compact representation of a placeholder for an image, taking only 20-30 characters to encode a blurry representation of an image. It's ideal for:

- **Progressive loading**: Show a meaningful placeholder while images load
- **Reduced data usage**: Tiny string representation instead of image files
- **Improved UX**: Immediate visual feedback with color and composition hints

## API Usage

### Enable Blurhash in API Responses

Add the `?blurhash=true` query parameter to any TMDB endpoint to include blurhash data. All endpoints now use standardized query parameters:

```bash
# Search with blurhash
GET /api/tmdb/search/movie?query=inception&blurhash=true

# Get details with blurhash
GET /api/tmdb/details/movie?tmdb_id=27205&blurhash=true

# Get comprehensive details with blurhash
GET /api/tmdb/comprehensive/movie?tmdb_id=27205&blurhash=true

# Get images with blurhash
GET /api/tmdb/images/movie?tmdb_id=27205&blurhash=true

# Get cast information
GET /api/tmdb/cast/movie?tmdb_id=27205

# Get videos/trailers
GET /api/tmdb/videos/movie?tmdb_id=27205

# Get content ratings
GET /api/tmdb/rating/movie?tmdb_id=27205

# Get episode details
GET /api/tmdb/episode?tmdb_id=1399&season=1&episode=1

# Get episode images with blurhash
GET /api/tmdb/episode/images?tmdb_id=1399&season=1&episode=1&blurhash=true

# Search collections with blurhash
GET /api/tmdb/search/collection?query=marvel&blurhash=true

# Get collection details with blurhash
GET /api/tmdb/collection?tmdb_id=86311&blurhash=true

# Get enhanced collection details with blurhash
GET /api/tmdb/collection?tmdb_id=86311&enhanced=true&blurhash=true

# Get collection images with blurhash
GET /api/tmdb/collection/images?tmdb_id=86311&blurhash=true
```

### Response Format

When `blurhash=true` is specified, image objects in the response will include a `blurhash` field:

```json
{
  "poster_path": "/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg",
  "blurhash": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABkAAAAeCAYAAADZ...",
  "aspect_ratio": 0.667,
  "height": 3000,
  "width": 2000
}
```

## Supported Endpoints

All endpoints now use standardized query parameters. The following endpoints support the `?blurhash=true` parameter:

### Media Endpoints
- **Search**: `/search/:type` (movie/tv) - requires `query` parameter
- **Details**: `/details/:type` (movie/tv) - requires `tmdb_id` parameter
- **Comprehensive**: `/comprehensive/:type` (movie/tv) - requires `tmdb_id` or `name` parameter
- **Images**: `/images/:type` (movie/tv) - requires `tmdb_id` parameter
- **Cast**: `/cast/:type` (movie/tv) - requires `tmdb_id` parameter
- **Videos**: `/videos/:type` (movie/tv) - requires `tmdb_id` parameter
- **Rating**: `/rating/:type` (movie/tv) - requires `tmdb_id` parameter

### Episode Endpoints
- **Episode Details**: `/episode` - requires `tmdb_id`, `season`, `episode` parameters
- **Episode Images**: `/episode/images` - requires `tmdb_id`, `season`, `episode` parameters

### Collection Endpoints
- **Search Collections**: `/search/collection` - requires `query` parameter
- **Collection Details**: `/collection` - requires `tmdb_id` parameter, optional `enhanced=true`
- **Collection Images**: `/collection/images` - requires `tmdb_id` parameter

## Database Schema

### TMDB Blurhash Cache Table

```sql
CREATE TABLE IF NOT EXISTS tmdb_blurhash_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_url TEXT UNIQUE NOT NULL,
    blurhash_base64 TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    INDEX idx_image_url (image_url),
    INDEX idx_expires_at (expires_at)
);
```

### Cache Keys

Responses with blurhash data use separate cache keys to avoid conflicts:

- **Regular**: `${endpoint}_${JSON.stringify(params)}`
- **Blurhash**: `${endpoint}_${JSON.stringify(params)}_blurhash`

## Implementation Details

### File Structure

```
node/
├── utils/
│   ├── tmdb.mjs                    # Enhanced TMDB utilities
│   └── tmdbBlurhash.mjs           # Blurhash generation logic
├── sqlite/
│   └── tmdbBlurhashCache.mjs      # Blurhash database operations
└── routes/
    └── tmdb.mjs                   # Enhanced API routes

scripts/utils/
└── blurhash_cli.py                # Python blurhash generation
```

### Core Functions

#### `generateTmdbImageBlurhash(imageUrl)`
Downloads TMDB images and generates blurhash with caching:

```javascript
const blurhash = await generateTmdbImageBlurhash(
  'https://image.tmdb.org/t/p/original/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg'
);
```

#### `enhanceTmdbResponseWithBlurhash(data)`
Adds blurhash data to TMDB API responses:

```javascript
const enhanced = await enhanceTmdbResponseWithBlurhash(tmdbResponse);
```

## Configuration

### Blurhash Generation Settings

Current optimal settings in [`blurhash_cli.py`](../scripts/utils/blurhash_cli.py):

```python
# Component count for detail level
x_components = 8  # Horizontal detail
y_components = 6  # Vertical detail

# Output image size for preview
max_height = 150  # Pixels
```

### Cache Settings

```javascript
// Cache TTL (Time To Live)
const BLURHASH_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// Cleanup interval
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // Daily
```

## Performance Considerations

### Caching Strategy

1. **Blurhash Cache**: Generated blurhashes are cached for 7 days
2. **Response Cache**: Separate cache keys for blurhash-enhanced responses
3. **Background Generation**: Blurhashes generated asynchronously when possible

### Resource Usage

- **CPU**: Python subprocess for blurhash generation (~100-500ms per image)
- **Memory**: Temporary image files cleaned up automatically
- **Storage**: ~30-50 bytes per blurhash string in database
- **Network**: One-time download of original TMDB images

### Optimization Tips

1. **Batch Requests**: Request blurhashes only when needed
2. **Progressive Loading**: Display blurhash immediately, then replace with full image
3. **Selective Enhancement**: Only apply to user-visible images
4. **Monitor Cache Hit Rate**: High hit rates reduce processing overhead

## Error Handling

### Graceful Degradation

If blurhash generation fails:

1. **Log Warning**: Error logged but request continues
2. **Omit Field**: `blurhash` field excluded from response
3. **Cache Miss**: Failed attempts not cached to allow retries
4. **Fallback**: Original TMDB response returned unchanged

### Common Issues

```javascript
// Network timeout downloading image
Error: Request timeout downloading image for blurhash

// Python script failure  
Error: Failed to generate blurhash: Python script error

// Invalid image format
Error: Unsupported image format for blurhash generation
```

## Usage Examples

### Frontend Implementation

```javascript
// React component example
function MoviePoster({ movie }) {
  const [imageLoaded, setImageLoaded] = useState(false);
  
  return (
    <div className="poster-container">
      {/* Show blurhash while loading */}
      {movie.poster_blurhash && !imageLoaded && (
        <img 
          src={movie.poster_blurhash}
          className="poster-placeholder"
          alt="Loading poster..."
        />
      )}
      
      {/* Full image */}
      <img
        src={`https://image.tmdb.org/t/p/w500${movie.poster_path}`}
        onLoad={() => setImageLoaded(true)}
        style={{ opacity: imageLoaded ? 1 : 0 }}
        alt={movie.title}
      />
    </div>
  );
}
```

### CSS for Smooth Transitions

```css
.poster-container {
  position: relative;
  overflow: hidden;
}

.poster-placeholder {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(0.5px); /* Optional: extra blur effect */
}

.poster-container img {
  transition: opacity 0.3s ease-in-out;
}
```

## Monitoring and Maintenance

### Cache Statistics

Access cache statistics via admin endpoints:

```bash
GET /api/tmdb/cache/stats
```

### Cache Cleanup

```bash
# Clear expired entries
DELETE /api/tmdb/cache/expired

# Clear all blurhash cache
DELETE /api/tmdb/cache?pattern=*_blurhash
```

### Performance Monitoring

Key metrics to monitor:

- **Cache Hit Rate**: Should be >80% for good performance
- **Generation Time**: Average blurhash generation time
- **Error Rate**: Failed blurhash generations
- **Database Size**: Growth rate of blurhash cache

## Migration Guide

### Existing Applications

To add blurhash support to existing applications:

1. **Update API Calls**: Add `?blurhash=true` parameter
2. **Handle New Field**: Check for `blurhash` field in responses
3. **Update UI**: Implement progressive loading with blurhash placeholders
4. **Test Gracefully**: Ensure app works when blurhash is unavailable

### Database Migration

The blurhash cache table is created automatically on first use. No manual migration required.

## Troubleshooting

### Common Issues

1. **No Blurhash Generated**
   - Check Python dependencies: `pip install blurhash Pillow`
   - Verify image URL accessibility
   - Check logs for generation errors

2. **Poor Quality Blurhashes**
   - Current settings optimized for movie posters
   - Different image types may need parameter adjustments

3. **High Memory Usage**
   - Temporary files cleaned automatically
   - Monitor disk space in temp directory

4. **Slow Performance**
   - Check cache hit rates
   - Consider reducing component count for faster generation
   - Implement background processing for non-critical paths

---

## Technical Specifications

- **Blurhash Version**: Compatible with Blurhash 1.1.0+ specification
- **Image Formats**: JPEG, PNG, WebP (auto-detected)
- **Component Range**: 1-9 for both X and Y components
- **Output Format**: Base64-encoded PNG data URI
- **Cache Duration**: 7 days (configurable)
- **Python Requirements**: `blurhash`, `Pillow`, `asyncio`