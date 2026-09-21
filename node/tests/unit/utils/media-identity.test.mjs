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
  episodeSeenKey,
  recordEpisodesFirstSeen,
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

describe('firstSeen — the library-add date', () => {
  // Published as mediaIdentity.firstSeen and folded into the metadata hash, so
  // two properties are load-bearing: it never moves once written, and a value
  // that is not on disk is never handed out as if it were.

  it('reports a durable date once the sidecar is written, and keeps it', async () => {
    const dir = await makeDir('movies/Dated');
    const first = await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/Dated',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(first.durableFirstSeen).toBe('2026-01-01T00:00:00.000Z');

    const second = await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/Dated',
      now: '2026-06-01T00:00:00.000Z',
    });
    expect(second.durableFirstSeen).toBe('2026-01-01T00:00:00.000Z');
    expect(second.firstSeen).toBe('2026-01-01T00:00:00.000Z');
  });

  it('publishes NULL, not "now", when the sidecar cannot be trusted', async () => {
    const dir = await makeDir('movies/Corrupt');
    await fs.writeFile(join(dir, IDENTITY_SIDECAR), '{ not json');

    const result = await resolveMediaIdentity({ dir, libraryRelativePath: 'movies/Corrupt' });
    expect(result.origin).toBe('derived-unwritable');
    expect(result.durableFirstSeen).toBeNull();
  });

  it('SELF-HEALS to the hinted date when the sidecar was deleted', async () => {
    const dir = await makeDir('movies/Healed');
    const result = await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/Healed',
      firstSeenHint: '2024-03-03T00:00:00.000Z',
      now: '2026-09-01T00:00:00.000Z',
    });
    expect(result.durableFirstSeen).toBe('2024-03-03T00:00:00.000Z');

    const written = JSON.parse(await fs.readFile(join(dir, IDENTITY_SIDECAR), 'utf8'));
    expect(written.firstSeen).toBe('2024-03-03T00:00:00.000Z');
  });

  it('never lets a hint override a date already on disk', async () => {
    const dir = await makeDir('movies/Pinned');
    await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/Pinned',
      now: '2025-05-05T00:00:00.000Z',
    });

    const result = await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/Pinned',
      firstSeenHint: '2020-01-01T00:00:00.000Z',
    });
    expect(result.durableFirstSeen).toBe('2025-05-05T00:00:00.000Z');
  });

  it('ignores a hint that is not a timestamp', async () => {
    const dir = await makeDir('movies/BadHint');
    const result = await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/BadHint',
      firstSeenHint: 'yesterday-ish',
      now: '2026-02-02T00:00:00.000Z',
    });
    expect(result.durableFirstSeen).toBe('2026-02-02T00:00:00.000Z');
  });

  it('backfills a sidecar that predates firstSeen, once', async () => {
    const dir = await makeDir('movies/Legacy');
    await fs.writeFile(
      join(dir, IDENTITY_SIDECAR),
      JSON.stringify({ v: IDENTITY_SIDECAR_VERSION, id: 'mid:00000000000000aa', previousIds: [] })
    );

    const first = await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/Legacy',
      now: '2026-04-04T00:00:00.000Z',
    });
    expect(first.id).toBe('mid:00000000000000aa');
    expect(first.durableFirstSeen).toBe('2026-04-04T00:00:00.000Z');

    const second = await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'movies/Legacy',
      now: '2026-08-08T00:00:00.000Z',
    });
    expect(second.durableFirstSeen).toBe('2026-04-04T00:00:00.000Z');
  });
});

