import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createHash, randomUUID } from 'crypto';
import { createCategoryLogger } from '../../../lib/logger.mjs';
import { enqueueTask, TaskType, getTaskStatus } from '../../../lib/taskManager.mjs';
import { getAutoCaptionsConfig, isLanguageEnabled } from '../data-access/caption-config.mjs';
import { resolveTarget } from '../domain/target-resolver.mjs';
import { extractAudio } from '../domain/audio-extractor.mjs';
import { postProcessSrt } from '../domain/srt-postprocess.mjs';
import { getVideoDuration } from '../../../ffmpeg/ffprobe.mjs';
import * as whisper from '../../../lib/whisper.mjs';
import {
  createOrUpdateProcessQueue,
  updateProcessQueue,
  finalizeProcessQueue,
  getProcessTrackingDb
} from '../../../sqlite/processTracking.mjs';
import { releaseDatabase } from '../../../sqliteDatabase.mjs';
import { mainCacheDir } from '../../../utils/utils.mjs';

const logger = createCategoryLogger('caption-controller');

const BASE_PATH = process.env.BASE_PATH || '/var/www/html';
const PUBLIC_PREFIX = process.env.PREFIX_PATH || '';
// Align with the existing cache convention (node/cache/...) — module-relative,
// not cwd-relative, so we land in a directory the container actually owns.
const CAPTIONS_TMP_DIR = process.env.CAPTIONS_TMP_DIR || join(mainCacheDir, 'captions');
const ORPHAN_AGE_MS = 60 * 60 * 1000; // 1 hour

// Aggregate health state — surfaced by /api/captions/health.
const health = {
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null
};

// In-memory job registry. Lost on restart by design — the SRT file on disk is
// the durable record, so re-enqueue is cheap and self-healing.
const jobs = new Map();              // jobId -> jobState
const dedupeIndex = new Map();        // dedupeKey (videoPath:lang) -> jobId

// Cap to avoid unbounded growth. Old completed/failed jobs are pruned LRU.
const MAX_JOB_REGISTRY = 500;

