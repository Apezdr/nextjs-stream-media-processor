/**
 * The audit of the auto-captions on disk.
 *
 * Captions made before the audio track was chosen by language came from
 * whichever track ffmpeg picked. The domain half finds every `.auto.srt` and
 * decides what should happen to it; the controller half (auditAutoCaptions)
 * reports, and with `apply` removes or re-queues.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import { join } from 'path';
import os from 'os';

// ---- Mocks (the pipeline is not run here; see caption-controller.test.mjs) --

let queued = [];
jest.unstable_mockModule('../../../lib/taskManager.mjs', () => ({
  TaskType: { CAPTION_GENERATE: 5.5 },
  enqueueTask: jest.fn((_type, name, fn) => {
    queued.push({ name, fn });
    return new Promise(() => {});
  }),
  getTaskStatus: jest.fn(() => ({ activeTasks: [], queueSizes: {}, completionHistory: {} }))
}));

const mockGetConfig = jest.fn();
const mockIsLangEnabled = jest.fn();
jest.unstable_mockModule(
  '../../../components/caption-generator/data-access/caption-config.mjs',
  () => ({
    getAutoCaptionsConfig: mockGetConfig,
    isLanguageEnabled: mockIsLangEnabled,
    getAutoCaptionsConfigCached: mockGetConfig,
    _resetCacheForTests: () => {}
  })
);
jest.unstable_mockModule(
  '../../../components/caption-generator/domain/audio-extractor.mjs',
  () => ({ extractAudio: jest.fn(async () => {}) })
);
jest.unstable_mockModule('../../../lib/whisper.mjs', () => ({
  transcribe: jest.fn(async () => {}),
  inspect: jest.fn(async () => ({ binaryPresent: true, modelPresent: true })),
  getBinaryPath: () => '/mock/whisper-cli'
}));

// Audio tracks by video basename; a video not named here fails to probe.
let audioByVideo = {};
jest.unstable_mockModule('../../../ffmpeg/ffprobe.mjs', () => ({
  getVideoDuration: jest.fn(async () => 60),
  getAudioTracks: jest.fn(async (videoPath) => {
    const name = videoPath.split(/[\\/]/).pop();
    if (!(name in audioByVideo)) throw new Error(`ffprobe failed for ${name}`);
    return audioByVideo[name];
  })
}));
jest.unstable_mockModule('../../../sqlite/processTracking.mjs', () => ({
  createOrUpdateProcessQueue: jest.fn(async () => {}),
  updateProcessQueue: jest.fn(async () => {}),
  finalizeProcessQueue: jest.fn(async () => {}),
  getProcessTrackingDb: jest.fn(async () => ({}))
}));
jest.unstable_mockModule('../../../sqliteDatabase.mjs', () => ({
  releaseDatabase: jest.fn(async () => {})
}));

const tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'caption-audit-'));
process.env.BASE_PATH = tmpRoot;
process.env.CAPTIONS_TMP_DIR = join(tmpRoot, 'caption-tmp');

const { listAutoCaptions, decideAutoCaption } = await import(
  '../../../components/caption-generator/domain/caption-audit.mjs'
);
const {
  auditAutoCaptions,
  findInflightJob,
  CaptionAuditInputError,
  _resetStateForTests
} = await import('../../../components/caption-generator/entry-points/caption-controller.mjs');

// ---- Helpers ---------------------------------------------------------------

function track(index, language, overrides = {}) {
  return {
    index,
    codec: 'eac3',
    channels: 6,
    language,
    title: null,
    isDefault: false,
    commentary: false,
    described: false,
    ...overrides
  };
}

const ENGLISH = [track(1, 'eng', { isDefault: true })];
const ITALIAN = [track(1, 'ita', { isDefault: true })];
const DUBBED = [track(1, 'ita', { isDefault: true }), track(2, 'eng')];
const UNTAGGED = [track(1, null, { isDefault: true })];

async function put(relativePath, content = 'x') {
  const full = join(tmpRoot, ...relativePath.split('/'));
  await fs.mkdir(join(full, '..'), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

async function exists(relativePath) {
  return fs.access(join(tmpRoot, ...relativePath.split('/'))).then(() => true, () => false);
}

const slashed = (path) => path.split('\\').join('/');

async function clearMedia() {
  await fs.rm(join(tmpRoot, 'movies'), { recursive: true, force: true });
  await fs.rm(join(tmpRoot, 'tv'), { recursive: true, force: true });
}

beforeEach(async () => {
  await clearMedia();
  queued = [];
  audioByVideo = {};
  _resetStateForTests();
  mockGetConfig.mockReset();
  mockIsLangEnabled.mockReset();
  mockGetConfig.mockResolvedValue({ enabled: true, languages: ['en'], model: 'base.en', threads: 4 });
  mockIsLangEnabled.mockResolvedValue(true);
});

afterEach(clearMedia);

// ---- listAutoCaptions ------------------------------------------------------

describe('listAutoCaptions', () => {
  it('finds each auto-caption with its video and the title it belongs to', async () => {
    await put('movies/100% Wolf/In.un.giorno.mkv');
    await put('movies/100% Wolf/In.un.giorno.en.auto.srt');
    await put('tv/Widow\'s Bay/Season 1/Widow\'s Bay - S01E02 - Lodging.mkv');
    await put('tv/Widow\'s Bay/Season 1/Widow\'s Bay - S01E02 - Lodging.en.auto.srt');
    await put('tv/Show/Season 02 - Arc/Show.S02E05.mp4');
    await put('tv/Show/Season 02 - Arc/Show.S02E05.es.auto.srt');

    const captions = await listAutoCaptions(tmpRoot);
    const byTitle = Object.fromEntries(captions.map((caption) => [caption.mediaTitle, caption]));

    expect(captions).toHaveLength(3);
    expect(byTitle['100% Wolf']).toMatchObject({
      mediaType: 'movie',
      language: 'en',
      videoFile: 'In.un.giorno.mkv',
      season: null,
      episode: null
    });
    expect(slashed(byTitle['100% Wolf'].srtPath)).toBe(slashed(join(tmpRoot, 'movies/100% Wolf/In.un.giorno.en.auto.srt')));
    expect(byTitle["Widow's Bay"]).toMatchObject({ mediaType: 'tv', language: 'en', season: '1', episode: '02' });
    expect(byTitle.Show).toMatchObject({ mediaType: 'tv', language: 'es', season: '02', episode: '05', videoFile: 'Show.S02E05.mp4' });
  });

  it('reports a caption whose video is gone, even beside another release', async () => {
    await put('tv/The Son/Season 1/The Son - S01E02 - The Plum Tree Bluray-1080p Proper.mkv');
    await put('tv/The Son/Season 1/The Son - S01E02 - The Plum Tree Bluray-1080p Proper.en.srt');
    await put('tv/The Son/Season 1/The Son - S01E02 - The Plum Tree Bluray-1080p.en.auto.srt');

    const captions = await listAutoCaptions(tmpRoot);

    expect(captions).toHaveLength(1);
    expect(captions[0].videoFile).toBeNull();
  });

  it('ignores human subtitles, in-progress Tdarr files and anything that is not an auto-caption', async () => {
    await put('movies/Film/Film.mkv');
    await put('movies/Film/Film.en.srt');
    await put('movies/Film/Film.auto.srt');
    await put('movies/Film/Film.en.auto.srt.tmp');
    await put('movies/Film/Film-TdarrCacheFile-abc.mkv');
    await put('movies/Film/Film-TdarrCacheFile-abc.en.auto.srt');
    await put('movies/stray.en.auto.srt');

    const captions = await listAutoCaptions(tmpRoot);

    // The Tdarr one is listed, with no video: a cache file is not a video to caption.
    expect(captions.map((caption) => [caption.srtPath.split(/[\\/]/).pop(), caption.videoFile])).toEqual([
      ['Film-TdarrCacheFile-abc.en.auto.srt', null]
    ]);
  });

  it('returns nothing for a media root with no movies or tv folder', async () => {
    expect(await listAutoCaptions(join(tmpRoot, 'nowhere'))).toEqual([]);
  });
});

// ---- decideAutoCaption -----------------------------------------------------

describe('decideAutoCaption', () => {
  const writtenAt = new Date('2026-09-09T00:00:00Z');
  const decide = (overrides) =>
    decideAutoCaption({ hasVideo: true, tracks: ENGLISH, language: 'en', writtenAt, madeBefore: null, ...overrides });

  it('keeps a caption whose video has the language as the track ffmpeg picked', () => {
    expect(decide({})).toEqual({ verdict: 'ok', action: 'keep' });
  });

  it('removes a caption whose video is gone', () => {
    expect(decide({ hasVideo: false, tracks: null })).toEqual({ verdict: 'orphan', action: 'remove' });
  });

  it('removes a caption of a video with no audio in the language', () => {
    expect(decide({ tracks: ITALIAN })).toEqual({ verdict: 'no-audio-in-language', action: 'remove' });
    expect(decide({ tracks: UNTAGGED })).toEqual({ verdict: 'no-audio-in-language', action: 'remove' });
  });

  it('makes again a caption that came from the wrong track of a video that has the right one', () => {
    expect(decide({ tracks: DUBBED })).toEqual({ verdict: 'wrong-track', action: 'regenerate' });
  });

  it('does not second-guess a caption written since tracks were chosen by language', () => {
    const madeBefore = new Date('2026-09-01T00:00:00Z');
    expect(decide({ tracks: DUBBED, madeBefore })).toEqual({ verdict: 'ok', action: 'keep' });
    expect(decide({ tracks: DUBBED, madeBefore: writtenAt })).toEqual({ verdict: 'ok', action: 'keep' });
    expect(decide({ tracks: DUBBED, madeBefore: new Date('2026-10-01T00:00:00Z') })).toEqual({
      verdict: 'wrong-track',
      action: 'regenerate'
    });
  });

  it('removes what could not be made now, whenever it was written', () => {
    const madeBefore = new Date('2026-09-01T00:00:00Z');
    expect(decide({ tracks: ITALIAN, madeBefore }).action).toBe('remove');
    expect(decide({ hasVideo: false, tracks: null, madeBefore }).action).toBe('remove');
  });
});

// ---- auditAutoCaptions -----------------------------------------------------

describe('auditAutoCaptions', () => {
  const FUTURE = '2099-01-01T00:00:00Z';

  async function library() {
    audioByVideo = { 'fine.mkv': ENGLISH, 'italian.mkv': ITALIAN, 'dubbed.mkv': DUBBED, 'untagged.mkv': UNTAGGED, 'new.mkv': ENGLISH };
    await put('movies/Fine/fine.mkv');
    await put('movies/Fine/fine.en.auto.srt');
    await put('movies/Italian/italian.mkv');
    await put('movies/Italian/italian.en.auto.srt');
    await put('movies/Dubbed/dubbed.mkv');
    await put('movies/Dubbed/dubbed.en.auto.srt', 'made from the Italian');
    await put('movies/Untagged/untagged.mkv');
    await put('movies/Untagged/untagged.en.auto.srt');
    await put('movies/Replaced/new.mkv');
    await put('movies/Replaced/old.en.auto.srt');
  }

  const item = (report, title) => report.items.find((entry) => entry.mediaTitle === title);

  it('reports what is wrong and touches nothing', async () => {
    await library();

    const report = await auditAutoCaptions();

    expect(report.applied).toBe(false);
    expect(report.madeBefore).toBeNull();
    expect(report.scanned).toBe(5);
    expect(report.counts).toEqual({ ok: 1, 'no-audio-in-language': 2, 'wrong-track': 1, orphan: 1 });
    expect(report.items.map((entry) => entry.mediaTitle).sort()).toEqual(['Dubbed', 'Italian', 'Replaced', 'Untagged']);

    expect(item(report, 'Italian')).toMatchObject({ verdict: 'no-audio-in-language', action: 'remove', language: 'en', mediaType: 'movie' });
    expect(slashed(item(report, 'Italian').path)).toBe('movies/Italian/italian.en.auto.srt');
    expect(item(report, 'Italian').audio).toEqual([{ stream: 1, language: 'ita', channels: 6, default: true }]);
    expect(item(report, 'Untagged')).toMatchObject({ verdict: 'no-audio-in-language', action: 'remove' });
    expect(item(report, 'Dubbed')).toMatchObject({ verdict: 'wrong-track', action: 'regenerate' });
    expect(item(report, 'Replaced')).toMatchObject({ verdict: 'orphan', action: 'remove' });
    for (const entry of report.items) {
      expect(entry.result).toBeUndefined();
      expect(entry.request).toBeUndefined();
    }

    for (const title of ['Fine/fine', 'Italian/italian', 'Dubbed/dubbed', 'Untagged/untagged', 'Replaced/old']) {
      expect(await exists(`movies/${title}.en.auto.srt`)).toBe(true);
    }
    expect(queued).toHaveLength(0);
  });

  it('with apply removes what cannot be right and queues again what can', async () => {
    await library();

    const report = await auditAutoCaptions({ apply: true, madeBefore: FUTURE });

    expect(report.applied).toBe(true);
    expect(report.madeBefore).toBe('2099-01-01T00:00:00.000Z');
    expect(item(report, 'Italian').result).toBe('removed');
    expect(item(report, 'Untagged').result).toBe('removed');
    expect(item(report, 'Replaced').result).toBe('removed');
    expect(await exists('movies/Italian/italian.en.auto.srt')).toBe(false);
    expect(await exists('movies/Untagged/untagged.en.auto.srt')).toBe(false);
    expect(await exists('movies/Replaced/old.en.auto.srt')).toBe(false);
    // Videos are never touched.
    expect(await exists('movies/Italian/italian.mkv')).toBe(true);
    expect(await exists('movies/Replaced/new.mkv')).toBe(true);

    // The wrong-track caption stays in place until its replacement is written over it.
    expect(item(report, 'Dubbed')).toMatchObject({ result: 'queued' });
    expect(item(report, 'Dubbed').jobId).toMatch(/^cap-/);
    expect(await exists('movies/Dubbed/dubbed.en.auto.srt')).toBe(true);
    expect(queued).toHaveLength(1);
    expect(queued[0].name).toContain('Dubbed');
    expect(findInflightJob(join(tmpRoot, 'movies', 'Dubbed', 'dubbed.mkv'), 'en').jobId).toBe(item(report, 'Dubbed').jobId);

    expect(await exists('movies/Fine/fine.en.auto.srt')).toBe(true);
  });

  it('queues a title with characters a URL would need escaped', async () => {
    audioByVideo = { 'a.mkv': DUBBED };
    await put('movies/100% Wolf #1/a.mkv');
    await put('movies/100% Wolf #1/a.en.auto.srt');

    const report = await auditAutoCaptions({ apply: true, madeBefore: FUTURE });

    expect(report.items[0]).toMatchObject({ mediaTitle: '100% Wolf #1', verdict: 'wrong-track', result: 'queued' });
    expect(queued).toHaveLength(1);
  });

  it('queues an episode by its season and episode', async () => {
    audioByVideo = { 'Show - S01E02 - Lodging.mkv': DUBBED };
    await put('tv/Show/Season 1/Show - S01E02 - Lodging.mkv');
    await put('tv/Show/Season 1/Show - S01E02 - Lodging.en.auto.srt');

    const report = await auditAutoCaptions({ apply: true, madeBefore: FUTURE });

    expect(report.items[0]).toMatchObject({ mediaType: 'tv', mediaTitle: 'Show', result: 'queued' });
    expect(findInflightJob(join(tmpRoot, 'tv', 'Show', 'Season 1', 'Show - S01E02 - Lodging.mkv'), 'en')).not.toBeNull();
  });

  it('refuses to apply without the line between old captions and new', async () => {
    await library();

    await expect(auditAutoCaptions({ apply: true })).rejects.toBeInstanceOf(CaptionAuditInputError);
    await expect(auditAutoCaptions({ apply: true, madeBefore: 'yesterday-ish' })).rejects.toBeInstanceOf(CaptionAuditInputError);
    await expect(auditAutoCaptions({ madeBefore: 12345 })).rejects.toBeInstanceOf(CaptionAuditInputError);

    expect(await exists('movies/Italian/italian.en.auto.srt')).toBe(true);
    expect(queued).toHaveLength(0);
  });

  it('leaves a caption written after madeBefore alone, and still removes what could not be made', async () => {
    await library();

    const report = await auditAutoCaptions({ apply: true, madeBefore: '2000-01-01T00:00:00Z' });

    expect(report.counts).toEqual({ ok: 2, 'no-audio-in-language': 2, orphan: 1 });
    expect(queued).toHaveLength(0);
    expect(await exists('movies/Dubbed/dubbed.en.auto.srt')).toBe(true);
    expect(await exists('movies/Italian/italian.en.auto.srt')).toBe(false);
  });

  it('"start" means captions written before this process started', async () => {
    await library();
    const old = new Date('2026-09-09T00:00:00Z');
    await fs.utimes(join(tmpRoot, 'movies', 'Dubbed', 'dubbed.en.auto.srt'), old, old);
    audioByVideo['recent.mkv'] = DUBBED;
    await put('movies/Recent/recent.mkv');
    await put('movies/Recent/recent.en.auto.srt');

    const report = await auditAutoCaptions({ apply: true, madeBefore: 'start' });

    expect(item(report, 'Dubbed')).toMatchObject({ verdict: 'wrong-track', result: 'queued' });
    expect(item(report, 'Recent')).toBeUndefined();
    expect(queued).toHaveLength(1);
  });

  it('running it twice does not queue the same caption twice', async () => {
    await library();

    const first = await auditAutoCaptions({ apply: true, madeBefore: FUTURE });
    const second = await auditAutoCaptions({ apply: true, madeBefore: FUTURE });

    expect(queued).toHaveLength(1);
    expect(item(second, 'Dubbed').jobId).toBe(item(first, 'Dubbed').jobId);
    expect(second.items.map((entry) => entry.mediaTitle)).toEqual(['Dubbed']);
  });

  it('removes, not queues, a wrong caption of a file captions are not made for', async () => {
    // Two releases in one folder: captions are made for b.mp4 (the resolver's
    // pick), so a.mkv's cannot be made again in place.
    audioByVideo = { 'a.mkv': DUBBED, 'b.mp4': ENGLISH };
    await put('movies/Two/a.mkv');
    await put('movies/Two/a.en.auto.srt');
    await put('movies/Two/b.mp4');

    const report = await auditAutoCaptions({ apply: true, madeBefore: FUTURE });

    expect(report.items[0]).toMatchObject({ verdict: 'wrong-track', action: 'remove', result: 'removed' });
    expect(report.items[0].note).toMatch(/not made for now/);
    expect(queued).toHaveLength(0);
    expect(await exists('movies/Two/a.en.auto.srt')).toBe(false);
  });

  it('keeps and reports a caption whose video cannot be probed', async () => {
    audioByVideo = {};
    await put('movies/Broken/broken.mkv');
    await put('movies/Broken/broken.en.auto.srt');

    const report = await auditAutoCaptions({ apply: true, madeBefore: FUTURE });

    expect(report.counts).toEqual({ unreadable: 1 });
    expect(report.items[0]).toMatchObject({ verdict: 'unreadable', action: 'keep', error: 'ffprobe failed for broken.mkv' });
    expect(report.items[0].result).toBeUndefined();
    expect(await exists('movies/Broken/broken.en.auto.srt')).toBe(true);
  });

  it('reports a caption it could not queue, and leaves it', async () => {
    await library();
    mockGetConfig.mockResolvedValue({ enabled: false, languages: ['en'] });

    const report = await auditAutoCaptions({ apply: true, madeBefore: FUTURE });

    expect(item(report, 'Dubbed')).toMatchObject({ result: 'failed' });
    expect(item(report, 'Dubbed').error).toMatch(/disabled/);
    expect(await exists('movies/Dubbed/dubbed.en.auto.srt')).toBe(true);
    // Removal does not depend on the feature being on.
    expect(item(report, 'Italian').result).toBe('removed');
  });
});
