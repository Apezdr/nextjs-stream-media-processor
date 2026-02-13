# Media Scanner Component

This component implements the media library scanning functionality following Node.js best practices and a clean 3-tier architecture.

## Architecture

The component is organized following the **3-tier layered architecture** pattern:

```
components/media-scanner/
├── entry-points/       # HTTP controllers and external interfaces
├── domain/             # Business logic (pure functions)
└── data-access/        # Database operations
```

### Layer Responsibilities

#### 1. Entry Points Layer (`entry-points/`)
- **Purpose**: Handle external requests and coordinate operations
- **Files**: `scanner-controller.mjs`
- **Responsibilities**:
  - Receive scanning requests
  - Coordinate scanning operations
  - Handle errors and return responses
  - Manage database connections

#### 2. Domain Layer (`domain/`)
- **Purpose**: Contains all business logic for scanning media files
- **Files**: 
  - `movie-scanner.mjs` - Movie scanning logic
  - `tv-scanner.mjs` - TV show scanning logic
- **Responsibilities**:
  - Process media files
  - Generate metadata
  - Validate file structures
  - Apply business rules
  - **NO** direct database calls (uses data-access layer)
  - **NO** HTTP-specific code (independent of web framework)

#### 3. Data Access Layer (`data-access/`)
- **Purpose**: Handle all database operations
- **Files**: `scanner-repository.mjs`
- **Responsibilities**:
  - Database queries and mutations
  - Data persistence
  - Database connection management
  - Encapsulate database implementation details

## Benefits of This Architecture

### 1. Separation of Concerns
- Each layer has a single, well-defined responsibility
- Changes to one layer don't affect others
- Easier to understand and maintain

### 2. Testability
- Domain logic can be tested without a database
- Data access can be mocked for unit tests
- Entry points can be tested independently

### 3. Reusability
- Domain logic can be called from different entry points (HTTP, CLI, scheduled jobs)
- Data access layer can be reused across components
- Business logic is framework-agnostic

### 4. Maintainability
- Clear structure makes it easy to find code
- Easier to onboard new developers
- Follows industry best practices

## Usage

### Scanning Movies
```javascript
import { scanMoviesLibrary } from './components/media-scanner/index.mjs';

await scanMoviesLibrary(
  moviesPath,
  prefixPath,
  basePath,
  langMap,
  currentVersion,
  isDebugMode,
  downloadTMDBImages
);
```

### Scanning TV Shows
```javascript
import { scanTVShowsLibrary } from './components/media-scanner/index.mjs';

await scanTVShowsLibrary(
  tvPath,
  prefixPath,
  basePath,
  langMap,
  isDebugMode,
  downloadTMDBImages
);
```

### Scanning Entire Library
```javascript
import { scanMediaLibrary } from './components/media-scanner/index.mjs';

await scanMediaLibrary(
  moviesPath,
  tvPath,
  prefixPath,
  basePath,
  langMap,
  currentVersion,
  isDebugMode,
  downloadTMDBImages
);
```

## Backward Compatibility

The original `generateListMovies()` and `generateListTV()` functions in `app.mjs` have been converted to thin wrappers that call the new component. This ensures existing code continues to work without modification.

## Best Practices Applied

Based on the [Node.js Best Practices Guide](../../../cline_docs/node/overview.md):

✅ **1.1 Structure by Components** - Media scanner is a self-contained component with clear boundaries

✅ **1.2 Layer Components with 3 Tiers** - Entry-points, domain, and data-access layers are clearly separated

✅ **2.2 Extend Built-in Error Object** - Errors are properly thrown and caught with meaningful messages

✅ **2.3 Distinguish Operational vs Programmer Errors** - Business logic errors are handled separately from system errors

✅ **3.11 Use Async/Await** - All asynchronous operations use async/await pattern

✅ **3.13 Avoid Effects Outside of Functions** - All logic is encapsulated in functions, no global side effects

## Future Improvements

Potential enhancements that maintain this architecture:

1. **Add validation layer** - Validate inputs at entry-point level
2. **Implement caching** - Add caching in data-access layer
3. **Add events** - Emit events from domain layer for progress tracking
4. **Create DTOs** - Define data transfer objects for layer boundaries
5. **Add integration tests** - Test full flow through all layers

## Migration Notes

The legacy implementations have been removed from `app.mjs` and consolidated into this component. The old code is preserved in git history if needed for reference.

## Related Documentation

- [Node.js Best Practices](../../../cline_docs/node/overview.md)
- [Project Architecture](../../../cline_docs/node/project-architecture-practices.md)
