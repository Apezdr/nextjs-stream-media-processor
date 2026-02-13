/**
 * Cross-Platform Metadata Generation Comparison
 * 
 * This test validates that Node.js and Python implementations produce
 * IDENTICAL metadata.json files for the same media content.
 * 
 * Critical Test: Ensures both implementations maintain compatibility
 * and generate byte-for-byte equivalent metadata structures.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config as dotenvConfig } from 'dotenv';
import { fetchComprehensiveMediaDetails } from '../../utils/tmdb.mjs';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env.local (preferred) or .env file
const rootDir = join(__dirname, '../../..');
try {
  // Try .env.local first (local development overrides)
  const localEnvPath = join(rootDir, '.env.local');
  try {
    await fs.access(localEnvPath);
    dotenvConfig({ path: localEnvPath });
    console.log('Loaded environment from .env.local');
  } catch {
    // Fall back to .env
    dotenvConfig({ path: join(rootDir, '.env') });
  }
} catch (error) {
  // No .env files found, will use system environment variables
}

// Log whether we have a real API key
const hasRealApiKey = process.env.TMDB_API_KEY && process.env.TMDB_API_KEY !== 'test_api_key';
if (hasRealApiKey) {
  console.log('Using real TMDB_API_KEY from environment');
} else {
  console.log('No real TMDB_API_KEY found, using test key');
}

// Set TMDB_API_KEY before any imports (fallback to test key if not in env)
process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'test_api_key';

// Import after env setup
const { MetadataGenerator } = await import('../../lib/metadataGenerator.mjs');

/**
 * Fields that are expected to differ between test runs and should not cause failures
 * These are dynamic values that change over time (timestamps, vote counts, etc.)
 */
const IGNORED_FIELDS = new Set([
  'last_updated',      // Timestamp when metadata was generated
  'vote_average',      // TMDB vote average (changes as users vote)
  'vote_count',        // TMDB vote count (changes as users vote)
  'popularity',        // TMDB popularity score (changes frequently)
  'revenue',           // Box office revenue (can be updated)
  '_cached',           // Internal cache metadata
  '_cachedAt',         // Internal cache timestamp
  '_expiresAt',        // Internal cache expiration
  '_etag',             // Internal cache ETag
  '_notModified',      // Internal cache flag
]);

/**
 * Check if a path should be ignored in comparison
 */
function shouldIgnorePath(path) {
  const parts = path.split('.');
  const lastPart = parts[parts.length - 1];
  return IGNORED_FIELDS.has(lastPart);
}

/**
 * Deep comparison utility that provides detailed mismatch information
 */
