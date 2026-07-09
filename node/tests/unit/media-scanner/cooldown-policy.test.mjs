/**
 * Unit tests for the shared post-attempt cooldown decision table
 * (Branch 3, R-1/G-1a) consumed by both the movie and TV scanners.
 * Pure function — no mocks needed.
 */

import { describe, it, expect } from '@jest/globals';
import { resolveCooldownAction } from '../../../components/media-scanner/domain/cooldown-policy.mjs';

describe('resolveCooldownAction', () => {
  it('metadata still missing + frozen with no overrides → clear (paused is not failing)', () => {
    expect(resolveCooldownAction({
      metadataStillMissing: true,
      imagesStillMissing: true,
      frozen: true,
      hasOverrides: false,
    })).toBe('clear');
  });

  it('metadata still missing + frozen WITH overrides → mark (24h-pace the no-op merge)', () => {
    expect(resolveCooldownAction({
      metadataStillMissing: true,
      imagesStillMissing: false,
      frozen: true,
      hasOverrides: true,
    })).toBe('mark');
  });

  it('metadata still missing + not frozen (no-match / transient / any failure) → mark', () => {
    expect(resolveCooldownAction({
      metadataStillMissing: true,
      imagesStillMissing: false,
      frozen: false,
      hasOverrides: false,
    })).toBe('mark');
    expect(resolveCooldownAction({
      metadataStillMissing: true,
      imagesStillMissing: true,
      frozen: false,
      hasOverrides: true,
    })).toBe('mark');
  });

  it('metadata present + images present → clear (fully resolved)', () => {
    expect(resolveCooldownAction({
      metadataStillMissing: false,
      imagesStillMissing: false,
      frozen: false,
      hasOverrides: false,
    })).toBe('clear');
  });

  it('metadata present + images still missing → none (images path has its own gate)', () => {
    expect(resolveCooldownAction({
      metadataStillMissing: false,
      imagesStillMissing: true,
      frozen: false,
      hasOverrides: false,
    })).toBe('none');
    // Frozen verdict is irrelevant once metadata is present.
    expect(resolveCooldownAction({
      metadataStillMissing: false,
      imagesStillMissing: true,
      frozen: true,
      hasOverrides: true,
    })).toBe('none');
  });
});
