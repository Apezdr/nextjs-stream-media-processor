/**
 * Unit tests for the tmdb.config accessors — pinned around G-2 (decided
 * 2026-07-07): presence of the `metadata` key is an explicit override opt-in,
 * distinct from truthiness. `hasMetadataOverrideKey()` is the single source of
 * truth for "is this title override-managed"; these tests pin the exact cases
 * truthiness checks collapse ({} and absent).
 */
import { describe, it, expect } from '@jest/globals';
import {
  hasMetadataOverrideKey,
  getMetadataOverrides,
  validateTmdbConfig,
} from '../../../utils/tmdbConfig.mjs';

describe('hasMetadataOverrideKey (G-2 presence-based opt-in)', () => {
  it('absent key → not override-managed', () => {
    expect(hasMetadataOverrideKey({ update_metadata: false })).toBe(false);
    expect(hasMetadataOverrideKey({})).toBe(false);
  });

  it('present key is an opt-in even when empty or falsy — the case truthiness collapses', () => {
    expect(hasMetadataOverrideKey({ metadata: {} })).toBe(true);
    expect(hasMetadataOverrideKey({ metadata: null })).toBe(true);
  });

  it('present populated key → override-managed', () => {
    expect(hasMetadataOverrideKey({ metadata: { overview: 'Manual' } })).toBe(true);
  });

  it('tolerates non-object configs (fail-closed)', () => {
    expect(hasMetadataOverrideKey(null)).toBe(false);
    expect(hasMetadataOverrideKey(undefined)).toBe(false);
  });

  it('diverges from getMetadataOverrides truthiness exactly on present-but-falsy values', () => {
    const present = { metadata: null };
    expect(getMetadataOverrides(present)).toBe(null); // truthiness: "no overrides"
    expect(hasMetadataOverrideKey(present)).toBe(true); // presence: "override-managed"
  });
});

describe('validateTmdbConfig preserves the metadata key', () => {
  it('a present-but-empty metadata key survives validation (presence must not be normalized away)', () => {
    const validated = validateTmdbConfig({ update_metadata: false, metadata: {} });
    expect(hasMetadataOverrideKey(validated)).toBe(true);
    expect(validated.metadata).toEqual({});
  });

  it('an absent metadata key is not injected by defaults', () => {
    const validated = validateTmdbConfig({ update_metadata: false });
    expect(hasMetadataOverrideKey(validated)).toBe(false);
  });
});