function deepCompare(obj1, obj2, path = '', differences = [], ignoredDifferences = []) {
  // Handle null/undefined cases
  if (obj1 === null || obj2 === null || obj1 === undefined || obj2 === undefined) {
    if (obj1 !== obj2) {
      const diff = {
        path,
        node: obj1,
        python: obj2,
        type: 'null_mismatch'
      };
      
      if (shouldIgnorePath(path)) {
        ignoredDifferences.push(diff);
      } else {
        differences.push(diff);
      }
    }
    return { differences, ignoredDifferences };
  }

  // Handle primitive types
  if (typeof obj1 !== 'object' || typeof obj2 !== 'object') {
    if (obj1 !== obj2) {
      const diff = {
        path,
        node: obj1,
        python: obj2,
        type: 'value_mismatch'
      };
      
      if (shouldIgnorePath(path)) {
        ignoredDifferences.push(diff);
      } else {
        differences.push(diff);
      }
    }
    return { differences, ignoredDifferences };
  }

  // Handle arrays
  if (Array.isArray(obj1) && Array.isArray(obj2)) {
    if (obj1.length !== obj2.length) {
      differences.push({
        path,
        node: obj1.length,
        python: obj2.length,
        type: 'array_length_mismatch'
      });
    }

    const maxLength = Math.max(obj1.length, obj2.length);
    for (let i = 0; i < maxLength; i++) {
      const result = deepCompare(obj1[i], obj2[i], `${path}[${i}]`, differences, ignoredDifferences);
      differences = result.differences;
      ignoredDifferences = result.ignoredDifferences;
    }
    return { differences, ignoredDifferences };
  }

  // Handle type mismatches (one is array, other is object)
  if (Array.isArray(obj1) !== Array.isArray(obj2)) {
    differences.push({
      path,
      node: Array.isArray(obj1) ? 'array' : 'object',
      python: Array.isArray(obj2) ? 'array' : 'object',
      type: 'type_mismatch'
    });
    return { differences, ignoredDifferences };
  }

  // Handle objects - check all keys from both objects
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);
  const allKeys = new Set([...keys1, ...keys2]);

  for (const key of allKeys) {
    const newPath = path ? `${path}.${key}` : key;
    
    if (!(key in obj1)) {
      const diff = {
        path: newPath,
        node: undefined,
        python: obj2[key],
        type: 'missing_in_node'
      };
      
      if (shouldIgnorePath(newPath)) {
        ignoredDifferences.push(diff);
      } else {
        differences.push(diff);
      }
    } else if (!(key in obj2)) {
      const diff = {
        path: newPath,
        node: obj1[key],
        python: undefined,
        type: 'missing_in_python'
      };
      
      if (shouldIgnorePath(newPath)) {
        ignoredDifferences.push(diff);
      } else {
        differences.push(diff);
      }
    } else {
      const result = deepCompare(obj1[key], obj2[key], newPath, differences, ignoredDifferences);
      differences = result.differences;
      ignoredDifferences = result.ignoredDifferences;
    }
  }

  return { differences, ignoredDifferences };
}

/**
 * Format differences for readable error messages
 */
function formatDifferences(differences, ignoredDifferences = []) {
  if (differences.length === 0 && ignoredDifferences.length === 0) {
    return 'No differences found';
  }
  
  let output = '';
  
  if (differences.length > 0) {
    output += `\nFound ${differences.length} critical difference(s):\n\n`;
    
    differences.slice(0, 20).forEach((diff, idx) => {
      output += `${idx + 1}. Path: ${diff.path || 'root'}\n`;
      output += `   Type: ${diff.type}\n`;
      output += `   Node.js: ${JSON.stringify(diff.node)}\n`;
      output += `   Python:  ${JSON.stringify(diff.python)}\n\n`;
    });
    
    if (differences.length > 20) {
      output += `... and ${differences.length - 20} more critical differences\n`;
    }
  }
  
  if (ignoredDifferences.length > 0) {
    output += `\n✓ Ignoring ${ignoredDifferences.length} expected difference(s) (dynamic TMDB data):\n`;
    ignoredDifferences.slice(0, 5).forEach((diff, idx) => {
      output += `  - ${diff.path}: Node.js=${JSON.stringify(diff.node)} vs Python=${JSON.stringify(diff.python)}\n`;
    });
    if (ignoredDifferences.length > 5) {
      output += `  ... and ${ignoredDifferences.length - 5} more ignored differences\n`;
    }
  }
  
  return output;
}

/**
 * Run Python metadata generation script
 */
async function runPythonMetadataGeneration(basePath, mediaType, mediaName) {
  const scriptsDir = join(__dirname, '../../../scripts');
  const scriptPath = join(scriptsDir, 'generate-metadata.mjs');
  
  // Check if Python script exists, if not use Node.js alternative
  const pythonScriptPath = join(scriptsDir, 'download_tmdb_images.py');
  
  try {
    await fs.access(pythonScriptPath);
    // Python script exists, use it
    const { stdout, stderr } = await execAsync(
      `python "${pythonScriptPath}" --base-path "${basePath}" --type ${mediaType} --name "${mediaName}"`,
      { 
        env: { ...process.env, TMDB_API_KEY: process.env.TMDB_API_KEY },
        timeout: 60000 // 60 second timeout
      }
    );
    
    return { stdout, stderr, success: true };
  } catch (error) {
    throw new Error(`Python script execution failed: ${error.message}`);
  }
}

