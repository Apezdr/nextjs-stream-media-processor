/**
 * Identity is DERIVED from the library-relative folder path, then PERSISTED to
 * a sidecar on the media volume. Derivation makes it self-healing; persistence
 * makes it rename-proof. These tests pin both halves, and in particular the
 * property the whole design exists for: losing the database costs a rescan and
 * never a user's watch history.
 */

import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { join } from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import {
  deriveMediaId,
  episodeMediaId,
  filenameFromUrl,
  readIdentitySidecar,
  resolveMediaIdentity,
  repointMediaIdentity,
  IDENTITY_SIDECAR,
  IDENTITY_SIDECAR_VERSION,
} from '../../../utils/mediaIdentity.mjs';

let tmpRoot;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(os.tmpdir(), `media-identity-${randomUUID()}-`));
});

afterAll(async () => {
  // Each test gets its own root; nothing shared to tear down beyond the OS tmp
  // sweep, but clean the last one to be tidy.
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function makeDir(rel) {
  const dir = join(tmpRoot, rel);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe('deriveMediaId', () => {
  it('is deterministic and prefixed', () => {
    const a = deriveMediaId('movies/Dune (2021)');
    expect(a).toBe(deriveMediaId('movies/Dune (2021)'));
    expect(a).toMatch(/^mid:[0-9a-f]{16}$/);
  });

  it('distinguishes different titles', () => {
    expect(deriveMediaId('movies/Dune (2021)')).not.toBe(deriveMediaId('movies/Dune (1984)'));
  });

  it('normalizes separators so Windows and Linux agree', () => {
    // A host migration must not fork watch history.
    expect(deriveMediaId('movies\\Dune (2021)')).toBe(deriveMediaId('movies/Dune (2021)'));
  });

  it('ignores a trailing separator', () => {
    expect(deriveMediaId('movies/Dune (2021)/')).toBe(deriveMediaId('movies/Dune (2021)'));
  });
});

describe('episodeMediaId', () => {
  it('composes show id with a padded coordinate', () => {
    expect(episodeMediaId('mid:abc123', 1, 3)).toBe('mid:abc123:s01e03');
  });

  it('normalizes padded and unpadded input identically', () => {
    expect(episodeMediaId('mid:abc123', '01', '03')).toBe(episodeMediaId('mid:abc123', 1, 3));
  });

  it('is independent of the episode filename', () => {
    // The point: a remux or re-release renames the file, identity must not move.
    expect(episodeMediaId('mid:abc123', 1, 3)).toBe('mid:abc123:s01e03');
  });
});

describe('filenameFromUrl', () => {
  it('round-trips an encoded basename', () => {
    expect(filenameFromUrl('/media/movies/Dune%20(2021)/Dune.2021.mkv')).toBe('Dune.2021.mkv');
  });

  it('strips a cache-bust query', () => {
    expect(filenameFromUrl('/media/movies/X/Y.mp4?hash=abc')).toBe('Y.mp4');
  });

  it('returns null for absent input', () => {
    expect(filenameFromUrl(null)).toBeNull();
    expect(filenameFromUrl(undefined)).toBeNull();
    expect(filenameFromUrl('')).toBeNull();
  });
});

describe('resolveMediaIdentity', () => {
  it('establishes identity and writes a sidecar', async () => {
    const dir = await makeDir('movies/Dune (2021)');
    const r = await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/Dune (2021)',
      primarySourceHint: 'Dune.2021.mkv',
    });

    expect(r.id).toBe(deriveMediaId('movies/Dune (2021)'));
    expect(r.origin).toBe('established');

    const written = JSON.parse(await fs.readFile(join(dir, IDENTITY_SIDECAR), 'utf8'));
    expect(written.v).toBe(IDENTITY_SIDECAR_VERSION);
    expect(written.id).toBe(r.id);
    expect(written.primarySource).toBe('Dune.2021.mkv');
    expect(written.previousIds).toEqual([]);
  });

  it('reads back the same id on a second pass without rewriting', async () => {
    const dir = await makeDir('movies/Dune (2021)');
    const first = await resolveMediaIdentity({ dir, libraryRelativePath: 'movies/Dune (2021)' });
    const mtimeBefore = (await fs.stat(join(dir, IDENTITY_SIDECAR))).mtimeMs;

    const second = await resolveMediaIdentity({ dir, libraryRelativePath: 'movies/Dune (2021)' });

    expect(second.id).toBe(first.id);
    expect(second.origin).toBe('sidecar');
    // Rewriting every pass would churn the file's mtime for no reason.
    expect((await fs.stat(join(dir, IDENTITY_SIDECAR))).mtimeMs).toBe(mtimeBefore);
  });

  it('SURVIVES A FOLDER RENAME — the reason the id is persisted, not just derived', async () => {
    const before = await makeDir('movies/Dune 2021');
    const established = await resolveMediaIdentity({ dir: before, libraryRelativePath: 'movies/Dune 2021' });

    // Rename the folder, sidecar travels with it.
    const after = join(tmpRoot, 'movies', 'Dune (2021)');
    await fs.rename(before, after);

    const resolved = await resolveMediaIdentity({ dir: after, libraryRelativePath: 'movies/Dune (2021)' });

    expect(resolved.id).toBe(established.id);
    // Pure path-derivation would have produced a different id here.
    expect(resolved.id).not.toBe(deriveMediaId('movies/Dune (2021)'));
  });

  it('SELF-HEALS when the sidecar is deleted and the folder is unchanged', async () => {
    const dir = await makeDir('movies/Dune (2021)');
    const first = await resolveMediaIdentity({ dir, libraryRelativePath: 'movies/Dune (2021)' });

    await fs.rm(join(dir, IDENTITY_SIDECAR));

    const second = await resolveMediaIdentity({ dir, libraryRelativePath: 'movies/Dune (2021)' });
    expect(second.id).toBe(first.id);
  });

  it('does NOT overwrite an unreadable sidecar', async () => {
    const dir = await makeDir('movies/Dune (2021)');
    const path = join(dir, IDENTITY_SIDECAR);
    await fs.writeFile(path, '{ this is not json');

    const r = await resolveMediaIdentity({ dir, libraryRelativePath: 'movies/Dune (2021)' });

    // Derives for this pass so the scan proceeds...
    expect(r.id).toBe(deriveMediaId('movies/Dune (2021)'));
    expect(r.origin).toBe('derived-unwritable');
    // ...but leaves the file alone: it may be recoverable, and it is the only
    // durable copy of an id watch history depends on.
    expect(await fs.readFile(path, 'utf8')).toBe('{ this is not json');
  });

  it('does not overwrite a sidecar from a future version', async () => {
    const dir = await makeDir('movies/Dune (2021)');
    const path = join(dir, IDENTITY_SIDECAR);
    const future = JSON.stringify({ v: 99, id: 'mid:futureformat' });
    await fs.writeFile(path, future);

    const r = await resolveMediaIdentity({ dir, libraryRelativePath: 'movies/Dune (2021)' });
    expect(r.origin).toBe('derived-unwritable');
    expect(await fs.readFile(path, 'utf8')).toBe(future);
  });

  it('seeds primarySource once and never recomputes it', async () => {
    const dir = await makeDir('movies/Mixed');
    await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/Mixed',
      primarySourceHint: 'Mixed.SecondFile.mp4',
    });

    // A later pass offering a different primary must NOT repoint it: the
    // published URL, and with it the legacy watch-history key, would drift.
    const second = await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/Mixed',
      primarySourceHint: 'Mixed.FirstFile.mp4',
    });

    expect(second.primarySource).toBe('Mixed.SecondFile.mp4');
  });

  it('backfills primarySource when it was never recorded', async () => {
    const dir = await makeDir('movies/NoPrimary');
    await resolveMediaIdentity({ dir, libraryRelativePath: 'movies/NoPrimary' });

    const second = await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/NoPrimary',
      primarySourceHint: 'NoPrimary.mkv',
    });

    expect(second.primarySource).toBe('NoPrimary.mkv');
    const written = JSON.parse(await fs.readFile(join(dir, IDENTITY_SIDECAR), 'utf8'));
    expect(written.primarySource).toBe('NoPrimary.mkv');
  });
});

