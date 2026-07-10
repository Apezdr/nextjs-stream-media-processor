/**
 * Branch 6 (I-5 + I-7a) tests for resolveEffectiveImageUrl() — the single
 * shared implementation of the effective-image-URL precedence consumed by
 * both the downloader (downloadMediaImages) and the generator's reconcile
 * step (_reconcileImageOwnership). Pins:
 *  - precedence: override_<kind> > metadata <kind>_path
 *  - I-7a: values that are already absolute URLs pass through verbatim
 *    (the downloader previously CDN-prefixed overrides unconditionally,
 *    mangling full external URLs)
 *  - bare TMDB paths get the CDN base prefixed, on either tier
 */
import { describe, it, expect } from '@jest/globals';
import { resolveEffectiveImageUrl } from '../../../components/media-scanner/domain/image-conventions.mjs';

const CDN = 'https://image.tmdb.org/t/p/original';

describe('resolveEffectiveImageUrl (I-5 shared precedence)', () => {
  it('override wins over the metadata value', () => {
    const url = resolveEffectiveImageUrl({
      tmdbConfig: { override_poster: '/override.jpg' },
      metadata: { poster_path: '/from-tmdb.jpg' },
      imageKey: 'poster',
    });
    expect(url).toBe(`${CDN}/override.jpg`);
  });

  it('falls back to the metadata value when no override exists', () => {
    const url = resolveEffectiveImageUrl({
      tmdbConfig: { update_metadata: false },
      metadata: { backdrop_path: '/tmdb-backdrop.jpg' },
      imageKey: 'backdrop',
    });
    expect(url).toBe(`${CDN}/tmdb-backdrop.jpg`);
  });

  it('returns null when neither tier has a value', () => {
    expect(
      resolveEffectiveImageUrl({ tmdbConfig: {}, metadata: {}, imageKey: 'logo' })
    ).toBe(null);
  });

  it('tolerates null/undefined config and metadata', () => {
    expect(resolveEffectiveImageUrl({ tmdbConfig: null, metadata: null, imageKey: 'poster' })).toBe(null);
    expect(
      resolveEffectiveImageUrl({
        tmdbConfig: undefined,
        metadata: { poster_path: '/p.jpg' },
        imageKey: 'poster',
      })
    ).toBe(`${CDN}/p.jpg`);
  });
});

describe('full-URL passthrough (I-7a)', () => {
  it('a full-URL override passes through verbatim instead of being CDN-prefixed into garbage', () => {
    const external = 'https://cdn.example.com/art/custom-poster.png';
    const url = resolveEffectiveImageUrl({
      tmdbConfig: { override_poster: external },
      metadata: { poster_path: '/from-tmdb.jpg' },
      imageKey: 'poster',
    });
    expect(url).toBe(external);
  });

  it('plain http URLs and mixed-case schemes pass through too', () => {
    expect(
      resolveEffectiveImageUrl({
        tmdbConfig: { override_logo: 'http://example.com/logo.svg' },
        metadata: null,
        imageKey: 'logo',
      })
    ).toBe('http://example.com/logo.svg');
    expect(
      resolveEffectiveImageUrl({
        tmdbConfig: { override_logo: 'HTTPS://example.com/logo.svg' },
        metadata: null,
        imageKey: 'logo',
      })
    ).toBe('HTTPS://example.com/logo.svg');
  });

  it('a full-URL metadata value passes through as before (fetch pipeline pre-normalizes to full URLs)', () => {
    const normalized = 'https://image.tmdb.org/t/p/original/already-full.jpg';
    expect(
      resolveEffectiveImageUrl({ tmdbConfig: {}, metadata: { backdrop_path: normalized }, imageKey: 'backdrop' })
    ).toBe(normalized);
  });
});
