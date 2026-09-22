/**
 * The per-tick index: providers are isolated from each other, and when two
 * of them claim one folder with different ids the earlier one wins and the
 * disagreement is kept, not silently resolved.
 */
import { describe, it, expect } from '@jest/globals';
import { IdentityProvider } from '../../../../integrations/identity/provider.mjs';
import { buildIdentityIndex, IdentityIndex } from '../../../../integrations/identity/index-builder.mjs';

class FakeProvider extends IdentityProvider {
  constructor(name, mediaType, claims, { fail = null } = {}) {
    super({ name, mediaTypes: [mediaType] });
    this.mediaType = mediaType;
    this.claims = claims;
    this.fail = fail;
  }

  async fetchClaims() {
    if (this.fail) throw this.fail;
    return this.claims.map(([folder, tmdbId]) =>
      this.makeClaim({ mediaType: this.mediaType, libraryRelativePath: `${this.mediaType === 'movie' ? 'movies' : 'tv'}/${folder}`, tmdbId })
    );
  }
}

describe('buildIdentityIndex', () => {
  it('merges claims across providers and media types', async () => {
    const index = await buildIdentityIndex([
      new FakeProvider('radarr', 'movie', [['Dune (2021)', 438631]]),
      new FakeProvider('sonarr', 'tv', [['Kingdom (2019)', 83097]]),
    ]);
    expect(index.size).toBe(2);
    expect(index.get('movies/Dune (2021)')).toMatchObject({ tmdbId: 438631, source: 'radarr' });
    expect(index.get('tv/Kingdom (2019)')).toMatchObject({ tmdbId: 83097, source: 'sonarr' });
    expect(index.get('movies/Nope')).toBeNull();
    expect(index.claimsFor('tv')).toHaveLength(1);
    expect(index.hasData).toBe(true);
    expect(index.providers.map((p) => p.ok)).toEqual([true, true]);
  });

  it('a failing provider contributes nothing and is recorded; the others still count', async () => {
    const index = await buildIdentityIndex([
      new FakeProvider('radarr', 'movie', [], { fail: new Error('ECONNREFUSED') }),
      new FakeProvider('sonarr', 'tv', [['Kingdom (2019)', 83097]]),
    ]);
    expect(index.size).toBe(1);
    expect(index.providers[0]).toMatchObject({ name: 'radarr', ok: false, error: 'ECONNREFUSED', claims: 0 });
    expect(index.providers[1]).toMatchObject({ name: 'sonarr', ok: true, claims: 1 });
    expect(index.hasData).toBe(true);
  });

  it('every provider failing → hasData is false so the reconciler leaves the library alone', async () => {
    const index = await buildIdentityIndex([
      new FakeProvider('radarr', 'movie', [], { fail: new Error('down') }),
    ]);
    expect(index.hasData).toBe(false);
    expect(index.size).toBe(0);
  });

  it('first provider wins a disagreement and the conflict is kept', async () => {
    const index = await buildIdentityIndex([
      new FakeProvider('radarr', 'movie', [['Dune (2021)', 438631]]),
      new FakeProvider('other', 'movie', [['Dune (2021)', 999], ['Arrival (2016)', 329865]]),
    ]);
    expect(index.get('movies/Dune (2021)').source).toBe('radarr');
    expect(index.get('movies/Arrival (2016)').source).toBe('other');
    expect(index.providerConflicts).toEqual([
      { libraryRelativePath: 'movies/Dune (2021)', kept: { source: 'radarr', tmdbId: 438631 }, dropped: { source: 'other', tmdbId: 999 } },
    ]);
  });

  it('agreeing providers produce no conflict', async () => {
    const index = await buildIdentityIndex([
      new FakeProvider('radarr', 'movie', [['Dune (2021)', 438631]]),
      new FakeProvider('other', 'movie', [['Dune (2021)', 438631]]),
    ]);
    expect(index.providerConflicts).toEqual([]);
    expect(index.size).toBe(1);
  });

  it('an empty provider list yields an empty index with no data', async () => {
    const index = await buildIdentityIndex([]);
    expect(index).toBeInstanceOf(IdentityIndex);
    expect(index.hasData).toBe(false);
    expect(index.summary()).toMatchObject({ size: 0, providers: [], providerConflicts: 0 });
  });
});

describe('IdentityProvider contract guards', () => {
  it('rejects reserved and malformed names', () => {
    expect(() => new FakeProvider('manual', 'movie', [])).toThrow(/reserved/);
    expect(() => new FakeProvider('auto', 'movie', [])).toThrow(/reserved/);
    expect(() => new FakeProvider('Radarr', 'movie', [])).toThrow(/lowercase token/);
    expect(() => new FakeProvider('ok', 'music', [])).toThrow(/unknown media type/);
  });

  it('a provider without parseWebhook does not claim webhook support', () => {
    expect(new FakeProvider('plain', 'movie', []).supportsWebhook).toBe(false);
  });
});
