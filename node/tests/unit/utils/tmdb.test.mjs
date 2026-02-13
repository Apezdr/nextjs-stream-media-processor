/**
 * Unit tests for TMDB utility functions
 * Tests cast formatting, genre extraction, and data structure compatibility
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env.local (preferred) or .env file
const rootDir = join(__dirname, '../../../..');
try {
  // Try .env.local first (local development overrides)
  const localEnvPath = join(rootDir, '.env.local');
  try {
    await import('fs').then(fs => fs.promises.access(localEnvPath));
    dotenvConfig({ path: localEnvPath });
  } catch {
    // Fall back to .env
    dotenvConfig({ path: join(rootDir, '.env') });
  }
} catch (error) {
  // No .env files found, will use system environment variables
}

// Set TMDB_API_KEY before importing tmdb module (fallback to test key)
process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'test_api_key';

// Mock database before importing tmdb
jest.unstable_mockModule('../../../sqliteDatabase.mjs', () => ({
  getTmdbCache: jest.fn().mockResolvedValue(null),
  setTmdbCache: jest.fn().mockResolvedValue(true),
  withWriteTx: jest.fn(() => Promise.resolve()),
  withDb: jest.fn(() => Promise.resolve()),
  withRetry: jest.fn((fn) => fn())
}));

// Mock axios
jest.unstable_mockModule('axios', () => ({
  default: {
    get: jest.fn()
  }
}));

// Import after mocks
const axios = (await import('axios')).default;
const {
  getMediaCast,
  getStructuredMediaCast,
  getMediaVideos,
  getMediaImages,
  getMediaRating,
  getTMDBImageURL,
  formatRuntime,
  aggregateTopCast
} = await import('../../../utils/tmdb.mjs');

describe('TMDB Utility Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMediaCast', () => {
    it('should format cast data matching Python structure', async () => {
      // Mock TMDB credits endpoint response
      axios.get.mockResolvedValue({
        data: {
          cast: [
            {
              id: 54693,
              name: 'Emma Stone',
              character: 'Michelle',
              profile_path: '/8NwSfyYWIIUE1c.jpg'
            },
            {
              id: 88124,
              name: 'Jesse Plemons',
              character: 'Teddy',
              profile_path: null  // Test null handling
            }
          ]
        },
        status: 200,
        headers: {}
      });

      const cast = await getMediaCast('movie', 701387);

      // Validate structure matches Python implementation
      expect(cast).toHaveLength(2);

      // First member with profile
      expect(cast[0]).toEqual({
        id: 54693,
        name: 'Emma Stone',
        character: 'Michelle',
        profile_path: 'https://image.tmdb.org/t/p/original/8NwSfyYWIIUE1c.jpg'
      });

      // Second member without profile (null)
      expect(cast[1]).toEqual({
        id: 88124,
        name: 'Jesse Plemons',
        character: 'Teddy',
        profile_path: null
      });
    });

    it('should handle empty cast array', async () => {
      axios.get.mockResolvedValue({
        data: { cast: [] },
        status: 200,
        headers: {}
      });

      const cast = await getMediaCast('movie', 12345);

      expect(cast).toEqual([]);
    });

    it('should handle missing character field', async () => {
      axios.get.mockResolvedValue({
        data: {
          cast: [{
            id: 1001,
            name: 'Extra Actor',
            character: null,  // Missing character
            profile_path: null
          }]
        },
        status: 200,
        headers: {}
      });

      const cast = await getMediaCast('movie', 12345);

      expect(cast[0].character).toBe('');  // Should default to empty string
    });
  });

  describe('getMediaVideos', () => {
    it('should extract YouTube trailer URL matching Python logic', async () => {
      axios.get.mockResolvedValue({
        data: {
          results: [
            {
              type: 'Trailer',
              site: 'YouTube',
              key: '7VBigr-JHB0'
            },
            {
              type: 'Clip',
              site: 'YouTube',
              key: 'other123'
            }
          ]
        },
        status: 200,
        headers: {}
      });

      const videos = await getMediaVideos('movie', 701387);

      // Should match Python format
      expect(videos.trailer_url).toBe('https://www.youtube.com/watch?v=7VBigr-JHB0');
    });

    it('should return null when no trailer found', async () => {
      axios.get.mockResolvedValue({
        data: { results: [] },
        status: 200,
        headers: {}
      });

      const videos = await getMediaVideos('movie', 12345);

      expect(videos.trailer_url).toBeNull();
    });
  });

  describe('getMediaImages', () => {
    it('should extract English logo matching Python logic', async () => {
      axios.get.mockResolvedValue({
        data: {
          logos: [
            {
              iso_639_1: 'en',
              file_path: '/zt1aSeO7YVSmBj.png'
            },
            {
              iso_639_1: 'fr',
              file_path: '/other.png'
            }
          ]
        },
        status: 200,
        headers: {}
      });

      const images = await getMediaImages('movie', 701387);

      // Should match Python format
      expect(images.logo_path).toBe('https://image.tmdb.org/t/p/original/zt1aSeO7YVSmBj.png');
    });

    it('should return null when no English logo found', async () => {
      axios.get.mockResolvedValue({
        data: { logos: [] },
        status: 200,
        headers: {}
      });

      const images = await getMediaImages('movie', 12345);

      expect(images.logo_path).toBeNull();
    });
  });

  describe('getMediaRating', () => {
    it('should extract US rating for movies matching Python logic', async () => {
      axios.get.mockResolvedValue({
        data: {
          results: [
            {
              iso_3166_1: 'US',
              release_dates: [
                { certification: 'R' }
              ]
            }
          ]
        },
        status: 200,
        headers: {}
      });

      const rating = await getMediaRating('movie', 701387);

      expect(rating.rating).toBe('R');
    });

    it('should extract US rating for TV shows matching Python logic', async () => {
      axios.get.mockResolvedValue({
        data: {
          results: [
            {
              iso_3166_1: 'US',
              rating: 'TV-MA'
            }
          ]
        },
        status: 200,
        headers: {}
      });

      const rating = await getMediaRating('tv', 60622);

      expect(rating.rating).toBe('TV-MA');
    });
  });

  describe('getTMDBImageURL', () => {
    it('should construct full TMDB image URLs', () => {
      const url = getTMDBImageURL('/test.jpg', 'original');
      expect(url).toBe('https://image.tmdb.org/t/p/original/test.jpg');
    });

    it('should return null for null file path', () => {
      const url = getTMDBImageURL(null);
      expect(url).toBeNull();
    });
  });

  describe('formatRuntime', () => {
    it('should format runtime in hours and minutes', () => {
      expect(formatRuntime(119)).toBe('1h 59m');
      expect(formatRuntime(120)).toBe('2h');
      expect(formatRuntime(45)).toBe('45m');
    });

    it('should handle invalid runtime', () => {
      expect(formatRuntime(0)).toBe('Unknown');
      expect(formatRuntime(null)).toBe('Unknown');
    });
  });

  describe('getStructuredMediaCast', () => {
    it('should return only cast array for movies', async () => {
      // Mock TMDB credits endpoint response for movies
      axios.get.mockResolvedValue({
        data: {
          cast: [
            {
              id: 54693,
              name: 'Emma Stone',
              character: 'Michelle',
              profile_path: '/8NwSfyYWIIUE1c.jpg'
            },
            {
              id: 88124,
              name: 'Jesse Plemons',
              character: 'Teddy',
              profile_path: '/test.jpg'
            }
          ]
        },
        status: 200,
        headers: {}
      });

      const result = await getStructuredMediaCast('movie', 701387);

      // Movies should only have cast array (no recurring_cast)
      expect(result).toHaveProperty('cast');
      expect(result).not.toHaveProperty('recurring_cast');
      expect(result).not.toHaveProperty('guest_cast');
      expect(result.cast).toHaveLength(2);
      expect(result.cast[0].id).toBe(54693);
    });

    it('should return cast and recurring_cast arrays for TV shows', async () => {
      // Mock TMDB aggregate_credits endpoint response for TV
      axios.get.mockResolvedValue({
        data: {
          cast: [
            {
              id: 17419,
              name: 'Bryan Cranston',
              roles: [{ character: 'Walter White' }],
              total_episode_count: 62,
              profile_path: '/cranston.jpg',
              known_for_department: 'Acting'
            },
            {
              id: 84497,
              name: 'Aaron Paul',
              roles: [{ character: 'Jesse Pinkman' }],
              total_episode_count: 62,
              profile_path: '/paul.jpg',
              known_for_department: 'Acting'
            },
            {
              id: 1234,
              name: 'Recurring Actor',
              roles: [{ character: 'Side Character' }],
              total_episode_count: 5,
              profile_path: '/recurring.jpg',
              known_for_department: 'Acting'
            },
            {
              id: 5678,
              name: 'Guest Actor',
              roles: [{ character: 'Guest' }],
              total_episode_count: 2,
              profile_path: '/guest.jpg',
              known_for_department: 'Acting'
            }
          ]
        },
        status: 200,
        headers: {}
      });

      const result = await getStructuredMediaCast('tv', 1396);

      // TV shows should have both cast and recurring_cast
      expect(result).toHaveProperty('cast');
      expect(result).toHaveProperty('recurring_cast');
      expect(result).not.toHaveProperty('guest_cast'); // Not included by default
      
      // All cast members should be in cast array
      expect(result.cast).toHaveLength(4);
      
      // Only recurring cast (3-7 episodes) should be in recurring_cast
      expect(result.recurring_cast).toHaveLength(1);
      expect(result.recurring_cast[0].id).toBe(1234);
      expect(result.recurring_cast[0].name).toBe('Recurring Actor');
      expect(result.recurring_cast[0].type).toBe('Recurring');
      
      // Season Regulars should have proper classification
      expect(result.cast[0].type).toBe('Season Regular');
      expect(result.cast[0].total_episode_count).toBe(62);
      
      // Guest Stars should have proper classification
      expect(result.cast[3].type).toBe('Guest Star');
      expect(result.cast[3].total_episode_count).toBe(2);
    });

    it('should include guest_cast array when includeGuestCast is true', async () => {
      axios.get.mockResolvedValue({
        data: {
          cast: [
            {
              id: 1234,
              name: 'Recurring Actor',
              roles: [{ character: 'Side Character' }],
              total_episode_count: 5,
              profile_path: '/recurring.jpg',
              known_for_department: 'Acting'
            },
            {
              id: 5678,
              name: 'Guest Actor',
              roles: [{ character: 'Guest' }],
              total_episode_count: 2,
              profile_path: '/guest.jpg',
              known_for_department: 'Acting'
            }
          ]
        },
        status: 200,
        headers: {}
      });

      const result = await getStructuredMediaCast('tv', 1396, true);

      // Should include guest_cast when requested
      expect(result).toHaveProperty('guest_cast');
      expect(result.guest_cast).toHaveLength(1);
      expect(result.guest_cast[0].id).toBe(5678);
      expect(result.guest_cast[0].type).toBe('Guest Star');
    });

    it('should handle TV shows with no recurring cast', async () => {
      axios.get.mockResolvedValue({
        data: {
          cast: [
            {
              id: 100,
              name: 'Main Actor',
              roles: [{ character: 'Lead' }],
              total_episode_count: 10,
              profile_path: '/main.jpg',
              known_for_department: 'Acting'
            }
          ]
        },
        status: 200,
        headers: {}
      });

      const result = await getStructuredMediaCast('tv', 12345);

      expect(result.cast).toHaveLength(1);
      expect(result.recurring_cast).toHaveLength(0); // Empty array, not undefined
    });
  });

  describe('aggregateTopCast', () => {
    it('should aggregate cast members across multiple movies', () => {
      const movies = [
        {
          id: 1,
          title: 'Movie 1',
          credits: {
            cast: [
              { id: 100, name: 'Actor A', character: 'Role 1', profile_path: '/a.jpg' },
              { id: 101, name: 'Actor B', character: 'Role 2', profile_path: '/b.jpg' }
            ]
          }
        },
        {
          id: 2,
          title: 'Movie 2',
          credits: {
            cast: [
              { id: 100, name: 'Actor A', character: 'Role 3', profile_path: '/a.jpg' }, // Appears again
              { id: 102, name: 'Actor C', character: 'Role 4', profile_path: '/c.jpg' }
            ]
          }
        }
      ];

      const topCast = aggregateTopCast(movies);

      // Actor A should be first (appears in 2 movies)
      expect(topCast[0].id).toBe(100);
      expect(topCast[0].appearances).toBe(2);
      expect(topCast[0].characters).toHaveLength(2);
    });
  });
});
