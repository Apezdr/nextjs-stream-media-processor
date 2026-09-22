/**
 * tmdb.config identity provenance — `tmdb_id_source` and the precedence rule.
 *
 * Pins the table in resolveIdentityPin's doc comment row by row, then drives
 * the real file writer against a temp tree for the two properties the rest of
 * the pipeline depends on: a `write` moves the mtime (so the scanner sees an
 * operator-style edit) and a `stamp` does not (so bookkeeping never triggers a
 * repull). Also pins the operator-write rule that stops the admin PUT from
 * echoing a provider's source back over a human correction.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  IDENTITY_SOURCE_AUTO,
  IDENTITY_SOURCE_MANUAL,
  validateTmdbConfig,
  getIdentityProvenance,
  resolveIdentityPin,
  pinTmdbIdentity,
  updateTmdbConfigWithId,
  loadTmdbConfig,
  saveTmdbConfig,
  stampProvenanceForOperatorWrite,
} from '../../../utils/tmdbConfig.mjs';

describe('validateTmdbConfig: tmdb_id_source', () => {
  it('keeps a valid token beside an id, trimmed', () => {
    expect(validateTmdbConfig({ tmdb_id: 5, tmdb_id_source: ' radarr ' }).tmdb_id_source).toBe('radarr');
    expect(validateTmdbConfig({ tmdb_id: 5, tmdb_id_source: 'manual' }).tmdb_id_source).toBe('manual');
  });

  it('drops a source with no id (provenance of nothing)', () => {
    expect(validateTmdbConfig({ tmdb_id_source: 'radarr' })).not.toHaveProperty('tmdb_id_source');
    expect(validateTmdbConfig({ tmdb_id: -1, tmdb_id_source: 'radarr' })).not.toHaveProperty('tmdb_id_source');
  });

  it('drops anything that is not a plain token', () => {
    for (const bad of ['', 'Radarr!', 42, null, 'has space', 'x'.repeat(40)]) {
      expect(validateTmdbConfig({ tmdb_id: 5, tmdb_id_source: bad })).not.toHaveProperty('tmdb_id_source');
    }
  });

  it('does not inject a source by default', () => {
    expect(validateTmdbConfig({ tmdb_id: 5 })).not.toHaveProperty('tmdb_id_source');
  });
});

describe('getIdentityProvenance', () => {
  it('no id → no provenance', () => {
    expect(getIdentityProvenance({})).toEqual({ tmdbId: null, source: null });
    expect(getIdentityProvenance({ tmdb_id: 0 })).toEqual({ tmdbId: null, source: null });
  });

  it('a legacy pin with no source reads as manual by default', () => {
    expect(getIdentityProvenance({ tmdb_id: 9327 })).toEqual({ tmdbId: 9327, source: 'manual' });
  });

  it('the unsourced treatment can be widened to auto, and only to auto', () => {
    expect(getIdentityProvenance({ tmdb_id: 9327 }, { unsourcedPinTreatment: 'auto' }).source).toBe('auto');
    expect(getIdentityProvenance({ tmdb_id: 9327 }, { unsourcedPinTreatment: 'bogus' }).source).toBe('manual');
  });

  it('an explicit source is returned as-is', () => {
    expect(getIdentityProvenance({ tmdb_id: 1, tmdb_id_source: 'sonarr' }).source).toBe('sonarr');
    expect(getIdentityProvenance({ tmdb_id: 1, tmdb_id_source: 'auto' }, { unsourcedPinTreatment: 'auto' }).source).toBe('auto');
  });
});

describe('resolveIdentityPin: the precedence table', () => {
  const radarr = (tmdbId) => ({ tmdbId, source: 'radarr' });
  const search = (tmdbId) => ({ tmdbId, source: IDENTITY_SOURCE_AUTO });

  it('nothing stored + provider id → write id + source', () => {
    expect(resolveIdentityPin({}, radarr(467956))).toMatchObject({ action: 'write', tmdbId: 467956, source: 'radarr', storedId: null });
  });

  it('nothing stored + search result → write id with source=auto (today\'s behaviour, now stamped)', () => {
    expect(resolveIdentityPin({}, search(9327))).toMatchObject({ action: 'write', tmdbId: 9327, source: 'auto' });
  });

  it('manual pin + same id → keep', () => {
    expect(resolveIdentityPin({ tmdb_id: 1, tmdb_id_source: 'manual' }, radarr(1))).toMatchObject({ action: 'keep', reason: 'manual-pin-agrees' });
  });

  it('manual pin + different id → conflict, never a write', () => {
    const d = resolveIdentityPin({ tmdb_id: 9327, tmdb_id_source: 'manual' }, radarr(467956));
    expect(d).toMatchObject({ action: 'conflict', storedId: 9327, storedSource: 'manual', tmdbId: 467956, source: 'radarr' });
  });

  it('legacy pin with no source behaves as manual (the safe default)', () => {
    expect(resolveIdentityPin({ tmdb_id: 9327 }, radarr(467956)).action).toBe('conflict');
  });

  it('legacy pin with no source is repairable only when the operator opts in', () => {
    const d = resolveIdentityPin({ tmdb_id: 9327 }, radarr(467956), { unsourcedPinTreatment: 'auto' });
    expect(d).toMatchObject({ action: 'write', tmdbId: 467956, storedId: 9327, storedSource: 'auto' });
  });

  it('auto pin + same provider id → stamp source only', () => {
    expect(resolveIdentityPin({ tmdb_id: 1, tmdb_id_source: 'auto' }, radarr(1))).toMatchObject({ action: 'stamp', source: 'radarr', tmdbId: 1 });
  });

  it('auto pin + different provider id → write (the wrong-match repair)', () => {
    const d = resolveIdentityPin({ tmdb_id: 9327, tmdb_id_source: 'auto' }, radarr(467956));
    expect(d).toMatchObject({ action: 'write', tmdbId: 467956, source: 'radarr', storedId: 9327, storedSource: 'auto' });
  });

  it('auto pin + another search result → keep (a search never overwrites anything)', () => {
    expect(resolveIdentityPin({ tmdb_id: 9327, tmdb_id_source: 'auto' }, search(467956))).toMatchObject({ action: 'keep', reason: 'search-never-overwrites' });
  });

  it('provider-owned pin + same provider, same id → keep (nothing to stamp)', () => {
    expect(resolveIdentityPin({ tmdb_id: 1, tmdb_id_source: 'radarr' }, radarr(1))).toMatchObject({ action: 'keep', reason: 'provider-agrees' });
  });

  it('provider-owned pin + that provider changed its mind → follow the provider', () => {
    expect(resolveIdentityPin({ tmdb_id: 1, tmdb_id_source: 'radarr' }, radarr(2))).toMatchObject({ action: 'write', tmdbId: 2 });
  });

  it('an invalid incoming id is ignored', () => {
    expect(resolveIdentityPin({}, { tmdbId: 0, source: 'radarr' }).action).toBe('keep');
    expect(resolveIdentityPin({}, { tmdbId: 'abc', source: 'radarr' }).action).toBe('keep');
  });

  it('an incoming claim with no source is treated as a search result', () => {
    expect(resolveIdentityPin({}, { tmdbId: 5 })).toMatchObject({ action: 'write', source: 'auto' });
    expect(resolveIdentityPin({ tmdb_id: 4, tmdb_id_source: 'auto' }, { tmdbId: 5 }).action).toBe('keep');
  });
});

describe('pinTmdbIdentity / updateTmdbConfigWithId against a real tmdb.config', () => {
  const root = join(tmpdir(), `tmdb-config-identity-${randomUUID()}`);
  const OLD = new Date('2020-01-01T00:00:00Z');

  async function freshDir(name) {
    const dir = join(root, name);
    await fs.mkdir(dir, { recursive: true });
    return { dir, configPath: join(dir, 'tmdb.config') };
  }

  async function ageFile(p) {
    await fs.utimes(p, OLD, OLD);
    return (await fs.stat(p)).mtimeMs;
  }

  beforeAll(async () => { await fs.mkdir(root, { recursive: true }); });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('the search ratchet writes id + source=auto when the file is absent', async () => {
    const { configPath } = await freshDir('search-adds');
    await updateTmdbConfigWithId(configPath, 9327, 'The Professor');
    const config = await loadTmdbConfig(configPath);
    expect(config).toMatchObject({ tmdb_id: 9327, tmdb_id_source: 'auto', update_metadata: true });
  });

  it('a second search result never changes an existing pin (the ratchet holds)', async () => {
    const { configPath } = await freshDir('search-ratchet');
    await updateTmdbConfigWithId(configPath, 9327, 'x');
    const before = await ageFile(configPath);
    await updateTmdbConfigWithId(configPath, 467956, 'x');
    expect((await loadTmdbConfig(configPath)).tmdb_id).toBe(9327);
    expect((await fs.stat(configPath)).mtimeMs).toBe(before); // untouched
  });

  it('a provider replaces an auto pin AND moves the mtime (so the scanner repulls)', async () => {
    const { configPath } = await freshDir('provider-repairs');
    await updateTmdbConfigWithId(configPath, 9327, 'The Professor');
    const before = await ageFile(configPath);
    const { decision } = await pinTmdbIdentity(configPath, { tmdbId: 467956, source: 'radarr' }, { mediaName: 'The Professor' });
    expect(decision.action).toBe('write');
    const after = await loadTmdbConfig(configPath);
    expect(after).toMatchObject({ tmdb_id: 467956, tmdb_id_source: 'radarr' });
    expect((await fs.stat(configPath)).mtimeMs).toBeGreaterThan(before);
  });

  it('a provider agreeing with an auto pin stamps the source WITHOUT moving the mtime', async () => {
    const { configPath } = await freshDir('provider-stamps');
    await updateTmdbConfigWithId(configPath, 467956, 'The Professor');
    const before = await ageFile(configPath);
    const { decision } = await pinTmdbIdentity(configPath, { tmdbId: 467956, source: 'radarr' });
    expect(decision.action).toBe('stamp');
    expect((await loadTmdbConfig(configPath)).tmdb_id_source).toBe('radarr');
    expect((await fs.stat(configPath)).mtimeMs).toBe(before);
  });

  it('a provider never touches a manual pin, and reports the conflict', async () => {
    const { configPath } = await freshDir('manual-wins');
    await saveTmdbConfig(configPath, { tmdb_id: 9327, tmdb_id_source: 'manual', update_metadata: false });
    const before = await ageFile(configPath);
    const { decision } = await pinTmdbIdentity(configPath, { tmdbId: 467956, source: 'radarr' });
    expect(decision).toMatchObject({ action: 'conflict', storedId: 9327, tmdbId: 467956 });
    expect((await loadTmdbConfig(configPath))).toMatchObject({ tmdb_id: 9327, update_metadata: false });
    expect((await fs.stat(configPath)).mtimeMs).toBe(before);
  });

  it('a legacy pin (no source) is left alone by default', async () => {
    const { configPath } = await freshDir('legacy-default');
    await saveTmdbConfig(configPath, { tmdb_id: 9327 });
    const { decision } = await pinTmdbIdentity(configPath, { tmdbId: 467956, source: 'radarr' });
    expect(decision.action).toBe('conflict');
    expect((await loadTmdbConfig(configPath)).tmdb_id).toBe(9327);
  });

  it('a legacy pin is repaired when unsourced pins are read as auto', async () => {
    const { configPath } = await freshDir('legacy-opt-in');
    await saveTmdbConfig(configPath, { tmdb_id: 9327 });
    const { decision } = await pinTmdbIdentity(configPath, { tmdbId: 467956, source: 'radarr' }, { unsourcedPinTreatment: 'auto' });
    expect(decision.action).toBe('write');
    expect((await loadTmdbConfig(configPath))).toMatchObject({ tmdb_id: 467956, tmdb_id_source: 'radarr' });
  });

  it('a write preserves every other key in the file', async () => {
    const { configPath } = await freshDir('preserves-keys');
    await saveTmdbConfig(configPath, { tmdb_id: 9327, tmdb_id_source: 'auto', backdrop_focal: 'left', metadata: { overview: 'x' }, override_poster: '/p.jpg' });
    await pinTmdbIdentity(configPath, { tmdbId: 467956, source: 'radarr' });
    expect(await loadTmdbConfig(configPath)).toMatchObject({
      tmdb_id: 467956, tmdb_id_source: 'radarr', backdrop_focal: 'left', metadata: { overview: 'x' }, override_poster: '/p.jpg',
    });
  });
});

describe('stampProvenanceForOperatorWrite (the admin PUT)', () => {
  it('an id the operator changed becomes manual, whatever the client echoed', () => {
    const next = stampProvenanceForOperatorWrite({ tmdb_id: 9327, tmdb_id_source: 'radarr' }, { tmdb_id: 467956, tmdb_id_source: 'radarr' });
    expect(next.tmdb_id_source).toBe(IDENTITY_SOURCE_MANUAL);
  });

  it('an id the operator added becomes manual', () => {
    expect(stampProvenanceForOperatorWrite({}, { tmdb_id: 1 }).tmdb_id_source).toBe('manual');
    expect(stampProvenanceForOperatorWrite({}, { tmdb_id: 1, tmdb_id_source: 'auto' }).tmdb_id_source).toBe('manual');
  });

  it('an unchanged id keeps its stored source when the client dropped it', () => {
    expect(stampProvenanceForOperatorWrite({ tmdb_id: 1, tmdb_id_source: 'sonarr' }, { tmdb_id: 1 }).tmdb_id_source).toBe('sonarr');
  });

  it('an unchanged id with an explicit client source keeps the client source (round-trip is stable)', () => {
    expect(stampProvenanceForOperatorWrite({ tmdb_id: 1, tmdb_id_source: 'sonarr' }, { tmdb_id: 1, tmdb_id_source: 'sonarr' }).tmdb_id_source).toBe('sonarr');
    expect(stampProvenanceForOperatorWrite({ tmdb_id: 1, tmdb_id_source: 'sonarr' }, { tmdb_id: 1, tmdb_id_source: 'manual' }).tmdb_id_source).toBe('manual');
  });

  it('an unchanged legacy pin stays unsourced (no provenance is invented)', () => {
    expect(stampProvenanceForOperatorWrite({ tmdb_id: 1 }, { tmdb_id: 1 })).not.toHaveProperty('tmdb_id_source');
  });

  it('removing the id removes the source', () => {
    expect(stampProvenanceForOperatorWrite({ tmdb_id: 1, tmdb_id_source: 'radarr' }, { update_metadata: false, tmdb_id_source: 'radarr' })).not.toHaveProperty('tmdb_id_source');
  });

  it('does not mutate its input and preserves other keys', () => {
    const submitted = { tmdb_id: 2, metadata: { overview: 'o' } };
    const next = stampProvenanceForOperatorWrite({ tmdb_id: 1 }, submitted);
    expect(submitted).not.toHaveProperty('tmdb_id_source');
    expect(next).toMatchObject({ tmdb_id: 2, metadata: { overview: 'o' }, tmdb_id_source: 'manual' });
  });
});
