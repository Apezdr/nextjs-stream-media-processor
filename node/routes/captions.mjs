import express from 'express';
import { promises as fs } from 'fs';
import { createCategoryLogger } from '../lib/logger.mjs';
import {
  authenticateUser,
  requireAdmin,
  authenticateWebhookOrUser,
  extractSessionIdentifier,
  createRateLimiter
} from '../middleware/auth.mjs';
import { sessionManager } from '../middleware/sessionCache.mjs';
import {
  enqueueCaptionJob,
  resolveRequest,
  findInflightJob,
  getJob,
  getHealthSnapshot,
  FeatureDisabledError,
  LanguageNotAllowedError,
  TargetExistsError
} from '../components/caption-generator/index.mjs';

const logger = createCategoryLogger('captions-routes');

const RATE_LIMIT_PER_HOUR = parseInt(process.env.CAPTIONS_RATE_LIMIT_PER_HOUR, 10) || 10;

/**
 * Try to populate req.user from a session token, but don't reject if missing.
 * Used by the track endpoint, which serves existing files publicly and only
 * requires auth to trigger new generation.
 */
async function tryAttachUser(req) {
  try {
    const token = extractSessionIdentifier(req);
    if (!token) return null;
    const user = await sessionManager.getSession(token, req);
    if (!user || (!user.approved && !user.admin)) return null;
    req.user = user;
    return user;
  } catch (err) {
    logger.debug(`Soft auth failed: ${err.message}`);
    return null;
  }
}

/**
 * Routes for caption generation, status, and health.
 * - GET  /api/captions/track/movie/:title/:lang        (public read, authed trigger)
 * - GET  /api/captions/track/tv/:show/:lang/:season/:episode
 * - GET  /api/captions/jobs/:jobId                     (public — IDs unguessable)
 * - GET  /api/captions/health                          (webhook OR admin)
 * - POST /api/admin/captions/generate                  (admin)
 */
export function setupCaptionsRoutes() {
  const router = express.Router();

  // Rate limiter for the JIT trigger branch and the admin POST endpoint.
  const triggerLimiter = createRateLimiter(RATE_LIMIT_PER_HOUR, 60 * 60 * 1000);

  // ---- Track endpoint ----------------------------------------------------

  async function handleTrack(req, res, parsed) {
    try {
      const target = await resolveRequest({
        mediaType: parsed.mediaType,
        mediaTitle: parsed.title,
        language: parsed.lang,
        season: parsed.season,
        episode: parsed.episode
      });

      // 1) File on disk → 302 to the static URL so nginx/CDN serves the bytes.
      // The redirect itself is cached briefly so repeat plays bypass Node entirely.
      try {
        await fs.access(target.srtPath);
        res.set('Cache-Control', 'public, max-age=300');
        return res.redirect(302, target.srtPublicUrl);
      } catch { /* not on disk — continue */ }

      // 2) Already an in-flight job → return its state without re-auth
      const inflight = findInflightJob(target.videoPath, parsed.lang);
      if (inflight) {
        return jobStatusResponse(res, inflight, target.srtPath);
      }

      // 3) Need to enqueue → require an authenticated user, then rate-limit
      const user = await tryAttachUser(req);
      if (!user) {
        return res.status(401).json({
          error: 'Authentication required to generate captions',
          message: 'No cached track exists. Sign in to request generation.'
        });
      }

      // Run the rate limiter imperatively
      await new Promise((resolve, reject) => {
        triggerLimiter(req, res, err => err ? reject(err) : resolve());
      }).catch(() => null);
      if (res.headersSent) return; // limiter already responded with 429

      const job = await enqueueCaptionJob({
        mediaType: parsed.mediaType,
        mediaTitle: parsed.title,
        language: parsed.lang,
        season: parsed.season,
        episode: parsed.episode
      });

      logger.info(`Caption track requested by ${user.email}: ${parsed.mediaType}/${parsed.title} [${parsed.lang}] → job ${job.jobId}`);
      return jobStatusResponse(res, job, target.srtPath);
    } catch (err) {
      return mapEnqueueError(res, err);
    }
  }

  router.get('/captions/track/movie/:title/:lang', (req, res) =>
    handleTrack(req, res, {
      mediaType: 'movie',
      title: req.params.title,
      lang: req.params.lang
    })
  );

  router.get('/captions/track/tv/:show/:lang/:season/:episode', (req, res) =>
    handleTrack(req, res, {
      mediaType: 'tv',
      title: req.params.show,
      lang: req.params.lang,
      season: req.params.season,
      episode: req.params.episode
    })
  );

  // ---- Jobs poll endpoint ------------------------------------------------

  router.get('/captions/jobs/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found', jobId: req.params.jobId });
    }
    return res.json({
      jobId: job.jobId,
      status: job.status,
      queuePosition: job.queuePosition ?? null,
      progressPct: job.progressPct,
      expectedPath: job.expectedPath,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error
    });
  });

  // ---- Health -------------------------------------------------------------

  router.get('/captions/health', authenticateWebhookOrUser, async (req, res) => {
    try {
      const snapshot = await getHealthSnapshot();
      snapshot.queue.maxJobsPerUserPerHour = RATE_LIMIT_PER_HOUR;
      res.set('Cache-Control', 'public, max-age=15');
      return res.json(snapshot);
    } catch (err) {
      logger.error(`Failed to build captions health snapshot: ${err.message}`);
      return res.status(500).json({
        status: 'error',
        message: err.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // ---- Admin manual generate ---------------------------------------------

  router.post(
    '/admin/captions/generate',
    authenticateUser,
    requireAdmin,
    triggerLimiter,
    async (req, res) => {
      try {
        const { mediaType, mediaTitle, language, season, episode, force = false } = req.body || {};

        if (!mediaType || (mediaType !== 'movie' && mediaType !== 'tv')) {
          return res.status(400).json({ error: 'mediaType must be "movie" or "tv"' });
        }
        if (!mediaTitle) return res.status(400).json({ error: 'mediaTitle is required' });
        if (!language) return res.status(400).json({ error: 'language is required' });
        if (mediaType === 'tv' && (!season || !episode)) {
          return res.status(400).json({ error: 'season and episode are required for mediaType=tv' });
        }

        const job = await enqueueCaptionJob({ mediaType, mediaTitle, language, season, episode, force });
        logger.info(`Admin caption job enqueued by ${req.user?.email}: ${job.jobId} → ${job.expectedPath}`);
        return res.status(job.status === 'succeeded' ? 200 : 202).json({
          success: true,
          ...jobBody(job)
        });
      } catch (err) {
        return mapEnqueueError(res, err);
      }
    }
  );

  return router;
}

// ---- helpers --------------------------------------------------------------

function jobBody(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    queuePosition: job.queuePosition ?? null,
    progressPct: job.progressPct,
    expectedPath: job.expectedPath,
    pollUrl: `/api/captions/jobs/${job.jobId}`
  };
}

function jobStatusResponse(res, job, expectedPath) {
  return res.status(202).json(jobBody({ ...job, expectedPath }));
}

function mapEnqueueError(res, err) {
  if (err instanceof FeatureDisabledError) {
    return res.status(503).json({ error: err.message, code: err.code });
  }
  if (err instanceof LanguageNotAllowedError) {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  if (err instanceof TargetExistsError) {
    return res.status(409).json({ error: err.message, code: err.code, path: err.path });
  }
  // resolveTarget throws plain Errors for missing files — surface as 404
  if (err && /not found/i.test(err.message)) {
    return res.status(404).json({ error: err.message });
  }
  return res.status(500).json({ error: err?.message || 'Internal error' });
}
