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
  getTmdbCacheEntryAnyAge: jest.fn().mockResolvedValue(null),
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

const getWikidataRatingEnrichment = jest.fn().mockResolvedValue(null);
jest.unstable_mockModule('../../../utils/wikidata.mjs', () => ({
  getWikidataRatingEnrichment: (...args) => getWikidataRatingEnrichment(...args),
}));

const {
  getMediaCast,
  getStructuredMediaCast,
  getMediaVideos,
  getMediaImages,
  getMediaRating,
  getTMDBImageURL,
  formatRuntime,
  aggregateTopCast,
  fetchComprehensiveMediaDetails,
  TmdbNoMatchError,
  pickSearchResultByYear
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
      const releaseDates = {
        results: [
          {
            iso_3166_1: 'US',
            release_dates: [
              {
                certification: 'R',
                descriptors: ['Strong Language'],
                release_date: '2025-01-01T00:00:00.000Z',
                type: 3,
              }
            ]
          }
        ]
      };
      axios.get.mockResolvedValue({
        data: releaseDates,
        status: 200,
        headers: {}
      });

      const rating = await getMediaRating('movie', 701387);

      expect(rating.rating).toBe('R');
      expect(rating.descriptors).toEqual(['Strong Language']);
      expect(rating.release_dates).toEqual(releaseDates);
      expect(rating).not.toHaveProperty('content_ratings');
    });

    it('should extract US rating for TV shows matching Python logic', async () => {
      const contentRatings = {
        results: [
          {
            iso_3166_1: 'US',
            rating: 'TV-MA',
            descriptors: ['Violence'],
          }
        ]
      };
      axios.get.mockResolvedValue({
        data: contentRatings,
        status: 200,
        headers: {}
      });

      const rating = await getMediaRating('tv', 60622);

      expect(rating.rating).toBe('TV-MA');
      expect(rating.descriptors).toEqual(['Violence']);
      expect(rating.content_ratings).toEqual(contentRatings);
      expect(rating).not.toHaveProperty('release_dates');
    });

    it('recalls descriptors from another release with the same certification only', async () => {
      axios.get.mockResolvedValue({
        data: {
          id: 42,
          results: [
            {
              iso_3166_1: 'US',
              release_dates: [
                { certification: 'R', descriptors: [], type: 4, release_date: '2025-02-01' },
                { certification: 'PG-13', descriptors: ['Wrong rating'], type: 3, release_date: '2025-01-01' },
                { certification: 'R', descriptors: ['Strong Language'], type: 3, release_date: '2025-01-15' },
              ],
            },
          ],
        },
        status: 200,
        headers: {},
      });

      const rating = await getMediaRating('movie', 42);

      expect(rating.rating).toBe('R');
      expect(rating.descriptors).toEqual(['Strong Language']);
      expect(rating.release_dates.results[0].release_dates).toHaveLength(3);
    });

    it('returns a bounded, sanitized, US-only movie payload without cache or note fields', async () => {
      const descriptors = [
        ' Violence ',
        'violence',
        '<strong>Language</strong>',
        '&lt;Encoded&gt;',
        'Strong\u0000Language',
        '\u061cHidden direction',
        '\u200eLeft-to-right mark',
        '\u200fRight-to-left mark',
        ...Array.from({ length: 12 }, (_, index) => `Descriptor ${index}`),
        'x'.repeat(161),
      ];
      const releases = Array.from({ length: 140 }, (_, index) => ({
        certification: index === 0 ? 'R' : '',
        descriptors: index === 0 ? descriptors : [],
        note: 'Do not expose',
        release_date: '2025-01-01T00:00:00.000Z',
        type: 3,
        unknown: 'Do not expose',
      }));
      axios.get.mockResolvedValue({
        data: {
          id: 42,
          results: [
            { iso_3166_1: 'GB', release_dates: [{ certification: '18' }] },
            { iso_3166_1: 'US', release_dates: releases },
          ],
          _cached: true,
          _cachedAt: 'volatile',
          _expiresAt: 'volatile',
          _etag: 'volatile',
          _notModified: true,
        },
        status: 200,
        headers: {},
      });

      const rating = await getMediaRating('movie', 42);
      const payload = rating.release_dates;
      const firstRelease = payload.results[0].release_dates[0];

      expect(Object.keys(payload).sort()).toEqual(['id', 'results']);
      expect(payload.results).toHaveLength(1);
      expect(payload.results[0].iso_3166_1).toBe('US');
      expect(payload.results[0].release_dates).toHaveLength(128);
      expect(Object.keys(firstRelease).sort()).toEqual([
        'certification', 'descriptors', 'release_date', 'type',
      ]);
      expect(firstRelease.descriptors).toEqual([
        'Violence',
        'Descriptor 0',
        'Descriptor 1',
        'Descriptor 2',
        'Descriptor 3',
        'Descriptor 4',
        'Descriptor 5',
        'Descriptor 6',
      ]);
      expect(rating.descriptors).toEqual(firstRelease.descriptors);
      expect(JSON.stringify(payload)).not.toContain('Do not expose');
      expect(JSON.stringify(payload)).not.toContain('_cached');
      expect(Buffer.byteLength(JSON.stringify(rating), 'utf8')).toBeLessThan(512 * 1024);
    });

    it('returns a sanitized US-only TV payload without unknown fields', async () => {
      axios.get.mockResolvedValue({
        data: {
          id: 99,
          results: [
            { iso_3166_1: 'GB', rating: '18', descriptors: ['Foreign'] },
            {
              iso_3166_1: 'US',
              rating: 'TV-MA',
              descriptors: [' Violence ', 'violence', '<b>Language</b>', 'Strong Language'],
              unknown: 'Do not expose',
            },
          ],
          _cached: true,
        },
        status: 200,
        headers: {},
      });

      const result = await getMediaRating('tv', 99);

      expect(result.rating).toBe('TV-MA');
      expect(result.descriptors).toEqual(['Violence', 'Strong Language']);
      expect(result.content_ratings).toEqual({
        id: 99,
        results: [{
          descriptors: ['Violence', 'Strong Language'],
          iso_3166_1: 'US',
          rating: 'TV-MA',
        }],
      });
      expect(JSON.stringify(result)).not.toContain('Do not expose');
      expect(JSON.stringify(result)).not.toContain('_cached');
    });

    it('handles malformed movie and TV result shapes without throwing', async () => {
      axios.get
        .mockResolvedValueOnce({ data: { results: {} }, status: 200, headers: {} })
        .mockResolvedValueOnce({
          data: { results: [null, { iso_3166_1: 'US', rating: 14, descriptors: 'bad' }] },
          status: 200,
          headers: {},
        });

      await expect(getMediaRating('movie', 42)).resolves.toEqual({
        rating: null,
        descriptors: [],
        release_dates: { results: [] },
      });
      await expect(getMediaRating('tv', 42)).resolves.toEqual({
        rating: null,
        descriptors: [],
        content_ratings: {
          results: [{ descriptors: [], iso_3166_1: 'US', rating: '' }],
        },
      });
    });
  });

  describe('fetchComprehensiveMediaDetails rating payload', () => {
    it('keeps the legacy code and exposes movie descriptors plus release dates', async () => {
      const releaseDates = {
        results: [{
          iso_3166_1: 'US',
          release_dates: [{
            certification: 'PG-13',
            descriptors: ['Violence'],
            release_date: '2025-01-01T00:00:00.000Z',
            type: 3,
          }],
        }],
      };

      axios.get.mockImplementation(async (url) => {
        if (url.includes('/release_dates')) return { data: releaseDates, status: 200, headers: {} };
        if (url.includes('/credits')) return { data: { cast: [], crew: [] }, status: 200, headers: {} };
        if (url.includes('/videos')) return { data: { results: [] }, status: 200, headers: {} };
        if (url.includes('/images')) return { data: { logos: [], backdrops: [], posters: [] }, status: 200, headers: {} };
        return { data: { id: 123, title: 'Example' }, status: 200, headers: {} };
      });

      const result = await fetchComprehensiveMediaDetails('Example', 'movie', 123, false);

      expect(result.rating).toBe('PG-13');
      expect(result.descriptors).toEqual(['Violence']);
      expect(result.release_dates).toEqual(releaseDates);
    });

    it('attaches cached Wikidata evidence without allowing request-path network access', async () => {
      const previousMode = process.env.WIKIDATA_RATING_ENRICHMENT;
      process.env.WIKIDATA_RATING_ENRICHMENT = 'scanner';
      const enrichment = {
        schema: 1,
        entityId: 'Q136163067',
        tmdbMovieId: '1339713',
        contentRating: 'R',
        ratingEntityId: 'Q18665344',
        descriptors: [],
      };
      getWikidataRatingEnrichment.mockResolvedValueOnce(enrichment);
      axios.get.mockImplementation(async (url) => {
        if (url.includes('/release_dates')) {
          return {
            data: {
              results: [{
                iso_3166_1: 'US',
                release_dates: [{ certification: 'R', descriptors: [] }],
              }],
            },
            status: 200,
            headers: {},
          };
        }
        if (url.includes('/credits')) return { data: { cast: [], crew: [] }, status: 200, headers: {} };
        if (url.includes('/videos')) return { data: { results: [] }, status: 200, headers: {} };
        if (url.includes('/images')) return { data: { logos: [], backdrops: [], posters: [] }, status: 200, headers: {} };
        return { data: { id: 1339713, imdb_id: 'tt37287335', title: 'Obsession' }, status: 200, headers: {} };
      });

      try {
        const result = await fetchComprehensiveMediaDetails(
          'Obsession',
          'movie',
          1339713,
          false,
          { allowWikidataNetwork: false },
        );

        expect(getWikidataRatingEnrichment).toHaveBeenCalledWith({
          mediaType: 'movie',
          tmdbId: 1339713,
          imdbId: 'tt37287335',
          allowNetwork: false,
        });
        expect(result.contentRatingEnrichments).toEqual({ wikidata: enrichment });
      } finally {
        if (previousMode === undefined) delete process.env.WIKIDATA_RATING_ENRICHMENT;
        else process.env.WIKIDATA_RATING_ENRICHMENT = previousMode;
      }
    });

    it('skips Wikidata without a supported TMDB MPA code and omits code conflicts', async () => {
      const previousMode = process.env.WIKIDATA_RATING_ENRICHMENT;
      process.env.WIKIDATA_RATING_ENRICHMENT = 'scanner';
      axios.get.mockImplementation(async (url) => {
        if (url.includes('/release_dates')) return { data: { results: [] }, status: 200, headers: {} };
        if (url.includes('/credits')) return { data: { cast: [], crew: [] }, status: 200, headers: {} };
        if (url.includes('/videos')) return { data: { results: [] }, status: 200, headers: {} };
        if (url.includes('/images')) return { data: { logos: [], backdrops: [], posters: [] }, status: 200, headers: {} };
        return { data: { id: 1339713, imdb_id: 'tt37287335', title: 'Obsession' }, status: 200, headers: {} };
      });

      try {
        const absent = await fetchComprehensiveMediaDetails(
          'Obsession',
          'movie',
          1339713,
          false,
          { allowWikidataNetwork: true },
        );
        expect(getWikidataRatingEnrichment).not.toHaveBeenCalled();
        expect(absent).not.toHaveProperty('contentRatingEnrichments');

        jest.clearAllMocks();
        getWikidataRatingEnrichment.mockResolvedValueOnce({
          schema: 1,
          entityId: 'Q1',
          tmdbMovieId: '1339713',
          contentRating: 'PG-13',
          ratingEntityId: 'Q18665339',
          descriptors: ['Violence'],
        });
        axios.get.mockImplementation(async (url) => {
          if (url.includes('/release_dates')) {
            return {
              data: {
                results: [{
                  iso_3166_1: 'US',
                  release_dates: [{ certification: 'R', descriptors: [] }],
                }],
              },
              status: 200,
              headers: {},
            };
          }
          if (url.includes('/credits')) return { data: { cast: [], crew: [] }, status: 200, headers: {} };
          if (url.includes('/videos')) return { data: { results: [] }, status: 200, headers: {} };
          if (url.includes('/images')) return { data: { logos: [], backdrops: [], posters: [] }, status: 200, headers: {} };
          return { data: { id: 1339713, imdb_id: 'tt37287335', title: 'Obsession' }, status: 200, headers: {} };
        });

        const conflict = await fetchComprehensiveMediaDetails(
          'Obsession',
          'movie',
          1339713,
          false,
          { allowWikidataNetwork: true },
        );
        expect(conflict.rating).toBe('R');
        expect(conflict).not.toHaveProperty('contentRatingEnrichments');
      } finally {
        if (previousMode === undefined) delete process.env.WIKIDATA_RATING_ENRICHMENT;
        else process.env.WIKIDATA_RATING_ENRICHMENT = previousMode;
      }
    });

    it('keeps comprehensive TMDB metadata intact when scanner enrichment fails', async () => {
      const previousMode = process.env.WIKIDATA_RATING_ENRICHMENT;
      process.env.WIKIDATA_RATING_ENRICHMENT = 'scanner';
      getWikidataRatingEnrichment.mockRejectedValueOnce(new Error('Wikidata unavailable'));
      axios.get.mockImplementation(async (url) => {
        if (url.includes('/release_dates')) {
          return {
            data: {
              results: [{
                iso_3166_1: 'US',
                release_dates: [{ certification: 'R', descriptors: [] }],
              }],
            },
            status: 200,
            headers: {},
          };
        }
        if (url.includes('/credits')) return { data: { cast: [], crew: [] }, status: 200, headers: {} };
        if (url.includes('/videos')) return { data: { results: [] }, status: 200, headers: {} };
        if (url.includes('/images')) return { data: { logos: [], backdrops: [], posters: [] }, status: 200, headers: {} };
        return { data: { id: 1339713, imdb_id: 'tt37287335', title: 'Obsession' }, status: 200, headers: {} };
      });

      try {
        const result = await fetchComprehensiveMediaDetails(
          'Obsession',
          'movie',
          1339713,
          false,
          { allowWikidataNetwork: true },
        );

        expect(result.rating).toBe('R');
        expect(result).not.toHaveProperty('contentRatingEnrichments');
        expect(getWikidataRatingEnrichment).toHaveBeenCalledWith(expect.objectContaining({
          allowNetwork: true,
        }));
      } finally {
        if (previousMode === undefined) delete process.env.WIKIDATA_RATING_ENRICHMENT;
        else process.env.WIKIDATA_RATING_ENRICHMENT = previousMode;
      }
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

  describe('fetchComprehensiveMediaDetails no-match classification', () => {
    it('throws a typed TmdbNoMatchError when both name searches return zero results', async () => {
      // Original name AND the year-stripped retry both come back empty.
      axios.get.mockResolvedValue({
        data: { results: [] },
        status: 200,
        headers: {}
      });

      let thrown;
      try {
        await fetchComprehensiveMediaDetails('No Such Movie (1999)', 'movie');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(TmdbNoMatchError);
      expect(thrown.name).toBe('TmdbNoMatchError');
      expect(thrown.code).toBe('no-match');
      expect(thrown.message).toMatch(/No results found for movie: No Such Movie \(1999\)/);
      // Exactly the two search requests ran (original + year-stripped retry);
      // the details fan-out was never reached.
      expect(axios.get).toHaveBeenCalledTimes(2);
    });

    it('does NOT use TmdbNoMatchError for HTTP/network failures (those stay generic)', async () => {
      axios.get.mockRejectedValue(new Error('Request failed with status code 500'));

      let thrown;
      try {
        await fetchComprehensiveMediaDetails('Flaky Movie (2001)', 'movie');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeDefined();
      expect(thrown).not.toBeInstanceOf(TmdbNoMatchError);
      expect(thrown.message).toMatch(/TMDB API request failed/);
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

  describe('pickSearchResultByYear (T-3 year heuristic)', () => {
    const movie = (id, releaseDate) => ({ id, release_date: releaseDate });
    const show = (id, firstAirDate) => ({ id, first_air_date: firstAirDate });

    it('returns the popularity-first result when the name carries no year', () => {
      const results = [movie(1, '2010-06-01'), movie(2, '1994-01-01')];
      expect(pickSearchResultByYear(results, 'Some Movie', 'movie').id).toBe(1);
    });

    it('prefers an exact year match over a more popular non-matching result', () => {
      // The classic wrong-match case: a popular remake outranks the original.
      const results = [movie(1, '2019-11-08'), movie(2, '1976-06-18')];
      expect(pickSearchResultByYear(results, 'Midway (1976)', 'movie').id).toBe(2);
    });

    it('takes the most popular result among multiple exact-year matches', () => {
      const results = [movie(1, '2020-01-01'), movie(2, '2020-12-31'), movie(3, '2020-06-15')];
      expect(pickSearchResultByYear(results, 'Duplicate (2020)', 'movie').id).toBe(1);
    });

    it('falls back to a ±1-year match when no exact year exists', () => {
      // Regional release dates / December premieres straddle the folder year.
      const results = [movie(1, '2005-03-01'), movie(2, '2011-01-14')];
      expect(pickSearchResultByYear(results, 'Straddler (2010)', 'movie').id).toBe(2);
    });

    it('falls back to the popularity-first result when nothing is within ±1 year', () => {
      const results = [movie(1, '1999-01-01'), movie(2, '2003-01-01')];
      expect(pickSearchResultByYear(results, 'Nowhere Close (2015)', 'movie').id).toBe(1);
    });

    it('uses first_air_date for tv and tolerates missing/malformed dates', () => {
      const results = [show(1, undefined), show(2, 'not-a-date'), show(3, '2008-01-20')];
      expect(pickSearchResultByYear(results, 'Breaking Bad (2008)', 'tv').id).toBe(3);
    });

    it('never manufactures a match: single result with wrong year still wins (fallback)', () => {
      const results = [movie(9, '1990-05-05')];
      expect(pickSearchResultByYear(results, 'Lonely (2024)', 'movie').id).toBe(9);
    });
  });
});