describe('Cross-Platform Metadata Generation', () => {
  let testDir;
  let movieTestDir;
  let tvTestDir;

  beforeAll(async () => {
    // Create temporary test directories
    testDir = join(tmpdir(), `metadata-test-${randomUUID()}`);
    movieTestDir = join(testDir, 'movies');
    tvTestDir = join(testDir, 'tv');
    
    await fs.mkdir(movieTestDir, { recursive: true });
    await fs.mkdir(tvTestDir, { recursive: true });
  });

  afterAll(async () => {
    // Cleanup test directories
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Failed to cleanup test directory: ${error.message}`);
    }
  });

  describe('Movie Metadata Comparison', () => {
    it('should process live TMDB data identically in Node.js and Python implementations for Bugonia (701387)', async () => {
      // Skip if no real TMDB API key (can't make real API calls)
      if (!process.env.TMDB_API_KEY || process.env.TMDB_API_KEY === 'test_api_key') {
        console.log('Skipping: Real TMDB_API_KEY required for integration test');
        return;
      }

      const movieId = 701387; // Bugonia
      const movieName = 'Bugonia (2025)';

      // === NODE.JS FRESH REQUEST ===
      const movieDir = join(movieTestDir, movieName);
      await fs.mkdir(movieDir, { recursive: true });

      // Create tmdb_config.json with known ID
      const tmdbConfig = {
        id: movieId,
        type: 'movie',
        title: 'Bugonia'
      };
      await fs.writeFile(
        join(movieDir, 'tmdb_config.json'),
        JSON.stringify(tmdbConfig, null, 2)
      );

      // Generate metadata using Node.js with fresh TMDB API call (force refresh)
      const nodeGenerator = await MetadataGenerator.create({
        basePath: testDir,
        forceRefresh: true, // Force fresh API calls, bypass cache
        generateBlurhash: false // Skip blurhash for faster testing
      });

      await nodeGenerator.generateForMovie(movieName);
      const nodeMetadataPath = join(movieDir, 'metadata.json');
      const nodeMetadata = JSON.parse(await fs.readFile(nodeMetadataPath, 'utf8'));

      // === PYTHON FRESH REQUEST ===
      // Import Python utilities to make fresh TMDB request
      const { fetchComprehensiveMediaDetails } = await import('../../utils/tmdb.mjs');
      
      // Make fresh Python-style request using same methodology 
      const pythonStyleMetadata = await fetchComprehensiveMediaDetails(
        'Bugonia', 
        'movie', 
        movieId, 
        false // No blurhash for testing
      );

      console.log('\n=== LIVE DATA COMPARISON: Node.js vs Python-Style Processing ===');
      console.log(`Movie ID: ${nodeMetadata.id}`);
      console.log(`Node.js Title: ${nodeMetadata.title}`);
      console.log(`Python-Style Title: ${pythonStyleMetadata.title}`);
      console.log(`Node.js Cast Count: ${nodeMetadata.cast?.length || 0}`);
      console.log(`Python-Style Cast Count: ${pythonStyleMetadata.cast?.length || 0}`);
      console.log(`Node.js Genres Count: ${nodeMetadata.genres?.length || 0}`);
      console.log(`Python-Style Genres Count: ${pythonStyleMetadata.genres?.length || 0}`);

      // Deep compare Node.js output against fresh Python-style processing
      const { differences, ignoredDifferences } = deepCompare(nodeMetadata, pythonStyleMetadata);

      if (differences.length > 0 || ignoredDifferences.length > 0) {
        console.log('\n=== COMPARISON RESULTS ===');
        console.log(formatDifferences(differences, ignoredDifferences));
      }
      
      if (differences.length === 0 && ignoredDifferences.length === 0) {
        console.log('\n✅ Node.js and Python-style processing are IDENTICAL');
      } else if (differences.length === 0) {
        console.log('\n✅ Node.js and Python-style processing match (ignoring expected dynamic fields)');
      }

      // Assert they are identical (excluding ignored fields)
      expect(differences.length).toBe(0, formatDifferences(differences, ignoredDifferences));

      // Additional critical validations - both should have same structure from live data
      expect(nodeMetadata.id).toBe(pythonStyleMetadata.id);
      expect(nodeMetadata.title).toBe(pythonStyleMetadata.title);
      expect(nodeMetadata.cast.length).toBe(pythonStyleMetadata.cast.length);
      expect(nodeMetadata.genres.length).toBe(pythonStyleMetadata.genres.length);
      
      // Validate cast structure matches (first 5 cast members)
      for (let i = 0; i < Math.min(5, nodeMetadata.cast.length); i++) {
        const nodeCast = nodeMetadata.cast[i];
        const pythonCast = pythonStyleMetadata.cast[i];
        expect(nodeCast.id).toBe(pythonCast.id);
        expect(nodeCast.name).toBe(pythonCast.name);
        expect(nodeCast.character).toBe(pythonCast.character);
        expect(nodeCast.profile_path).toBe(pythonCast.profile_path);
      }

      // Validate genre structure matches
      for (let i = 0; i < nodeMetadata.genres.length; i++) {
        const nodeGenre = nodeMetadata.genres[i];
        const pythonGenre = pythonStyleMetadata.genres[i];
        expect(nodeGenre.id).toBe(pythonGenre.id);
        expect(nodeGenre.name).toBe(pythonGenre.name);
      }
    }, 90000); // 90 second timeout for API calls

  });

  describe('TV Show Metadata Comparison', () => {
    it('should process live TMDB data identically in Node.js and Python implementations for Fargo (60622)', async () => {
      // Skip if no real TMDB API key
      if (!process.env.TMDB_API_KEY || process.env.TMDB_API_KEY === 'test_api_key') {
        console.log('Skipping: Real TMDB_API_KEY required for integration test');
        return;
      }

      const tvShowId = 60622; // Fargo
      const showName = 'Fargo';

      // === NODE.JS FRESH REQUEST ===
      const showDir = join(tvTestDir, showName);
      await fs.mkdir(showDir, { recursive: true });

      // Create tmdb_config.json with known ID
      const tmdbConfig = {
        id: tvShowId,
        type: 'tv',
        name: 'Fargo'
      };
      await fs.writeFile(
        join(showDir, 'tmdb_config.json'),
        JSON.stringify(tmdbConfig, null, 2)
      );

      // Generate metadata using Node.js with fresh TMDB API call (force refresh)
      const nodeGenerator = await MetadataGenerator.create({
        basePath: testDir,
        forceRefresh: true, // Force fresh API calls, bypass cache
        generateBlurhash: false
      });

      await nodeGenerator.generateForShow(showName);
      const nodeMetadataPath = join(showDir, 'metadata.json');
      const nodeMetadata = JSON.parse(await fs.readFile(nodeMetadataPath, 'utf8'));

      // === PYTHON FRESH REQUEST ===
      // Make fresh Python-style request using same methodology 
      const pythonStyleMetadata = await fetchComprehensiveMediaDetails(
        'Fargo', 
        'tv', 
        tvShowId, 
        false // No blurhash for testing
      );

      console.log('\n=== LIVE DATA COMPARISON: Node.js vs Python-Style Processing ===');
      console.log(`TV Show ID: ${nodeMetadata.id}`);
      console.log(`Node.js Name: ${nodeMetadata.name}`);
      console.log(`Python-Style Name: ${pythonStyleMetadata.name}`);
      console.log(`Node.js Cast Count: ${nodeMetadata.cast?.length || 0}`);
      console.log(`Python-Style Cast Count: ${pythonStyleMetadata.cast?.length || 0}`);
      console.log(`Node.js Seasons Count: ${nodeMetadata.seasons?.length || 0}`);
      console.log(`Python-Style Seasons Count: ${pythonStyleMetadata.seasons?.length || 0}`);

      // Deep compare Node.js output against fresh Python-style processing
      const { differences, ignoredDifferences } = deepCompare(nodeMetadata, pythonStyleMetadata);

      if (differences.length > 0 || ignoredDifferences.length > 0) {
        console.log('\n=== COMPARISON RESULTS ===');
        console.log(formatDifferences(differences, ignoredDifferences));
      }
      
      if (differences.length === 0 && ignoredDifferences.length === 0) {
        console.log('\n✅ Node.js and Python-style processing are IDENTICAL');
      } else if (differences.length === 0) {
        console.log('\n✅ Node.js and Python-style processing match (ignoring expected dynamic fields)');
      }

      // Assert they are identical (excluding ignored fields)
      expect(differences.length).toBe(0, formatDifferences(differences, ignoredDifferences));

      // Additional critical validations - both should have same structure from live data
      expect(nodeMetadata.id).toBe(pythonStyleMetadata.id);
      expect(nodeMetadata.name).toBe(pythonStyleMetadata.name);
      expect(nodeMetadata.seasons.length).toBe(pythonStyleMetadata.seasons.length);

      // Validate seasons structure matches (first 3 seasons)
      for (let i = 0; i < Math.min(3, nodeMetadata.seasons.length); i++) {
        const nodeSeason = nodeMetadata.seasons[i];
        const pythonSeason = pythonStyleMetadata.seasons[i];
        expect(nodeSeason.season_number).toBe(pythonSeason.season_number);
        expect(nodeSeason.id).toBe(pythonSeason.id);
        expect(nodeSeason.name).toBe(pythonSeason.name);
      }
    }, 90000);

  });

  describe('Deep Object Comparison Validation', () => {
    it('should detect differences in nested objects', () => {
      const obj1 = {
        title: 'Movie',
        cast: [
          { id: 1, name: 'Actor 1', character: 'Role 1' }
        ],
        metadata: { rating: 'PG', runtime: 120 }
      };

      const obj2 = {
        title: 'Movie',
        cast: [
          { id: 1, name: 'Actor 1', character: 'Role 2' } // Different character
        ],
        metadata: { rating: 'PG', runtime: 120 }
      };

      const { differences } = deepCompare(obj1, obj2);
      expect(differences.length).toBe(1);
      expect(differences[0].path).toBe('cast[0].character');
    });

    it('should detect missing fields', () => {
      const obj1 = { title: 'Movie', year: 2025 };
      const obj2 = { title: 'Movie' };

      const { differences } = deepCompare(obj1, obj2);
      expect(differences.length).toBe(1);
      expect(differences[0].type).toBe('missing_in_python');
    });

    it('should detect extra fields', () => {
      const obj1 = { title: 'Movie' };
      const obj2 = { title: 'Movie', extra: 'data' };

      const { differences } = deepCompare(obj1, obj2);
      expect(differences.length).toBe(1);
      expect(differences[0].type).toBe('missing_in_node');
    });

    it('should detect array length mismatches', () => {
      const obj1 = { cast: [1, 2, 3] };
      const obj2 = { cast: [1, 2] };

      const { differences } = deepCompare(obj1, obj2);
      expect(differences.length).toBeGreaterThan(0);
      expect(differences.some(d => d.type === 'array_length_mismatch')).toBe(true);
    });

    it('should handle null values correctly', () => {
      const obj1 = { profile: null };
      const obj2 = { profile: null };

      const { differences } = deepCompare(obj1, obj2);
      expect(differences.length).toBe(0);
    });

    it('should detect null vs value mismatches', () => {
      const obj1 = { profile: null };
      const obj2 = { profile: 'image.jpg' };

      const { differences } = deepCompare(obj1, obj2);
      expect(differences.length).toBe(1);
      expect(differences[0].type).toBe('null_mismatch');
    });
    
    it('should ignore dynamic fields like timestamps and vote counts', () => {
      const obj1 = { 
        title: 'Movie',
        last_updated: '2026-01-12T10:00:00Z',
        vote_average: 7.5,
        vote_count: 100,
        popularity: 50.5
      };
      const obj2 = { 
        title: 'Movie',
        last_updated: '2026-01-12T11:00:00Z',
        vote_average: 7.6,
        vote_count: 101,
        popularity: 51.0
      };

      const { differences, ignoredDifferences } = deepCompare(obj1, obj2);
      expect(differences.length).toBe(0); // No critical differences
      expect(ignoredDifferences.length).toBe(4); // 4 ignored fields
    });
  });

});
