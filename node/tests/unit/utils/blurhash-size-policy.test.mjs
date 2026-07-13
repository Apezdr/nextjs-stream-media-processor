/**
 * B-2b blurhash size-policy tests.
 *
 * The unification was a ZERO-behavior-change refactor: these tests freeze the
 * as-built sizes so any future edit to the shared module is a visible,
 * deliberate policy change (with its invalidation costs: sidecars need a
 * BLURHASH_GENERATION_VERSION bump — which today covers movies only, not TV —
 * and tmdb_blurhash_cache keys embed the size, orphaning old rows).
 */

import { describe, it, expect } from '@jest/globals';
import {
  sidecarBlurhashSizeForImageType,
  sidecarBlurhashSizeForFilename,
  TMDB_PROXY_BLURHASH_SIZES,
} from '../../../utils/blurhashSizePolicy.mjs';

describe('sidecar policy by imageType (downloadImageWithBlurhash keys)', () => {
  it.each([
    ['backdrop', 'small'],
    ['episode-thumbnail', 'small'],
    ['poster', 'medium'],
    ['season-poster', 'medium'],
    ['logo', 'large'],
  ])('%s → %s', (imageType, expected) => {
    expect(sidecarBlurhashSizeForImageType(imageType)).toBe(expected);
  });

  it('unknown/absent kinds fall back to large (historical default)', () => {
    expect(sidecarBlurhashSizeForImageType('something-new')).toBe('large');
    expect(sidecarBlurhashSizeForImageType(undefined)).toBe('large');
  });
});

describe('sidecar policy by filename (getStoredBlurhash keys)', () => {
  it.each([
    ['/tv/Show/show_backdrop.jpg', 'small'],
    ['/movies/M/backdrop.png', 'small'],
    ['/tv/Show/Season 1/01 - Thumbnail.jpg', 'small'],
    ['/movies/M/poster.jpg', 'medium'],
    ['/tv/Show/show_poster.jpg', 'medium'],
    ['/tv/Show/Season 1/season_poster.jpg', 'medium'],
    ['/movies/M/logo.svg', 'large'],
    ['/tv/Show/show_logo.png', 'large'],
    ['/movies/M/unrelated.jpg', 'large'],
  ])('%s → %s', (path, expected) => {
    expect(sidecarBlurhashSizeForFilename(path)).toBe(expected);
  });

  it('is case-insensitive and ranks backdrop/thumbnail over poster over logo', () => {
    expect(sidecarBlurhashSizeForFilename('/x/BACKDROP.JPG')).toBe('small');
    // A hypothetical name containing both tokens: backdrop-tier wins, matching
    // the historical check order.
    expect(sidecarBlurhashSizeForFilename('/x/poster_thumbnail.jpg')).toBe('small');
  });

  it('the two sidecar entry points agree for every conventional slot', () => {
    const pairs = [
      ['backdrop', '/tv/S/show_backdrop.jpg'],
      ['poster', '/tv/S/show_poster.jpg'],
      ['logo', '/tv/S/show_logo.svg'],
      ['season-poster', '/tv/S/Season 1/season_poster.jpg'],
      ['episode-thumbnail', '/tv/S/Season 1/01 - Thumbnail.jpg'],
    ];
    for (const [imageType, filename] of pairs) {
      expect(sidecarBlurhashSizeForFilename(filename)).toBe(sidecarBlurhashSizeForImageType(imageType));
    }
  });
});

describe('TMDB-proxy policy (embedded response blurhashes)', () => {
  it('freezes the as-built sizes, including the deliberate poster divergence', () => {
    expect(TMDB_PROXY_BLURHASH_SIZES).toEqual({
      detailsPoster: 'large', // divergent: sidecar posters are 'medium'
      detailsBackdrop: 'small',
      detailsLogo: 'large',
      imagesBackdropCollection: 'medium',
      imagesPosterCollection: 'large',
      imagesLogoCollection: 'large',
      collectionPartPoster: 'large',
      collectionPartBackdrop: 'small',
      searchResultPoster: 'small',
    });
  });

  it('is frozen — accidental mutation throws or is ignored, never persists', () => {
    expect(Object.isFrozen(TMDB_PROXY_BLURHASH_SIZES)).toBe(true);
  });
});
