/**
 * The reconciler against a real temp library. Drives the REAL tmdbConfig
 * module so the mtime behaviour is genuine: a repair must move tmdb.config's
 * mtime past metadata.json's (that is how the scanner learns about it), a
 * source stamp must not, and a manual pin must never change.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { IdentityProvider } from '../../../../integrations/identity/provider.mjs';
import { buildIdentityIndex } from '../../../../integrations/identity/index-builder.mjs';
import { reconcileIdentities, reconcileClaim, listLibraryFolders, fingerprintFolders } from '../../../../integrations/identity/reconciler.mjs';
import { loadTmdbConfig, saveTmdbConfig } from '../../../../utils/tmdbConfig.mjs';

class FakeProvider extends IdentityProvider {
  constructor(name, mediaType, claims, { fail = null } = {}) {
    super({ name, mediaTypes: [mediaType] });
    this.mediaType = mediaType;
    this.claims = claims;
    this.fail = fail;
  }

  async fetchClaims() {
    if (this.fail) throw this.fail;
    return this.claims.map(({ folder, tmdbId, hasFile = true, released, arrStatus, monitored }) =>
      this.makeClaim({
        mediaType: this.mediaType,
        libraryRelativePath: `${this.mediaType === 'movie' ? 'movies' : 'tv'}/${folder}`,
        tmdbId,
        hasFile,
        title: folder,
        released,
        arrStatus,
        monitored,
      })
    );
  }
}

const OLD = new Date('2020-01-01T00:00:00Z');
const OLDER = new Date('2019-01-01T00:00:00Z');

describe('reconcileIdentities', () => {
  const basePath = join(tmpdir(), `identity-reconcile-${randomUUID()}`);
  const movieDir = (name) => join(basePath, 'movies', name);
  const tvDir = (name) => join(basePath, 'tv', name);

  async function makeTitle(dir, config = null) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'metadata.json'), '{}');
    await fs.utimes(join(dir, 'metadata.json'), OLD, OLD);
    if (config) {
      await saveTmdbConfig(join(dir, 'tmdb.config'), config);
      await fs.utimes(join(dir, 'tmdb.config'), OLDER, OLDER); // config older than metadata = converged
    }
  }

  const mtime = async (p) => (await fs.stat(p)).mtimeMs;

  beforeAll(async () => {
    // The Professor: wrong auto match, Radarr knows better → repair
    await makeTitle(movieDir('The Professor'), { tmdb_id: 9327, tmdb_id_source: 'auto' });
    // Dune: auto match already right → stamp only
    await makeTitle(movieDir('Dune (2021)'), { tmdb_id: 438631, tmdb_id_source: 'auto' });
    // Arrival: human pinned something Radarr disagrees with → conflict, untouched
    await makeTitle(movieDir('Arrival (2016)'), { tmdb_id: 111, tmdb_id_source: 'manual' });
    // Legacy: pinned before provenance existed, disagrees → conflict by default
    await makeTitle(movieDir('Legacy Pin'), { tmdb_id: 222 });
    // Brand new folder, no config at all → write
    await makeTitle(movieDir('Fresh (2024)'));
    // Hand-added folder Radarr knows nothing about → unmanaged
    await makeTitle(movieDir('Home Video'));
    // Frozen title with a manual pin that agrees → keep, still frozen
    await makeTitle(movieDir('Frozen'), { tmdb_id: 333, tmdb_id_source: 'manual', update_metadata: false });
    // TV
    await makeTitle(tvDir('Kingdom (2019)'), { tmdb_id: 61137, tmdb_id_source: 'auto' }); // the OTHER Kingdom → repair
  });

  afterAll(async () => { await fs.rm(basePath, { recursive: true, force: true }); });

  it('applies the whole table in one pass and reports every bucket', async () => {
    const index = await buildIdentityIndex([
      new FakeProvider('radarr', 'movie', [
        { folder: 'The Professor', tmdbId: 467956 },
        { folder: 'Dune (2021)', tmdbId: 438631 },
        { folder: 'Arrival (2016)', tmdbId: 329865 },
        { folder: 'Legacy Pin', tmdbId: 444 },
        { folder: 'Fresh (2024)', tmdbId: 555 },
        { folder: 'Frozen', tmdbId: 333 },
        { folder: 'Queued Download (2026)', tmdbId: 666, hasFile: false, released: false, arrStatus: 'announced', monitored: true }, // provider-only
      ]),
      new FakeProvider('sonarr', 'tv', [{ folder: 'Kingdom (2019)', tmdbId: 83097 }]),
    ]);

    const professorMtimeBefore = await mtime(join(movieDir('The Professor'), 'tmdb.config'));
    const duneMtimeBefore = await mtime(join(movieDir('Dune (2021)'), 'tmdb.config'));
    const arrivalMtimeBefore = await mtime(join(movieDir('Arrival (2016)'), 'tmdb.config'));

    const report = await reconcileIdentities({ index, basePath, unsourcedPinTreatment: 'manual', reason: 'test' });

    expect(report.totals).toEqual({
      claimed: 8, write: 3, stamp: 1, keep: 1, conflict: 2, providerOnly: 1, unmanaged: 1, nested: 0, errors: 0,
    });
    expect(report.perType).toEqual({ movie: { onDisk: 7, claimed: 7, covered: true }, tv: { onDisk: 1, claimed: 1, covered: true } });

    // The repair: id replaced, source recorded, mtime moved past metadata.json.
    const professor = await loadTmdbConfig(join(movieDir('The Professor'), 'tmdb.config'));
    expect(professor).toMatchObject({ tmdb_id: 467956, tmdb_id_source: 'radarr' });
    const professorMtimeAfter = await mtime(join(movieDir('The Professor'), 'tmdb.config'));
    expect(professorMtimeAfter).toBeGreaterThan(professorMtimeBefore);
    expect(professorMtimeAfter).toBeGreaterThan(await mtime(join(movieDir('The Professor'), 'metadata.json')));

    // The stamp: provenance recorded, mtime untouched, so no repull.
    expect((await loadTmdbConfig(join(movieDir('Dune (2021)'), 'tmdb.config'))).tmdb_id_source).toBe('radarr');
    expect(await mtime(join(movieDir('Dune (2021)'), 'tmdb.config'))).toBe(duneMtimeBefore);

    // Manual pins: untouched, both bytes and mtime.
    expect((await loadTmdbConfig(join(movieDir('Arrival (2016)'), 'tmdb.config'))).tmdb_id).toBe(111);
    expect(await mtime(join(movieDir('Arrival (2016)'), 'tmdb.config'))).toBe(arrivalMtimeBefore);
    expect((await loadTmdbConfig(join(movieDir('Legacy Pin'), 'tmdb.config')))).toEqual(expect.objectContaining({ tmdb_id: 222 }));
    expect((await loadTmdbConfig(join(movieDir('Frozen'), 'tmdb.config')))).toMatchObject({ tmdb_id: 333, update_metadata: false });

    // New folder pinned before the scanner ever searches for it.
    expect(await loadTmdbConfig(join(movieDir('Fresh (2024)'), 'tmdb.config'))).toMatchObject({ tmdb_id: 555, tmdb_id_source: 'radarr' });

    // TV repair too.
    expect(await loadTmdbConfig(join(tvDir('Kingdom (2019)'), 'tmdb.config'))).toMatchObject({ tmdb_id: 83097, tmdb_id_source: 'sonarr' });

    // Report lists.
    expect(report.written.items.map((w) => w.libraryRelativePath).sort()).toEqual(['movies/Fresh (2024)', 'movies/The Professor', 'tv/Kingdom (2019)']);
    expect(report.written.items.find((w) => w.libraryRelativePath === 'movies/The Professor')).toMatchObject({ replacedId: 9327, replacedSource: 'auto' });
    expect(report.conflicts.items.map((c) => c.libraryRelativePath).sort()).toEqual(['movies/Arrival (2016)', 'movies/Legacy Pin']);
    expect(report.conflicts.items.find((c) => c.libraryRelativePath === 'movies/Legacy Pin')).toMatchObject({ storedId: 222, storedSource: 'manual', providerId: 444, source: 'radarr' });
    // The provider-only row forwards the provider's own availability verdict
    // unchanged, so the page can say "not released yet" rather than a generic line.
    expect(report.providerOnly.items).toEqual([
      expect.objectContaining({
        libraryRelativePath: 'movies/Queued Download (2026)', tmdbId: 666, hasFile: false,
        released: false, arrStatus: 'announced', monitored: true,
      }),
    ]);
    expect(report.unmanaged.items).toEqual(['movies/Home Video']);
    expect(report.index.providers).toHaveLength(2);
  });

  it('a second pass is idempotent: nothing left to write or stamp', async () => {
    const index = await buildIdentityIndex([
      new FakeProvider('radarr', 'movie', [
        { folder: 'The Professor', tmdbId: 467956 },
        { folder: 'Dune (2021)', tmdbId: 438631 },
        { folder: 'Fresh (2024)', tmdbId: 555 },
      ]),
    ]);
    const before = await mtime(join(movieDir('The Professor'), 'tmdb.config'));
    const report = await reconcileIdentities({ index, basePath, unsourcedPinTreatment: 'manual' });
    expect(report.totals).toMatchObject({ write: 0, stamp: 0, keep: 3, conflict: 0 });
    expect(await mtime(join(movieDir('The Professor'), 'tmdb.config'))).toBe(before);
  });

  it('IDENTITY_UNSOURCED_PINS=auto repairs the legacy pin, still never the manual one', async () => {
    const index = await buildIdentityIndex([
      new FakeProvider('radarr', 'movie', [
        { folder: 'Legacy Pin', tmdbId: 444 },
        { folder: 'Arrival (2016)', tmdbId: 329865 },
      ]),
    ]);
    const report = await reconcileIdentities({ index, basePath, unsourcedPinTreatment: 'auto' });
    expect(report.totals).toMatchObject({ write: 1, conflict: 1 });
    expect(await loadTmdbConfig(join(movieDir('Legacy Pin'), 'tmdb.config'))).toMatchObject({ tmdb_id: 444, tmdb_id_source: 'radarr' });
    expect((await loadTmdbConfig(join(movieDir('Arrival (2016)'), 'tmdb.config'))).tmdb_id).toBe(111);
  });

  it('a nested mapping can never match a scanned folder and is reported as provider-only', async () => {
    const result = await reconcileClaim(
      { mediaType: 'movie', libraryRelativePath: 'movies/Sub/Deeper', tmdbId: 1, source: 'radarr' },
      { basePath, unsourcedPinTreatment: 'manual' }
    );
    expect(result.outcome).toBe('nested-path');
  });

  it('a claim without availability fields yields null on the provider-only row, never false', async () => {
    const index = await buildIdentityIndex([
      new FakeProvider('radarr', 'movie', [{ folder: 'Ghost (2030)', tmdbId: 777, hasFile: false }]),
    ]);
    const report = await reconcileIdentities({ index, basePath, unsourcedPinTreatment: 'manual' });
    expect(report.providerOnly.items[0]).toMatchObject({ libraryRelativePath: 'movies/Ghost (2030)', released: null, arrStatus: null, monitored: null });
  });

  it('a claim for a folder that does not exist writes nothing', async () => {
    const result = await reconcileClaim(
      { mediaType: 'movie', libraryRelativePath: 'movies/Ghost', tmdbId: 1, source: 'radarr' },
      { basePath, unsourcedPinTreatment: 'manual' }
    );
    expect(result.outcome).toBe('missing-folder');
    await expect(fs.access(movieDir('Ghost'))).rejects.toBeDefined();
  });

  it('a per-folder failure is recorded and does not stop the pass', async () => {
    const index = await buildIdentityIndex([
      new FakeProvider('radarr', 'movie', [
        { folder: 'The Professor', tmdbId: 467956 },
        { folder: 'Dune (2021)', tmdbId: 438631 },
      ]),
    ]);
    const pin = async (configPath) => {
      if (configPath.includes('Dune')) throw new Error('EACCES');
      return { decision: { action: 'keep', reason: 'test' }, config: {} };
    };
    const report = await reconcileIdentities({ index, basePath, unsourcedPinTreatment: 'manual', pin });
    expect(report.totals).toMatchObject({ errors: 1, keep: 1 });
    expect(report.errors.items).toEqual([{ libraryRelativePath: 'movies/Dune (2021)', error: 'EACCES' }]);
  });

  it('a media type whose only provider failed is unknown, not unmanaged', async () => {
    const index = await buildIdentityIndex([
      new FakeProvider('radarr', 'movie', [], { fail: new Error('ECONNREFUSED') }),
      new FakeProvider('sonarr', 'tv', [{ folder: 'Kingdom (2019)', tmdbId: 83097 }]),
    ]);
    const report = await reconcileIdentities({ index, basePath, unsourcedPinTreatment: 'manual' });
    expect(report.perType.movie).toMatchObject({ covered: false, claimed: 0 });
    expect(report.perType.tv).toMatchObject({ covered: true, claimed: 1 });
    expect(report.totals.unmanaged).toBe(0); // seven movie folders, none listed
    expect(report.unmanaged.items).toEqual([]);
    expect(report.index.allOk).toBe(false);
  });

  it('fingerprintFolders moves on a folder rename and nothing else', () => {
    const a = fingerprintFolders({ movie: new Set(['A', 'B']), tv: new Set(['S']) });
    const same = fingerprintFolders({ movie: new Set(['B', 'A']), tv: new Set(['S']) });
    const renamed = fingerprintFolders({ movie: new Set(['A', 'B2']), tv: new Set(['S']) });
    expect(same).toBe(a);
    expect(renamed).not.toBe(a);
  });

  it('listLibraryFolders: a missing root is an empty set, files are ignored', async () => {
    expect(await listLibraryFolders(join(basePath, 'nowhere'), 'movie')).toEqual(new Set());
    await fs.writeFile(join(basePath, 'movies', 'stray.txt'), '');
    const folders = await listLibraryFolders(basePath, 'movie');
    expect(folders.has('stray.txt')).toBe(false);
    expect(folders.has('The Professor')).toBe(true);
  });
});