describe('repointMediaIdentity', () => {
  it('re-derives and records the displaced id', async () => {
    const dir = await makeDir('movies/Copy of Dune');
    // Simulate a copied folder carrying another title's sidecar.
    await fs.writeFile(
      join(dir, IDENTITY_SIDECAR),
      JSON.stringify({
        v: IDENTITY_SIDECAR_VERSION,
        id: 'mid:0000000000000001',
        primarySource: 'Dune.mkv',
        firstSeen: '2020-01-01T00:00:00.000Z',
        previousIds: [],
      })
    );

    const newId = await repointMediaIdentity({
      dir,
      libraryRelativePath: 'movies/Copy of Dune',
    });

    expect(newId).toBe(deriveMediaId('movies/Copy of Dune'));

    const written = JSON.parse(await fs.readFile(join(dir, IDENTITY_SIDECAR), 'utf8'));
    expect(written.id).toBe(newId);
    expect(written.previousIds).toContain('mid:0000000000000001');
    // Unrelated state is carried across, not reset.
    expect(written.primarySource).toBe('Dune.mkv');
    expect(written.firstSeen).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('database-loss drill', () => {
  it('reproduces every id from the media volume alone', async () => {
    // Build a small library and establish identity, as a scan would.
    const titles = ['movies/Dune (2021)', 'movies/Arrival', 'tv/Breaking Bad'];
    const established = {};
    for (const rel of titles) {
      const dir = await makeDir(rel);
      established[rel] = (await resolveMediaIdentity({ dir, libraryRelativePath: rel })).id;
    }

    // Rename one folder AFTER identity was established — this is the case a
    // pure path-derived scheme cannot recover, and the sidecar can.
    await fs.rename(join(tmpRoot, 'movies', 'Arrival'), join(tmpRoot, 'movies', 'Arrival (2016)'));
    const renamed = 'movies/Arrival (2016)';

    // Now: the database is gone. Nothing survives but the media volume.
    // Re-resolve everything from scratch.
    const recovered = {};
    for (const rel of ['movies/Dune (2021)', renamed, 'tv/Breaking Bad']) {
      const dir = join(tmpRoot, rel);
      recovered[rel] = (await resolveMediaIdentity({ dir, libraryRelativePath: rel })).id;
    }

    expect(recovered['movies/Dune (2021)']).toBe(established['movies/Dune (2021)']);
    expect(recovered['tv/Breaking Bad']).toBe(established['tv/Breaking Bad']);
    // The renamed folder keeps the id it had before the rename.
    expect(recovered[renamed]).toBe(established['movies/Arrival']);
  });

  it('episode ids are stable across a database loss too', async () => {
    const dir = await makeDir('tv/Breaking Bad');
    const showId = (await resolveMediaIdentity({ dir, libraryRelativePath: 'tv/Breaking Bad' })).id;
    const before = episodeMediaId(showId, 1, 3);

    // DB gone; re-resolve from the sidecar.
    const recoveredShowId = (
      await resolveMediaIdentity({ dir, libraryRelativePath: 'tv/Breaking Bad' })
    ).id;

    expect(episodeMediaId(recoveredShowId, 1, 3)).toBe(before);
  });
});

describe('readIdentitySidecar', () => {
  it('reports a missing sidecar as absent, not unreadable', async () => {
    const dir = await makeDir('movies/Nothing');
    const r = await readIdentitySidecar(dir);
    expect(r.data).toBeNull();
    expect(r.unreadable).toBe(false);
  });

  it('reports a corrupt sidecar as unreadable', async () => {
    const dir = await makeDir('movies/Corrupt');
    await fs.writeFile(join(dir, IDENTITY_SIDECAR), 'nope');
    const r = await readIdentitySidecar(dir);
    expect(r.data).toBeNull();
    expect(r.unreadable).toBe(true);
  });
});
