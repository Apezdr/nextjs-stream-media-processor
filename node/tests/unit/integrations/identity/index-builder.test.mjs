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

describe('fingerprints (the change detector)', () => {
  class ItemProvider extends IdentityProvider {
    constructor(name, items, { fail = null } = {}) {
      super({ name, mediaTypes: ['movie'] });
      this.items = items;
      this.fail = fail;
    }

    async fetchClaims() {
      if (this.fail) throw this.fail;
      return this.items.map((item) =>
        this.makeClaim({ mediaType: 'movie', libraryRelativePath: `movies/${item.folder}`, tmdbId: item.tmdbId, hasFile: item.hasFile, providerPath: `/root/${item.folder}`, title: item.title })
      );
    }
  }

  const base = [
    { folder: 'The End!', tmdbId: 464737, hasFile: false, title: 'The End?' },
    { folder: 'Dune (2021)', tmdbId: 438631, hasFile: true, title: 'Dune' },
  ];

  it('is stable across order and fields outside (path, tmdbId, hasFile)', async () => {
    const a = await buildIdentityIndex([new ItemProvider('radarr', base)]);
    const reordered = await buildIdentityIndex([new ItemProvider('radarr', [...base].reverse())]);
    const retitled = await buildIdentityIndex([new ItemProvider('radarr', base.map((i) => ({ ...i, title: i.title.toUpperCase(), monitored: false })))]);
    expect(reordered.fingerprint).toBe(a.fingerprint);
    expect(retitled.fingerprint).toBe(a.fingerprint);
    expect(a.allOk).toBe(true);
    expect(a.providers[0].fingerprint).toHaveLength(40);
  });

  it('moves when a path or hasFile changes (the production case: Radarr repointed and rescanned)', async () => {
    const before = await buildIdentityIndex([new ItemProvider('radarr', base)]);
    const repointed = base.map((i) => (i.tmdbId === 464737 ? { ...i, folder: 'The End?', hasFile: true } : i));
    const after = await buildIdentityIndex([new ItemProvider('radarr', repointed)]);
    expect(after.fingerprint).not.toBe(before.fingerprint);

    const onlyHasFile = base.map((i) => (i.tmdbId === 464737 ? { ...i, hasFile: true } : i));
    expect((await buildIdentityIndex([new ItemProvider('radarr', onlyHasFile)])).fingerprint).not.toBe(before.fingerprint);
  });

  it('a failed provider records the failure on lastFetch and never yields a stable fingerprint', async () => {
    const provider = new ItemProvider('radarr', base, { fail: new Error('HTTP 503') });
    const a = await buildIdentityIndex([provider]);
    const b = await buildIdentityIndex([provider]);
    expect(provider.lastFetch).toMatchObject({ ok: false, error: 'HTTP 503', claims: 0 });
    expect(a.allOk).toBe(false);
    expect(a.coveredTypes.has('movie')).toBe(false);
    expect(a.providers[0].fingerprint).toBeNull();
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('a success after a failure replaces the failure record', async () => {
    const provider = new ItemProvider('radarr', base, { fail: new Error('down') });
    await buildIdentityIndex([provider]);
    provider.fail = null;
    const index = await buildIdentityIndex([provider]);
    expect(provider.lastFetch).toMatchObject({ ok: true, claims: 2 });
    expect(provider.lastFetch.error).toBeUndefined();
    expect(index.coveredTypes.has('movie')).toBe(true);
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
