/**
 * Test Setup and Helper Utilities
 * Shared configuration and utilities for Node.js tests
 */

import { jest } from '@jest/globals';
import { promises as fs } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load Python-generated fixture data
 * @param {string} filename - Fixture filename
 * @returns {Object} Parsed JSON data
 */
export async function loadPythonFixture(filename) {
  const fixturePath = join(__dirname, '../fixtures/python-generated', filename);
  const content = await fs.readFile(fixturePath, 'utf8');
  return JSON.parse(content);
}

/**
 * Mock axios for TMDB API responses
 * @param {Object} mockData - Data to return from API
 * @returns {Object} Mocked axios instance
 */
export function mockTmdbAxios(mockData) {
  const axios = jest.fn();
  axios.get = jest.fn().mockResolvedValue({
    data: mockData,
    status: 200,
    headers: {}
  });
  return axios;
}

/**
 * Create mock database interface
 * @returns {Object} Mocked database methods
 */
export function mockDatabase() {
  return {
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn(),
    exec: jest.fn()
  };
}

/**
 * Validate cast member structure matches Python/Node.js contract
 * @param {Object} castMember - Cast member object to validate
 */
export function validateCastMemberStructure(castMember) {
  expect(castMember).toHaveProperty('id');
  expect(castMember).toHaveProperty('name');
  expect(castMember).toHaveProperty('character');
  expect(castMember).toHaveProperty('profile_path');
  
  expect(typeof castMember.id).toBe('number');
  expect(typeof castMember.name).toBe('string');
  expect(typeof castMember.character).toBe('string');
  
  // profile_path must be string or null
  if (castMember.profile_path !== null) {
    expect(typeof castMember.profile_path).toBe('string');
    expect(castMember.profile_path).toMatch(/^https:\/\/image\.tmdb\.org\/t\/p\/original\//);
  }
}

/**
 * Validate genre structure matches Python/Node.js contract
 * @param {Object} genre - Genre object to validate
 */
export function validateGenreStructure(genre) {
  expect(genre).toHaveProperty('id');
  expect(genre).toHaveProperty('name');
  
  expect(typeof genre.id).toBe('number');
  expect(typeof genre.name).toBe('string');
  
  expect(genre.id).toBeGreaterThan(0);
  expect(genre.name.length).toBeGreaterThan(0);
}

/**
 * TMDB Standard Genre IDs
 */
export const TMDB_GENRES = {
  // Movie Genres
  12: 'Adventure',
  14: 'Fantasy',
  16: 'Animation',
  18: 'Drama',
  27: 'Horror',
  28: 'Action',
  35: 'Comedy',
  36: 'History',
  37: 'Western',
  53: 'Thriller',
  80: 'Crime',
  99: 'Documentary',
  878: 'Science Fiction',
  9648: 'Mystery',
  10402: 'Music',
  10749: 'Romance',
  10751: 'Family',
  10752: 'War',
  // TV Genres
  10759: 'Action & Adventure',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics'
};

/**
 * Mock metadata.json file structure
 * Based on Python script output
 */
export const createMockMetadata = (type = 'movie', overrides = {}) => {
  const baseMovie = {
    id: 67890,
    title: 'Test Movie',
    overview: 'Test movie overview',
    release_date: '2022-06-15',
    runtime: 120,
    vote_average: 7.8,
    vote_count: 2500,
    popularity: 150.3,
    poster_path: '/movie_poster.jpg',
    backdrop_path: '/movie_backdrop.jpg',
    genres: [
      { id: 28, name: 'Action' },
      { id: 12, name: 'Adventure' }
    ],
    cast: [
      {
        id: 2001,
        name: 'Test Actor',
        character: 'Hero',
        profile_path: 'https://image.tmdb.org/t/p/original/actor.jpg'
      }
    ],
    trailer_url: 'https://www.youtube.com/watch?v=test123',
    logo_path: 'https://image.tmdb.org/t/p/original/logo.png',
    rating: 'PG-13',
    last_updated: new Date().toISOString(),
    ...overrides
  };

  const baseTv = {
    id: 12345,
    name: 'Test Show',
    overview: 'Test show overview',
    first_air_date: '2020-01-01',
    last_air_date: '2023-12-31',
    number_of_seasons: 3,
    number_of_episodes: 30,
    vote_average: 8.5,
    vote_count: 1000,
    popularity: 100.5,
    poster_path: '/show_poster.jpg',
    backdrop_path: '/show_backdrop.jpg',
    genres: [
      { id: 18, name: 'Drama' },
      { id: 10765, name: 'Sci-Fi & Fantasy' }
    ],
    seasons: [
      {
        season_number: 1,
        episode_count: 10,
        id: 50001,
        poster_path: '/season1.jpg',
        air_date: '2020-01-01'
      }
    ],
    cast: [
      {
        id: 1001,
        name: 'Test Actor',
        character: 'Main Character',
        profile_path: 'https://image.tmdb.org/t/p/original/actor.jpg'
      }
    ],
    trailer_url: 'https://www.youtube.com/watch?v=test123',
    logo_path: 'https://image.tmdb.org/t/p/original/logo.png',
    rating: 'TV-14',
    last_updated: new Date().toISOString(),
    ...overrides
  };

  return type === 'movie' ? baseMovie : baseTv;
};