describe('per-episode first-seen map', () => {
  it('keys episodes by the same coordinate the episode id uses', () => {
    expect(episodeSeenKey('01', '03')).toBe('s01e03');
    expect(episodeSeenKey(1, 3)).toBe('s01e03');
    expect(episodeMediaId('mid:abc', 1, 3).endsWith(`:${episodeSeenKey(1, 3)}`)).toBe(true);
  });

  it('is SEEDED ONCE — an existing episode is never re-dated', async () => {
    const dir = await makeDir('tv/Seeded');
    await resolveMediaIdentity({ dir, libraryRelativePath: 'tv/Seeded' });

    expect(
      await recordEpisodesFirstSeen({ dir, added: { s01e01: '2026-01-01T00:00:00.000Z' } })
    ).toBe(true);
    // A later pass that (wrongly) believes s01e01 is new must not move it.
    expect(
      await recordEpisodesFirstSeen({
        dir,
        added: { s01e01: '2026-09-09T00:00:00.000Z', s01e02: '2026-09-09T00:00:00.000Z' },
      })
    ).toBe(true);

    const resolved = await resolveMediaIdentity({ dir, libraryRelativePath: 'tv/Seeded' });
    expect(resolved.episodes).toEqual({
      s01e01: '2026-01-01T00:00:00.000Z',
      s01e02: '2026-09-09T00:00:00.000Z',
    });
  });

  it('leaves identity untouched when it extends the map', async () => {
    const dir = await makeDir('tv/Untouched');
    const before = await resolveMediaIdentity({
      dir,
      libraryRelativePath: 'tv/Untouched',
      primarySourceHint: 'x.mkv',
    });
    await recordEpisodesFirstSeen({ dir, added: { s02e05: '2026-05-05T00:00:00.000Z' } });

    const after = await resolveMediaIdentity({ dir, libraryRelativePath: 'tv/Untouched' });
    expect(after.id).toBe(before.id);
    expect(after.durableFirstSeen).toBe(before.durableFirstSeen);
    expect(after.primarySource).toBe('x.mkv');
  });

  it('reports failure when there is no trustworthy sidecar to extend', async () => {
    const dir = await makeDir('tv/NoSidecar');
    expect(
      await recordEpisodesFirstSeen({ dir, added: { s01e01: '2026-01-01T00:00:00.000Z' } })
    ).toBe(false);

    await fs.writeFile(join(dir, IDENTITY_SIDECAR), '{ not json');
    expect(
      await recordEpisodesFirstSeen({ dir, added: { s01e01: '2026-01-01T00:00:00.000Z' } })
    ).toBe(false);
    // ...and it did not clobber the unreadable file.
    expect(await fs.readFile(join(dir, IDENTITY_SIDECAR), 'utf8')).toBe('{ not json');
  });

  it('drops malformed entries instead of publishing them', async () => {
    const dir = await makeDir('tv/Malformed');
    await fs.writeFile(
      join(dir, IDENTITY_SIDECAR),
      JSON.stringify({
        v: IDENTITY_SIDECAR_VERSION,
        id: 'mid:00000000000000bb',
        firstSeen: '2026-01-01T00:00:00.000Z',
        previousIds: [],
        episodes: { s01e01: '2026-01-02T00:00:00.000Z', s01e02: 12345, s01e03: 'soon' },
      })
    );
    const resolved = await resolveMediaIdentity({ dir, libraryRelativePath: 'tv/Malformed' });
    expect(resolved.episodes).toEqual({ s01e01: '2026-01-02T00:00:00.000Z' });
  });

  it('survives a repoint — a new id does not re-date the episodes', async () => {
    const dir = await makeDir('tv/Copy of Show');
    await fs.writeFile(
      join(dir, IDENTITY_SIDECAR),
      JSON.stringify({
        v: IDENTITY_SIDECAR_VERSION,
        id: 'mid:0000000000000002',
        firstSeen: '2021-01-01T00:00:00.000Z',
        previousIds: [],
        episodes: { s01e01: '2021-01-02T00:00:00.000Z' },
      })
    );

    await repointMediaIdentity({ dir, libraryRelativePath: 'tv/Copy of Show' });

    const written = JSON.parse(await fs.readFile(join(dir, IDENTITY_SIDECAR), 'utf8'));
    expect(written.episodes).toEqual({ s01e01: '2021-01-02T00:00:00.000Z' });
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
