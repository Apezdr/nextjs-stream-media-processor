/**
 * End-to-end payload test: real fixture library on disk → real scanner → real
 * SQLite → the real response builders that /media/movies and /media/tv use.
 *
 * WHY THIS EXISTS. Every defect this container pivot produced was an EMISSION
 * bug, not a computation bug: the scanner derived the right value and something
 * between the row and the response dropped it —
 *
 *   - movie mediaIdentity was computed, stored, and then omitted from the
 *     readers' allowlist, so it shipped as a permanent null;
 *   - episode mediaIdentity/sources/jitEligible/jitUrl were emitted but absent
 *     from the episode hash, so a hash-gated consumer could never see them;
 *   - a folder rename tripped the duplicate detector and repointed identity.
 *
 * All three passed every unit test in the suite, because the units computed
 * correctly. Only an assertion on the actual response body catches this class.
 *
 * The ffprobe/mediainfo boundary is mocked. Everything else — filesystem,
 * scanner, SQLite, hashing, payload assembly — is real.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const tmpRoot = join(tmpdir(), `media-payload-${randomUUID()}`);
const MEDIA = join(tmpRoot, 'media');
const DB_DIR = join(tmpRoot, 'db');

process.env.MEDIA_DB_DIRECTORY = DB_DIR;
process.env.JIT_ELIGIBILITY_ENABLED = 'true';
process.env.JIT_TRANSCODER_URL = 'https://transcoder.test';

// ---------------------------------------------------------------- mocks

// Probe boundary. Keyed by basename so each fixture container gets distinct,
// controlled facts.
const PROBE = {
  'Solo.1080p.mp4': {
    uuid: 'uuid-solo-mp4', length: 5400000, dimensions: '1920x1080', hdr: null,
    mediaQuality: { isHDR: false },
    additionalMetadata: {
      format: { formatName: 'mov,mp4,m4a,3gp,3g2,mj2' },
      video: [{ codec: 'h264', pix_fmt: 'yuv420p', field_order: 'progressive' }],
      audio: [{ codec: 'aac', languageTag: 'eng' }],
    },
  },
  'Remux.2160p.mkv': {
    uuid: 'uuid-remux-mkv', length: 7200000, dimensions: '3840x2160', hdr: 'HDR10',
    mediaQuality: { isHDR: true },
    additionalMetadata: {
      format: { formatName: 'matroska,webm' },
      video: [{ codec: 'hevc', pix_fmt: 'yuv420p10le', field_order: 'progressive' }],
      audio: [{ codec: 'eac3', languageTag: 'eng' }],
    },
  },
  'Multi.Lang.mkv': {
    uuid: 'uuid-multilang', length: 6000000, dimensions: '1920x1080', hdr: null,
    mediaQuality: { isHDR: false },
    additionalMetadata: {
      format: { formatName: 'matroska,webm' },
      video: [{ codec: 'h264', pix_fmt: 'yuv420p', field_order: 'progressive' }],
      audio: [{ codec: 'eac3', languageTag: 'eng' }, { codec: 'aac', languageTag: 'jpn' }],
    },
  },
  'Legacy.Only.avi': {
    uuid: 'uuid-avi', length: 3000000, dimensions: '640x480', hdr: null,
    mediaQuality: { isHDR: false },
    additionalMetadata: {
      format: { formatName: 'avi' },
      video: [{ codec: 'mpeg4', pix_fmt: 'yuv420p', field_order: 'progressive' }],
      audio: [{ codec: 'mp3', languageTag: 'eng' }],
    },
  },
};
const genericProbe = (name) => ({
  uuid: `uuid-${name}`, length: 1200000, dimensions: '1920x1080', hdr: null,
  mediaQuality: { isHDR: false },
  additionalMetadata: {
    format: { formatName: 'matroska,webm' },
    video: [{ codec: 'h264', pix_fmt: 'yuv420p', field_order: 'progressive' }],
    audio: [{ codec: 'aac', languageTag: 'eng' }],
  },
});

jest.unstable_mockModule('../../infoManager.mjs', () => ({
  CURRENT_VERSION: 1.0011,
  getInfo: jest.fn(async (filePath) => {
    const name = filePath.split(/[\\/]/).pop();
    return PROBE[name] ?? genericProbe(name);
  }),
  writeInfo: jest.fn(async () => {}),
}));

// Subprocess boundaries.
jest.unstable_mockModule('../../ffmpeg/ffprobe.mjs', () => ({
  chapterInfo: jest.fn(async () => null),
  isVideoHDR: jest.fn(async () => false),
  getVideoDuration: jest.fn(async () => 0),
  getVideoCodec: jest.fn(async () => 'h264'),
  getAudioTracks: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../chapter-generator.mjs', () => ({
  generateChapters: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../utils/backdropFocalDetector.mjs', () => ({
  detectBackdropFocal: jest.fn(async () => null),
}));

// Mongo-backed config.
jest.unstable_mockModule('../../components/caption-generator/data-access/caption-config.mjs', () => ({
  getAutoCaptionsConfigCached: jest.fn(async () => ({ enabled: false, languages: [] })),
}));
jest.unstable_mockModule('../../lib/metadataGenerator.mjs', () => ({
  isFrozenReason: jest.fn(() => false),
  refreshMissingEpisodes: jest.fn(async () => 0),
  MetadataGenerator: class {},
}));

const { scanMovies } = await import('../../components/media-scanner/domain/movie-scanner.mjs');
const { scanTVShows } = await import('../../components/media-scanner/domain/tv-scanner.mjs');
const sqliteDb = await import('../../sqliteDatabase.mjs');
const { initializeDatabase, releaseDatabase, getMovies, getTVShows } = sqliteDb;
const { buildMoviePayloadEntry, buildTvPayloadEntry, buildPayloadMap } = await import(
  '../../lib/mediaPayload.mjs'
);

// ---------------------------------------------------------------- fixtures

const PREFIX = '/media';
let db;

async function writeFiles(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  for (const f of files) await fs.writeFile(join(dir, f), 'x'.repeat(64));
}

async function runScan() {
  await scanMovies(db, join(MEDIA, 'movies'), PREFIX, MEDIA, {}, 1.0011, false, async () => {});
  await scanTVShows(db, join(MEDIA, 'tv'), PREFIX, MEDIA, {}, false, async () => {});
}

async function moviePayload() {
  return buildPayloadMap(await getMovies(), buildMoviePayloadEntry);
}
async function tvPayload() {
  return buildPayloadMap(await getTVShows(), buildTvPayloadEntry);
}

beforeAll(async () => {
  // Movie: single mp4 (the pre-pivot baseline)
  await writeFiles(join(MEDIA, 'movies', 'Solo Movie'), ['Solo.1080p.mp4', 'Solo.en.srt']);
  // Movie: MKV only — invisible before this pivot
  await writeFiles(join(MEDIA, 'movies', 'Mkv Only'), ['Remux.2160p.mkv']);
  // Movie: two containers — mp4 must win as primary
  await writeFiles(join(MEDIA, 'movies', 'Mixed Containers'), [
    'Remux.2160p.mkv',
    'Solo.1080p.mp4',
  ]);
  // Movie: multi-language audio — servable, but not JIT-eligible
  await writeFiles(join(MEDIA, 'movies', 'Multi Lang'), ['Multi.Lang.mkv']);
  // Movie: .avi — discoverable and playable, never JIT-advertised
  await writeFiles(join(MEDIA, 'movies', 'Avi Only'), ['Legacy.Only.avi']);

  // TV: mkv episodes with sidecar subtitles, in a zero-padded season folder
  await writeFiles(join(MEDIA, 'tv', 'Mkv Show', 'Season 01'), [
    'Mkv Show - S01E01.mkv',
    'Mkv Show - S01E01.en.srt',
    'Mkv Show - S01E02.mkv',
  ]);
  // TV: one episode present in two containers — must collapse to ONE entry
  await writeFiles(join(MEDIA, 'tv', 'Dual Show', 'Season 1'), [
    'Dual Show - S01E01.mp4',
    'Dual Show - S01E01.mkv',
  ]);

  await fs.mkdir(DB_DIR, { recursive: true });
  db = await initializeDatabase();
  await runScan();
});

afterAll(async () => {
  if (db) await releaseDatabase(db);
  await sqliteDb.closeAllDatabaseConnections();
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows may still hold the sqlite file; the temp dir is the OS's to reclaim.
  }
});

// ---------------------------------------------------------------- movies

describe('/media/movies payload', () => {
  it('publishes an MKV-only movie, which was previously invisible', async () => {
    const m = (await moviePayload())['Mkv Only'];
    expect(m).toBeDefined();
    expect(m.urls.mp4).toMatch(/Remux\.2160p\.mkv$/);
    expect(m.urls.mp4.startsWith(`${PREFIX}/movies/`)).toBe(true);
  });

  it('EMITS mediaIdentity — the reader allowlist regression', async () => {
    // This shipped as a permanent null once: computed, stored, then dropped by
    // the getMovies reshape. Assert on the response, not the row.
    const payload = await moviePayload();
    for (const name of ['Solo Movie', 'Mkv Only', 'Mixed Containers']) {
      expect(payload[name].mediaIdentity).not.toBeNull();
      expect(payload[name].mediaIdentity.id).toMatch(/^mid:[0-9a-f]{16}$/);
      expect(payload[name].mediaIdentity.scheme).toBe('mid');
    }
    // Distinct titles get distinct identities.
    const ids = ['Solo Movie', 'Mkv Only', 'Mixed Containers'].map(
      (n) => payload[n].mediaIdentity.id
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('writes mediaLastModified for a non-mp4 primary', async () => {
    // Written only inside the .mp4 branch once, which made mkv-only movies
    // permanently invisible to the incremental hash sweep. Silently.
    const m = (await moviePayload())['Mkv Only'];
    expect(m.urls.mediaLastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('builds sources[] with mp4 first and exactly one primary', async () => {
    const m = (await moviePayload())['Mixed Containers'];
    expect(m.urls.sources).toHaveLength(2);
    expect(m.urls.sources.map((s) => s.container)).toEqual(['mp4', 'mkv']);

    const primaries = m.urls.sources.filter((s) => s.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].container).toBe('mp4');
    // The stated invariant: the primary's url IS urls.mp4.
    expect(primaries[0].url).toBe(m.urls.mp4);
  });

  it('carries per-source probe facts through to the wire', async () => {
    const mkv = (await moviePayload())['Mixed Containers'].urls.sources.find(
      (s) => s.container === 'mkv'
    );
    expect(mkv).toMatchObject({
      formatName: 'matroska,webm',
      videoCodec: 'hevc',
      pixFmt: 'yuv420p10le',
      fieldOrder: 'progressive',
      hdr: 'HDR10',
      dimensions: '3840x2160',
      audioLanguages: ['eng'],
      uuid: 'uuid-remux-mkv',
    });
    expect(typeof mkv.size).toBe('number');
  });

  it('includes non-mp4 containers in fileNames and excludes the identity sidecar', async () => {
    const m = (await moviePayload())['Mkv Only'];
    expect(m.fileNames).toContain('Remux.2160p.mkv');
    // .mediaid.json matches the .json arm of the allowlist; publishing it would
    // also fold it into the movie hash.
    expect(m.fileNames).not.toContain('.mediaid.json');
  });

  it('emits jitEligible/jitUrl beside urls.mp4 for an eligible title', async () => {
    const m = (await moviePayload())['Mkv Only'];
    expect(m.urls.jitEligible).toBe(true);
    expect(m.urls.jitUrl).toMatch(/^https:\/\/transcoder\.test\/stream\/[A-Za-z0-9_-]+\/master\.m3u8$/);

    // The key must decode to the library-relative path of the primary file.
    const key = m.urls.jitUrl.split('/stream/')[1].split('/master.m3u8')[0];
    expect(Buffer.from(key, 'base64url').toString('utf8')).toBe(
      'movies/Mkv Only/Remux.2160p.mkv'
    );
  });

  it('marks a multi-language source ineligible, with a reason, but still publishes it', async () => {
    const m = (await moviePayload())['Multi Lang'];
    expect(m.urls.mp4).toMatch(/Multi\.Lang\.mkv$/); // still playable
    expect(m.urls.jitEligible).toBe(false);
    expect(m.urls.jitUrl).toBeUndefined();
    expect(m.urls.sources[0].jitReason).toBe('multi-audio-language');
  });

  it('discovers .avi but never advertises it', async () => {
    const m = (await moviePayload())['Avi Only'];
    expect(m.urls.mp4).toMatch(/Legacy\.Only\.avi$/);
    expect(m.urls.jitEligible).toBe(false);
    expect(m.urls.sources[0].jitReason).toBe('container-unsupported');
  });
});

// ---------------------------------------------------------------- tv

describe('/media/tv payload', () => {
  const episodesOf = (payload, show, season) =>
    payload[show].seasons[season].episodes;

  it('publishes MKV episodes from a zero-padded season folder', async () => {
    const eps = episodesOf(await tvPayload(), 'Mkv Show', 'Season 01');
    expect(Object.keys(eps).sort()).toEqual(['S01E01', 'S01E02']);
    expect(eps.S01E01.videoURL).toMatch(/Mkv%20Show%20-%20S01E01\.mkv$/);
  });

  it('ATTACHES SIDECAR SUBTITLES to a non-mp4 episode', async () => {
    // The silent one: the stem strip was a literal '.mp4' replace, a no-op for
    // any other container, so the prefix test became
    // startsWith('Show - S01E01.mkv') and every non-mp4 episode published with
    // ZERO subtitles while the .srt sat right beside it. No error, no log.
    const eps = episodesOf(await tvPayload(), 'Mkv Show', 'Season 01');
    expect(eps.S01E01.subtitles).toBeDefined();
    expect(Object.keys(eps.S01E01.subtitles).length).toBeGreaterThan(0);
  });

  it('emits episode mediaIdentity as showId + coordinate', async () => {
    const eps = episodesOf(await tvPayload(), 'Mkv Show', 'Season 01');
    expect(eps.S01E01.mediaIdentity.id).toMatch(/^mid:[0-9a-f]{16}:s01e01$/);
    expect(eps.S01E02.mediaIdentity.id).toMatch(/^mid:[0-9a-f]{16}:s01e02$/);
    // Same show ⇒ same prefix.
    const prefixOf = (id) => id.split(':').slice(0, 2).join(':');
    expect(prefixOf(eps.S01E01.mediaIdentity.id)).toBe(prefixOf(eps.S01E02.mediaIdentity.id));
  });

  it('COLLAPSES two containers of one episode into a single entry', async () => {
    // Both used to write to the same episodes key, so the winner flipped with
    // readdir order and the episode's URL moved on every scan.
    const eps = episodesOf(await tvPayload(), 'Dual Show', 'Season 1');
    expect(Object.keys(eps)).toEqual(['S01E01']);
    expect(eps.S01E01.sources).toHaveLength(2);
    expect(eps.S01E01.sources.map((s) => s.container)).toEqual(['mp4', 'mkv']);
    expect(eps.S01E01.videoURL).toMatch(/\.mp4$/);
    expect(eps.S01E01.sources.filter((s) => s.isPrimary)).toHaveLength(1);
  });

  it('emits jitEligible/jitUrl flat on the episode', async () => {
    const eps = episodesOf(await tvPayload(), 'Mkv Show', 'Season 01');
    expect(eps.S01E01.jitEligible).toBe(true);
    const key = eps.S01E01.jitUrl.split('/stream/')[1].split('/master.m3u8')[0];
    expect(Buffer.from(key, 'base64url').toString('utf8')).toBe(
      'tv/Mkv Show/Season 01/Mkv Show - S01E01.mkv'
    );
  });
});

// ---------------------------------------------------------------- convergence

describe('convergence and stability', () => {
  it('is idempotent — a second scan changes nothing on the wire', async () => {
    const before = JSON.stringify(await moviePayload());
    const beforeTv = JSON.stringify(await tvPayload());

    await runScan();

    expect(JSON.stringify(await moviePayload())).toBe(before);
    expect(JSON.stringify(await tvPayload())).toBe(beforeTv);
  });

  it('keeps identity across a folder rename', async () => {
    const before = (await moviePayload())['Mkv Only'].mediaIdentity.id;

    await fs.rename(join(MEDIA, 'movies', 'Mkv Only'), join(MEDIA, 'movies', 'Mkv Only (2021)'));
    await runScan();

    const payload = await moviePayload();
    expect(payload['Mkv Only (2021)'].mediaIdentity.id).toBe(before);

    // Restore for any later test.
    await fs.rename(join(MEDIA, 'movies', 'Mkv Only (2021)'), join(MEDIA, 'movies', 'Mkv Only'));
    await runScan();
  });

  it('reproduces every id from the media volume after the identity index is dropped', async () => {
    const before = await moviePayload();
    const beforeIds = Object.fromEntries(
      Object.entries(before).map(([k, v]) => [k, v.mediaIdentity?.id])
    );

    await db.run('DELETE FROM media_identity_index');
    await runScan();

    const after = await moviePayload();
    for (const [name, id] of Object.entries(beforeIds)) {
      expect(after[name].mediaIdentity?.id).toBe(id);
    }
  });

  it('folds the new episode fields into the episode hash', async () => {
    // Episode hashes gate the frontend's incremental sync: a hash that does not
    // move means the field never converges, and JIT-disable could never
    // propagate to TV. Flipping the toggle must move the stored hash.
    const readHash = async () => {
      const row = await db.get(
        `SELECT hash FROM metadata_hashes
         WHERE media_type = 'tv' AND title = ? AND episode_key = ?`,
        ['Mkv Show', 'S01E01']
      );
      return row?.hash;
    };

    const withJit = await readHash();
    expect(withJit).toBeTruthy();

    process.env.JIT_ELIGIBILITY_ENABLED = 'false';
    try {
      await runScan();
      const withoutJit = await readHash();
      expect(withoutJit).toBeTruthy();
      expect(withoutJit).not.toBe(withJit);

      // ...and the payload really did change, so the hash is tracking reality.
      const eps = (await tvPayload())['Mkv Show'].seasons['Season 01'].episodes;
      expect(eps.S01E01.jitEligible).toBe(false);
    } finally {
      process.env.JIT_ELIGIBILITY_ENABLED = 'true';
      await runScan();
    }
  });
});