export class FeatureDisabledError extends Error {
  constructor(reason) { super(reason); this.code = 'FEATURE_DISABLED'; }
}
export class LanguageNotAllowedError extends Error {
  constructor(langCode) {
    super(`Language "${langCode}" not in app_config.autoCaptions.languages`);
    this.code = 'LANGUAGE_NOT_ALLOWED';
  }
}
export class TargetExistsError extends Error {
  constructor(path) {
    super(`Caption file already exists: ${path}`);
    this.code = 'TARGET_EXISTS';
    this.path = path;
  }
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function dedupeKey(videoPath, langCode) {
  return `${videoPath}::${langCode}`;
}

/**
 * Build a stable identifier suitable for the process_queue.file_key column.
 * Mirrors the convention used by sprite/vtt jobs (e.g. "movie_xxx_spritesheet").
 */
function buildProcessFileKey(req, langCode) {
  const safeTitle = String(req.mediaTitle).replace(/[^a-z0-9._-]+/gi, '_');
  if (req.mediaType === 'tv') {
    const s = String(req.season).padStart(2, '0');
    const e = String(req.episode).padStart(2, '0');
    return `tv_${safeTitle}_S${s}E${e}_${langCode}_caption`;
  }
  return `movie_${safeTitle}_${langCode}_caption`;
}

const CAPTION_PROCESS_TYPE = 'caption';
const CAPTION_TOTAL_STEPS = 5;

/**
 * Best-effort process_queue write. Swallows errors so SQLite hiccups can't
 * fail the actual transcription job.
 */
async function trackProcess(action, fileKey, ...args) {
  let db;
  try {
    db = await getProcessTrackingDb();
    if (action === 'create') {
      await createOrUpdateProcessQueue(db, fileKey, CAPTION_PROCESS_TYPE, CAPTION_TOTAL_STEPS, args[0], args[1], args[2]);
    } else if (action === 'update') {
      await updateProcessQueue(db, fileKey, args[0], args[1], args[2]);
    } else if (action === 'finalize') {
      await finalizeProcessQueue(db, fileKey, args[0], args[1]);
    }
  } catch (err) {
    logger.warn(`process_queue ${action} failed for ${fileKey}: ${err.message}`);
  } finally {
    if (db) await releaseDatabase(db).catch(() => {});
  }
}

/**
 * Resolve the target paths for a caption request without enqueueing anything.
 * Used by the track endpoint to decide whether to serve the file or enqueue.
 */
export async function resolveRequest(req) {
  return resolveTarget({
    basePath: BASE_PATH,
    publicPrefix: PUBLIC_PREFIX,
    mediaType: req.mediaType,
    mediaTitle: req.mediaTitle,
    langCode: req.language,
    season: req.season,
    episode: req.episode
  });
}

/**
 * Returns the in-flight job for a (videoPath, lang) pair, or null.
 */
export function findInflightJob(videoPath, langCode) {
  const jobId = dedupeIndex.get(dedupeKey(videoPath, langCode));
  if (!jobId) return null;
  const state = jobs.get(jobId);
  if (!state) return null;
  if (state.status === 'queued' || state.status === 'running') return state;
  return null;
}

/**
 * Look up a job by id. Returns enriched state with live queue position.
 */
export function getJob(jobId) {
  const state = jobs.get(jobId);
  if (!state) return null;
  return enrichJobState(state);
}

function enrichJobState(state) {
  if (state.status === 'queued') {
    return { ...state, queuePosition: queuePositionFor(state.jobId) };
  }
  return { ...state };
}

function queuePositionFor(jobId) {
  // taskManager doesn't expose queue order, so we approximate from registry
  // creation time among queued jobs of this type.
  const queued = [...jobs.values()]
    .filter(j => j.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const idx = queued.findIndex(j => j.jobId === jobId);
  return idx === -1 ? null : idx + 1;
}

/**
 * Enqueue (or join an in-flight) caption generation job.
 *
 * @param {Object} req - { mediaType, mediaTitle, language, season?, episode?, force? }
 * @returns {Promise<Object>} job state
 */
export async function enqueueCaptionJob(req) {
  const config = await getAutoCaptionsConfig();
  if (!config.enabled) {
    throw new FeatureDisabledError('Auto-captions are disabled in app_config.settings');
  }

  const langCode = req.language;
  if (!(await isLanguageEnabled(langCode))) {
    throw new LanguageNotAllowedError(langCode);
  }

  const target = await resolveRequest(req);

  // Only block on an existing .auto.srt — human-authored subs in the same
  // language are allowed to coexist as alternative tracks.
  if (!req.force && await fileExists(target.srtPath)) {
    throw new TargetExistsError(target.srtPath);
  }

  // Dedupe: if there's already an in-flight job for this (video, lang), join it.
  const inflight = findInflightJob(target.videoPath, langCode);
  if (inflight) {
    return enrichJobState(inflight);
  }

  const jobId = `cap-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const taskName = `Caption: ${req.mediaType}/${req.mediaTitle}${req.season ? `/S${req.season}E${req.episode}` : ''} [${langCode}]`;
  const processFileKey = buildProcessFileKey(req, langCode);

  const state = {
    jobId,
    dedupeKey: dedupeKey(target.videoPath, langCode),
    processFileKey,
    status: 'queued',
    progressPct: null,
    expectedPath: target.srtPath,
    mediaType: req.mediaType,
    language: langCode,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    error: null
  };
  jobs.set(jobId, state);
  dedupeIndex.set(state.dedupeKey, jobId);
  pruneJobsIfNeeded();

  // Surface the job in /processes immediately as 'queued'
  trackProcess('create', processFileKey, 0, 'queued', `Caption job queued for ${langCode}`);

  // Fire-and-forget — caller gets queued state immediately.
  enqueueTask(TaskType.CAPTION_GENERATE, taskName, () => runJob({ jobId, target, langCode, config, processFileKey }))
    .then(() => {
      const s = jobs.get(jobId);
      if (s) {
        s.status = 'succeeded';
        s.progressPct = 1;
        s.completedAt = new Date().toISOString();
      }
      dedupeIndex.delete(state.dedupeKey);
      health.lastSuccessAt = new Date().toISOString();
      trackProcess('finalize', processFileKey, 'completed', `Wrote ${target.srtPath}`);
      logger.info(`Caption job ${jobId} completed: ${target.srtPath}`);
    })
    .catch(err => {
      const s = jobs.get(jobId);
      if (s) {
        s.status = 'failed';
        s.error = err.message;
        s.completedAt = new Date().toISOString();
      }
      dedupeIndex.delete(state.dedupeKey);
      health.lastFailureAt = new Date().toISOString();
      health.lastFailureReason = err.message;
      trackProcess('finalize', processFileKey, 'error', err.message);
      logger.error(`Caption job ${jobId} failed: ${err.message}`);
    });

  return enrichJobState(state);
}

function pruneJobsIfNeeded() {
  if (jobs.size <= MAX_JOB_REGISTRY) return;
  // Drop oldest completed/failed jobs first
  const terminal = [...jobs.values()]
    .filter(j => j.status === 'succeeded' || j.status === 'failed')
    .sort((a, b) => (a.completedAt || '').localeCompare(b.completedAt || ''));
  const toDrop = jobs.size - MAX_JOB_REGISTRY;
  for (let i = 0; i < toDrop && i < terminal.length; i++) {
    jobs.delete(terminal[i].jobId);
  }
}

/**
 * The actual pipeline. Runs inside the taskManager queue.
 */
async function runJob({ jobId, target, langCode, config, processFileKey }) {
  const state = jobs.get(jobId);
  if (state) {
    state.status = 'running';
    state.startedAt = new Date().toISOString();
  }

  const wavHash = createHash('sha1').update(target.videoPath).digest('hex').slice(0, 16);
  const wavPath = join(CAPTIONS_TMP_DIR, `${wavHash}.wav`);
  const whisperOutBase = join(CAPTIONS_TMP_DIR, `${wavHash}`);
  const whisperOutSrt = `${whisperOutBase}.srt`;

  await fs.mkdir(CAPTIONS_TMP_DIR, { recursive: true });

  try {
    logger.info(`[${jobId}] extracting audio: ${target.videoPath}`);
    await trackProcess('update', processFileKey, 1, 'in-progress', 'Extracting audio');
    await extractAudio(target.videoPath, wavPath);

    await trackProcess('update', processFileKey, 2, 'in-progress', 'Probing audio duration');
    let audioDurationSec;
    try {
      audioDurationSec = await getVideoDuration(target.videoPath);
    } catch (err) {
      logger.warn(`[${jobId}] could not probe duration (progress will be unavailable): ${err.message}`);
    }

    logger.info(`[${jobId}] running whisper: model=${config.model} lang=${langCode} duration=${audioDurationSec || '?'}s`);
    await trackProcess('update', processFileKey, 3, 'in-progress', `Transcribing (${config.model})`);

    // Throttle process_queue writes during transcription — whisper progress updates
    // can fire many times per second; we only need a coarse view in /processes.
    let lastTrackedPct = 0;
    await whisper.transcribe({
      wavPath,
      outputBase: whisperOutBase,
      modelName: config.model,
      language: langCode,
      threads: config.threads,
      audioDurationSec,
      onProgress: pct => {
        if (state) state.progressPct = pct;
        if (pct - lastTrackedPct >= 0.1) {
          lastTrackedPct = pct;
          trackProcess('update', processFileKey, 3, 'in-progress', `Transcribing (${Math.round(pct * 100)}%)`);
        }
      }
    });

    await trackProcess('update', processFileKey, 4, 'in-progress', 'Post-processing SRT');
    const rawSrt = await fs.readFile(whisperOutSrt, 'utf8');
    const cleaned = postProcessSrt(rawSrt);

    // Atomic write into the media folder
    await trackProcess('update', processFileKey, 5, 'in-progress', 'Writing SRT to disk');
    await fs.mkdir(dirname(target.srtPath), { recursive: true });
    const tmpFinal = `${target.srtPath}.tmp`;
    await fs.writeFile(tmpFinal, cleaned, 'utf8');
    await fs.rename(tmpFinal, target.srtPath);

    logger.info(`[${jobId}] wrote ${target.srtPath}`);
  } finally {
    await fs.unlink(wavPath).catch(() => {});
    await fs.unlink(whisperOutSrt).catch(() => {});
  }
}

/** Test-only: clear all in-memory state. */
export function _resetStateForTests() {
  jobs.clear();
  dedupeIndex.clear();
  health.lastSuccessAt = null;
  health.lastFailureAt = null;
  health.lastFailureReason = null;
}

/**
 * One-time sweep on startup: remove stale temp files left behind by interrupted
 * jobs. Files older than ORPHAN_AGE_MS in CAPTIONS_TMP_DIR are deleted.
 */
export async function sweepOrphanTempFiles() {
  try {
    await fs.mkdir(CAPTIONS_TMP_DIR, { recursive: true });
    const entries = await fs.readdir(CAPTIONS_TMP_DIR);
    const cutoff = Date.now() - ORPHAN_AGE_MS;
    let removed = 0;
    for (const name of entries) {
      const p = join(CAPTIONS_TMP_DIR, name);
      try {
        const st = await fs.stat(p);
        if (st.mtimeMs < cutoff) {
          await fs.unlink(p);
          removed++;
        }
      } catch { /* ignore */ }
    }
    if (removed > 0) {
      logger.info(`Swept ${removed} orphan caption temp files from ${CAPTIONS_TMP_DIR}`);
    }
  } catch (err) {
    logger.warn(`Orphan sweep failed (non-fatal): ${err.message}`);
  }
}

/**
 * Build the health response payload for GET /api/captions/health.
 */
export async function getHealthSnapshot() {
  const config = await getAutoCaptionsConfig().catch(err => {
    logger.error(`Failed to read autoCaptions config: ${err.message}`);
    return null;
  });

  const engine = config
    ? await whisper.inspect(config.model)
    : { binary: whisper.getBinaryPath(), binaryPresent: false, model: null, modelPath: null, modelPresent: false, modelSizeBytes: 0 };

  const taskStatus = getTaskStatus();
  const queued = taskStatus.queueSizes[TaskType.CAPTION_GENERATE] || 0;
  const active = taskStatus.activeTasks.filter(t => t.type === TaskType.CAPTION_GENERATE).length;

  let status;
  if (!config || !config.enabled) {
    status = 'disabled';
  } else if (!engine.binaryPresent || !engine.modelPresent) {
    status = 'unavailable';
  } else if (health.lastFailureAt && (!health.lastSuccessAt || health.lastFailureAt > health.lastSuccessAt)) {
    status = 'degraded';
  } else {
    status = 'ready';
  }

  const activeJobs = [...jobs.values()]
    .filter(j => j.status === 'running' || j.status === 'queued')
    .slice(0, 20)
    .map(j => ({
      jobId: j.jobId,
      dedupeKey: j.dedupeKey,
      status: j.status,
      progressPct: j.progressPct
    }));

  return {
    status,
    enabled: !!(config && config.enabled),
    engine,
    languages: config ? config.languages : [],
    queue: {
      active,
      queued,
      activeJobs,
      lastSuccessAt: health.lastSuccessAt,
      lastFailureAt: health.lastFailureAt,
      lastFailureReason: health.lastFailureReason
    },
    timestamp: new Date().toISOString()
  };
}
