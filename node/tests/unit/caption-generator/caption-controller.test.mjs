/**
 * Unit tests for the caption-controller orchestration logic:
 * dedupe by (videoPath, lang), skip-if-human-sub, file-already-exists,
 * and feature-disabled gating.
 *
 * The pipeline body itself (ffmpeg + whisper + write) is mocked — we're
 * testing decision logic, not the actual transcription.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import { join } from 'path';
import os from 'os';

// ---- Mocks ----------------------------------------------------------------

// taskManager: capture the queued function and run it on demand
let queuedFn = null;
let queuedResolver = null;
let queuedRejecter = null;
const TaskType = { CAPTION_GENERATE: 5.5 };

jest.unstable_mockModule('../../../lib/taskManager.mjs', () => ({
  TaskType,
  enqueueTask: jest.fn((_type, _name, fn) => {
    queuedFn = fn;
    return new Promise((resolve, reject) => {
      queuedResolver = resolve;
      queuedRejecter = reject;
    });
  }),
  getTaskStatus: jest.fn(() => ({
    activeTasks: [],
    queueSizes: {},
    completionHistory: {}
  }))
}));

// caption-config: stub the settings doc
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

// audio + whisper + ffprobe: no-op
jest.unstable_mockModule(
  '../../../components/caption-generator/domain/audio-extractor.mjs',
  () => ({ extractAudio: jest.fn(async () => {}) })
);
jest.unstable_mockModule('../../../lib/whisper.mjs', () => ({
  transcribe: jest.fn(async () => 'mock-srt-path'),
  inspect: jest.fn(async () => ({ binaryPresent: true, modelPresent: true })),
  getBinaryPath: () => '/mock/whisper-cli'
}));
jest.unstable_mockModule('../../../ffmpeg/ffprobe.mjs', () => ({
  getVideoDuration: jest.fn(async () => 60)
}));

// process_queue + sqlite stubs — we don't want tests touching real SQLite.
jest.unstable_mockModule('../../../sqlite/processTracking.mjs', () => ({
  createOrUpdateProcessQueue: jest.fn(async () => {}),
  updateProcessQueue: jest.fn(async () => {}),
  finalizeProcessQueue: jest.fn(async () => {}),
  getProcessTrackingDb: jest.fn(async () => ({}))
}));
jest.unstable_mockModule('../../../sqliteDatabase.mjs', () => ({
  releaseDatabase: jest.fn(async () => {})
}));

// Use a tmp BASE_PATH so resolveTarget can readdir something real.
const tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'caption-ctrl-'));
const moviesDir = join(tmpRoot, 'movies', 'Test Movie');
await fs.mkdir(moviesDir, { recursive: true });
await fs.writeFile(join(moviesDir, 'Test Movie.mp4'), 'fakebytes');

process.env.BASE_PATH = tmpRoot;
process.env.CAPTIONS_TMP_DIR = join(tmpRoot, 'caption-tmp');

// Pull refs to the mocked process-tracking functions so we can assert calls.
const processTracking = await import('../../../sqlite/processTracking.mjs');

// Now import the controller (after mocks are registered).
const {
  enqueueCaptionJob,
  findInflightJob,
  getJob,
  _resetStateForTests,
  FeatureDisabledError,
  HumanSubtitleExistsError,
  TargetExistsError
} = await import('../../../components/caption-generator/entry-points/caption-controller.mjs');

// ---- Tests ----------------------------------------------------------------

describe('enqueueCaptionJob', () => {
  beforeEach(() => {
    _resetStateForTests();
    queuedFn = null;
    queuedResolver = null;
    queuedRejecter = null;
    mockGetConfig.mockReset();
    mockIsLangEnabled.mockReset();
    mockGetConfig.mockResolvedValue({
      enabled: true,
      languages: ['en'],
      model: 'base.en',
      threads: 4
    });
    mockIsLangEnabled.mockResolvedValue(true);
  });

  it('rejects when feature is disabled', async () => {
    mockGetConfig.mockResolvedValue({ enabled: false, languages: ['en'] });
    await expect(
      enqueueCaptionJob({ mediaType: 'movie', mediaTitle: 'Test Movie', language: 'en' })
    ).rejects.toBeInstanceOf(FeatureDisabledError);
  });

  it('rejects when a same-lang human SRT already exists', async () => {
    const humanPath = join(moviesDir, 'Test Movie.en.srt');
    await fs.writeFile(humanPath, 'human cues');

    await expect(
      enqueueCaptionJob({ mediaType: 'movie', mediaTitle: 'Test Movie', language: 'en' })
    ).rejects.toBeInstanceOf(HumanSubtitleExistsError);

    await fs.unlink(humanPath);
  });

  it('rejects when an .auto.srt already exists and force=false', async () => {
    const autoPath = join(moviesDir, 'Test Movie.en.auto.srt');
    await fs.writeFile(autoPath, 'auto cues');

    await expect(
      enqueueCaptionJob({ mediaType: 'movie', mediaTitle: 'Test Movie', language: 'en' })
    ).rejects.toBeInstanceOf(TargetExistsError);

    await fs.unlink(autoPath);
  });

  it('enqueues a fresh job and returns queued state', async () => {
    const job = await enqueueCaptionJob({
      mediaType: 'movie',
      mediaTitle: 'Test Movie',
      language: 'en'
    });
    expect(job.status).toBe('queued');
    expect(job.jobId).toMatch(/^cap-\d+-/);
    expect(job.expectedPath).toContain('Test Movie.en.auto.srt');
    expect(job.queuePosition).toBe(1);
  });

  it('dedupes a second request for the same (video, lang) to the same job', async () => {
    const a = await enqueueCaptionJob({
      mediaType: 'movie',
      mediaTitle: 'Test Movie',
      language: 'en'
    });
    const b = await enqueueCaptionJob({
      mediaType: 'movie',
      mediaTitle: 'Test Movie',
      language: 'en'
    });
    expect(b.jobId).toBe(a.jobId);
  });

  it('writes the job to process_queue on enqueue', async () => {
    processTracking.createOrUpdateProcessQueue.mockClear();
    await enqueueCaptionJob({
      mediaType: 'movie',
      mediaTitle: 'Test Movie',
      language: 'en'
    });
    expect(processTracking.createOrUpdateProcessQueue).toHaveBeenCalled();
    const callArgs = processTracking.createOrUpdateProcessQueue.mock.calls[0];
    // (db, fileKey, processType, totalSteps, currentStep, status, message)
    expect(callArgs[1]).toBe('movie_Test_Movie_en_caption');
    expect(callArgs[2]).toBe('caption');
    expect(callArgs[3]).toBe(5);
    expect(callArgs[5]).toBe('queued');
  });

  it('exposes the in-flight job via findInflightJob', async () => {
    const job = await enqueueCaptionJob({
      mediaType: 'movie',
      mediaTitle: 'Test Movie',
      language: 'en'
    });
    const found = findInflightJob(join(moviesDir, 'Test Movie.mp4'), 'en');
    expect(found.jobId).toBe(job.jobId);
  });

  it('clears dedupe entry once the job succeeds, and lets a follow-up enqueue fresh', async () => {
    const first = await enqueueCaptionJob({
      mediaType: 'movie',
      mediaTitle: 'Test Movie',
      language: 'en'
    });
    // Simulate the queued task running successfully (and the file ending up on disk
    // would normally come next; we simulate that with a stub write).
    const expectedPath = first.expectedPath;
    await fs.writeFile(expectedPath, 'done');
    queuedResolver();
    // give the .then handler a chance to run
    await new Promise(r => setImmediate(r));

    const stored = getJob(first.jobId);
    expect(stored.status).toBe('succeeded');

    // Now dedupe is cleared but the file exists, so a new enqueue should hit
    // TargetExistsError, not return the old job.
    await expect(
      enqueueCaptionJob({ mediaType: 'movie', mediaTitle: 'Test Movie', language: 'en' })
    ).rejects.toBeInstanceOf(TargetExistsError);

    await fs.unlink(expectedPath);
  });
});
