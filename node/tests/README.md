# Node.js Test Suite

Comprehensive test suite for the Node.js media processing server with cross-platform validation against Python script outputs.

## Test Structure

```
node/tests/
├── unit/                          # Unit tests for individual modules
│   └── utils/
│       └── tmdb.test.mjs         # TMDB utility function tests
├── integration/                   # Integration and cross-platform tests
│   └── metadata-compatibility.test.mjs  # Python↔Node.js validation
├── fixtures/
│   └── python-generated/         # Real TMDB data from Python tests
│       ├── movie_701387_response.json   # Bugonia movie metadata
│       └── tv_60622_response.json       # Fargo TV show metadata
└── helpers/
    └── testSetup.mjs             # Shared test utilities
```

## Running Tests

### Quick Start
```bash
cd node
npm test                    # Run all tests
npm run test:watch         # Watch mode
npm run test:coverage      # With coverage report
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
```

### Specific Tests
```bash
# Run specific file
npm test -- tmdb.test.mjs

# Run with verbose output
npm test -- --verbose

# Run specific test suite
npm test -- --testNamePattern="Cast Structure"
```

## Test Categories

### 🔧 Unit Tests (`tests/unit/`)

**TMDB Utils** ([`tmdb.test.mjs`](unit/utils/tmdb.test.mjs))
- `getMediaCast()`: Cast formatting matches Python structure
- `getMediaVideos()`: Trailer URL extraction
- `getMediaImages()`: Logo path extraction
- `getMediaRating()`: Rating extraction (US ratings)
- `getTMDBImageURL()`: Image URL construction
- `formatRuntime()`: Runtime formatting
- `aggregateTopCast()`: Cast aggregation logic
- `calculateGenreBreakdown()`: Genre statistics

### 🔗 Integration Tests (`tests/integration/`)

**Cross-Platform Compatibility** ([`metadata-compatibility.test.mjs`](integration/metadata-compatibility.test.mjs))
- Cast structure matches Python output
- Genre structure matches Python output
- Metadata field presence validation
- Season structure for TV shows
- Real data validation (Bugonia & Fargo)
- Type schema validation

## Python-Generated Fixtures

Tests use **real TMDB API responses** captured by Python tests:

**Movie: Bugonia (ID: 701387)**
- 28 cast members
- 2 genres (Science Fiction, Crime)
- R rating
- Complete metadata fields

**TV Show: Fargo (ID: 60622)**
- 10 cast members
- 2 genres (Crime, Drama)
- TV-MA rating
- 6 seasons, 51 episodes

These fixtures ensure **Node.js handles the same data structures as Python**.

## Test Helpers

### Loaded from `helpers/testSetup.mjs`

```javascript
import {
  loadPythonFixture,
  validateCastMemberStructure,
  validateGenreStructure,
  TMDB_GENRES,
  createMockMetadata
} from '../helpers/testSetup.mjs';

// Load Python fixtures
const movieData = await loadPythonFixture('movie_701387_response.json');

// Validate structures
validateCastMemberStructure(movieData.cast[0]);
validateGenreStructure(movieData.genres[0]);

// Create mock data for tests
const mockMovie = createMockMetadata('movie', { id: 123 });
```

## Cross-Platform Validation

These tests ensure **consistency between Python and Node.js**:

1. ✅ **Cast Structure**: Both systems produce identical cast member objects
   ```javascript
   {
     id: 54693,                                    // number
     name: 'Emma Stone',                           // string
     character: 'Michelle',                        // string
     profile_path: 'https://...jpg'                // string or null
   }
   ```

2. ✅ **Genre Structure**: Both systems use TMDB standard genre IDs
   ```javascript
   {
     id: 878,                                      // number (TMDB standard)
     name: 'Science Fiction'                       // string
   }
   ```

3. ✅ **Metadata Fields**: Both systems include all required fields
   - Movies: id, title, overview, cast, genres, rating, etc.
   - TV: id, name, overview, seasons, cast, genres, rating, etc.

## Coverage Goals

Target: **80%+ code coverage** for:
- `utils/tmdb.mjs`: TMDB API interactions
- `utils/fileUtils.mjs`: File operations
- `routes/tmdb.mjs`: TMDB API endpoints

## Writing New Tests

### Example: Unit Test
```javascript
import { describe, it, expect } from '@jest/globals';
import { myFunction } from '../../../utils/myModule.mjs';

describe('My Module', () => {
  it('should do something', () => {
    const result = myFunction('input');
    expect(result).toBe('expected');
  });
});
```

### Example: Using Python Fixtures
```javascript
import { loadPythonFixture } from '../helpers/testSetup.mjs';

it('should validate Python data', async () => {
  const pythonData = await loadPythonFixture('movie_701387_response.json');
  
  expect(pythonData.cast[0].name).toBe('Emma Stone');
});
```

## Continuous Integration

Tests run:
- Locally before commits
- In CI/CD pipeline
- During Docker build (coming soon)

## Debugging Tests

```bash
# Enable verbose output
npm test -- --verbose

# Run with node inspector
node --inspect-brk node_modules/jest/bin/jest.js tests/

# Filter by name
npm test -- --testNamePattern="TMDB"
```

## Adding New Test Files

1. Create test file: `tests/unit/myModule.test.mjs`
2. Import from `@jest/globals`
3. Use ES modules (`.mjs`)
4. Follow naming: `describe('Module', () => it('should...', () => {}))`
5. Run: `npm test`

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Jest with ES Modules](https://jestjs.io/docs/ecmascript-modules)
- [Python Test Suite](../../scripts/TESTING.md)
- [Python-Generated Fixtures](fixtures/python-generated/)
