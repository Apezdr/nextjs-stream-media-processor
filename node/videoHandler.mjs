// videoHandler.mjs
//
// GET /videoClip/movie/:movieName and /videoClip/tv/:showName/:season/:episode
//   ?start=<s>&end=<s>[&quality=high|medium|low][&codec=h264|av1][&encoder=software|gpu]
//   [&useOriginalVideo=true]
//
// A short clip of a title, made once and cached on disk as MP4. What the two
// kinds of clip are, and why, is in ffmpeg/clipEncode.mjs. This file is the
// request side:
//
//   1. Validate the query and find the title's video file.
//   2. Look for the clip in the cache. A hit costs a stat and nothing else — no
//      ffprobe, because a player asks for one clip many times over (range
//      requests), and every one of them used to pay for a probe.
//   3. On a miss, probe the source and join the job that makes the clip. Every
//      request for the same clip shares that one job (utils/clipJobs.mjs).
//   4. Send the file with range support (utils/rangeFile.mjs).
//
// A clip is written to a temp file and renamed into place when ffmpeg is done,
// so step 2 can never find a clip that is still being written.

import os from 'os';
import { fileExists, getCachedClipPath } from './utils/utils.mjs';
import { resolveMovieVideo, resolveEpisodeVideo, findEpisodeEntry } from './utils/mediaResolution.mjs';
import { getTVShowByName, getMovieByName } from './sqliteDatabase.mjs';
import { getInfo } from './infoManager.mjs';
import { createCategoryLogger } from './lib/logger.mjs';
import {
  resolveClipCodec,
  resolveClipEncoderChoice,
  av1EncoderChoiceFromEnvironment,
  CLIP_CODEC_VALUES,
  CLIP_ENCODER_VALUES,
} from './utils/clipCodec.mjs';
import { createClipJobRunner } from './utils/clipJobs.mjs';
import { sendFileWithRanges } from './utils/rangeFile.mjs';
import {
  probeClipSource,
  canCopyOriginal,
  transcodeClip,
  copyOriginalClip,
  ClipNotCopyableError,
  resolveClipQuality,
  clipEncoderAvailable,
  CLIP_QUALITY_VALUES,
} from './ffmpeg/clipEncode.mjs';

const logger = createCategoryLogger('videoHandler');

// Part of every cache filename. Bump it whenever the bytes of a clip would come
// out different (codec, container, filters), so no file made under the old
// rules is served under the new ones. Files of an older version are never
// looked up again and age out with the rest of the cache.
//   2: H.264/AAC MP4 for every encoded clip (was the hardware encoder's choice,
//      VP9/WebM on Arc); original-quality clips are always MP4 (was the
//      source's container).
const VIDEO_CLIP_VERSION = 2;

const MAX_CLIP_DURATION = 600; // 10 minutes

// An original-quality clip keeps the source's bitrate: two minutes of a UHD
// remux is already about 1 GB in the cache. The TV app asks for 50 s.
const MAX_ORIGINAL_CLIP_DURATION = 120;

const CLIP_CONTENT_TYPE = 'video/mp4';
const CLIP_CACHE_CONTROL = 'public, max-age=31536000'; // 1 year

/**
 * How many clips may be encoded at once. VIDEO_CLIP_CONCURRENCY sets it;
 * otherwise one per eight logical CPUs, between 2 and 4. Each encode already
 * spreads across many cores, so this is about not starving the scanner and the
 * other ffmpeg users, not about using the machine fully.
 */
function transcodeConcurrency() {
  const raw = process.env.VIDEO_CLIP_CONCURRENCY;
  if (raw !== undefined && raw !== '') {
    const configured = Number(raw);
    if (Number.isInteger(configured) && configured > 0) return configured;
    logger.warn(`Ignoring VIDEO_CLIP_CONCURRENCY="${raw}": it must be a positive whole number`);
  }
  return Math.min(4, Math.max(2, Math.floor(os.availableParallelism() / 8)));
}

// Separate lanes. A stream copy takes about two seconds and the TV app gives a
// clip ten to become playable; it must not wait behind a 2160p encode that can
// run for most of a minute.
const transcodeJobs = createClipJobRunner({ concurrency: transcodeConcurrency() });
const copyJobs = createClipJobRunner({ concurrency: 2 });

// Probe results by source identity (info.uuid), so a burst of requests for a
// clip that is not cached yet runs ffprobe once, not once each. Holds promises;
// a failed probe is forgotten so the next request tries again.
const SOURCE_MEMO_LIMIT = 500;
const sourceMemo = new Map();

function describeSource({ videoPath, sourceId }) {
  let pending = sourceMemo.get(sourceId);
  if (!pending) {
    pending = probeClipSource(videoPath);
    sourceMemo.set(sourceId, pending);
    pending.catch(() => {
      if (sourceMemo.get(sourceId) === pending) sourceMemo.delete(sourceId);
    });
    if (sourceMemo.size > SOURCE_MEMO_LIMIT) {
      sourceMemo.delete(sourceMemo.keys().next().value); // oldest entry
    }
  }
  return pending;
}

// A way of making a clip that has a fallback (a stream copy, a GPU encode) is
// not tried again for a while once it has failed for that clip. The TV app
// asks for the same clip every time its banner comes round, and without this
// each of those requests would run (and log) the same failing ffmpeg before
// falling back.
const RETRY_FAILED_AFTER_MS = 10 * 60 * 1000;
const RECENT_FAILURE_LIMIT = 500;
const recentFailures = new Map(); // cache key -> time it may be tried again

function failedRecently(cacheKey) {
  const retryAt = recentFailures.get(cacheKey);
  if (retryAt === undefined) return false;
  if (Date.now() < retryAt) return true;
  recentFailures.delete(cacheKey);
  return false;
}

function rememberFailure(cacheKey) {
  recentFailures.delete(cacheKey); // re-insert, so the map stays in age order
  recentFailures.set(cacheKey, Date.now() + RETRY_FAILED_AFTER_MS);
  if (recentFailures.size > RECENT_FAILURE_LIMIT) {
    recentFailures.delete(recentFailures.keys().next().value); // oldest entry
  }
}

// How each encoder's clips are named in the cache: the codec, then the quality
// level, then (for AV1, which has two) which encoder made it. The two AV1
// encoders are tuned to the same levels but do not write the same bytes, so a
// clip is cached as what it is.
const clipCachePath = (clip, encoder) =>
  getCachedClipPath(
    {
      libx264: `${clip.keyBase}-h264-${clip.quality}`,
      libsvtav1: `${clip.keyBase}-av1-${clip.quality}-svt`,
      av1_qsv: `${clip.keyBase}-av1-${clip.quality}-qsv`,
    }[encoder],
    '.mp4'
  );

const AV1_ENCODERS = Object.freeze(['av1_qsv', 'libsvtav1']);

let warnedAboutEncoderEnvironment = false;

/** `software` or `gpu`: what makes an AV1 clip when the URL does not say. */
function defaultAv1EncoderChoice() {
  const { choice, invalid } = av1EncoderChoiceFromEnvironment(process.env.VIDEO_CLIP_AV1_ENCODER);
  if (invalid && !warnedAboutEncoderEnvironment) {
    warnedAboutEncoderEnvironment = true;
    logger.warn(
      `Ignoring VIDEO_CLIP_AV1_ENCODER="${process.env.VIDEO_CLIP_AV1_ENCODER}": ` +
      `it must be one of ${CLIP_ENCODER_VALUES.join(', ')}`
    );
  }
  return choice;
}

/**
 * How a request's encoded clip is found and, if need be, made.
 *
 *   make     The encoders to make it with, in the order to try them. The last
 *            is the one whose failure is the request's failure; one before it
 *            falls through to the next.
 *   accept   The encoders whose cached clip the request will take as it is.
 *
 * H.264 has one encoder. AV1 has the software encoder, preceded by the GPU's
 * when the GPU is asked for (by `?encoder=gpu`, or by VIDEO_CLIP_AV1_ENCODER for
 * a URL that does not say) and this server has one that works.
 *
 * A URL that names an encoder gets that encoder's clip, so the two can be told
 * apart. One that does not (every URL a page builds) takes whichever AV1 clip
 * already exists: changing the server default must not re-encode the cache.
 *
 * @param {'h264'|'av1'} codec
 * @param {'software'|'gpu'|undefined} encoderChoice - From the URL; undefined when it does not say
 * @returns {Promise<{ make: string[], accept: string[] }|null>} null when this
 *   server cannot make the codec at all
 */
async function planEncoders(codec, encoderChoice) {
  if (codec === 'h264') return { make: ['libx264'], accept: ['libx264'] };

  const make = [];
  if ((encoderChoice ?? defaultAv1EncoderChoice()) === 'gpu' && (await clipEncoderAvailable('av1_qsv'))) {
    make.push('av1_qsv');
  }
  if (await clipEncoderAvailable('libsvtav1')) {
    make.push('libsvtav1');
  }
  if (make.length === 0) return null;

  const accept = encoderChoice === undefined
    ? [...make, ...AV1_ENCODERS.filter((encoder) => !make.includes(encoder))]
    : [make[0]];
  return { make, accept };
}

/** What `?codec=` can be on this server, for the message that refuses anything else. */
async function supportedCodecValues() {
  const av1 = (await planEncoders('av1', undefined)) !== null;
  return CLIP_CODEC_VALUES.filter((value) => value !== 'av1' || av1);
}

/** The title the request names is not in the library. Answered with a 404. */
class ClipNotFoundError extends Error {}

/**
 * Find the video file a clip request is about.
 * @returns {Promise<{ title: string, videoPath: string|null }>}
 * @throws {ClipNotFoundError} when the movie, show or episode is unknown
 */
async function resolveClipMedia(type, params, basePath) {
  if (type === 'movies') {
    const { movieName } = params;
    const movieData = await getMovieByName(movieName);
    if (!movieData) {
      throw new ClipNotFoundError(`Movie not found: ${movieName}`);
    }
    const videoRef = await resolveMovieVideo({ basePath, movieName });
    return { title: movieData.name, videoPath: videoRef?.path ?? null };
  }

  const { showName, season, episode } = params;
  const showData = await getTVShowByName(showName);
  if (!showData) {
    throw new ClipNotFoundError(`Show not found: ${showName}`);
  }

  const entry = findEpisodeEntry(showData, season, episode);
  if (!entry) {
    throw new ClipNotFoundError(`Episode not found: ${showName} - Season ${season} Episode ${episode}`);
  }

  const videoRef = await resolveEpisodeVideo({
    basePath,
    showName,
    season,
    episode,
    preferFilename: entry.episode.filename,
  });
  return { title: showData.name, videoPath: videoRef?.path ?? null };
}

/**
 * Wait for the job that makes a clip, as one of possibly several requests
 * waiting on it. If this request's client disconnects first, it leaves the job
 * (which is dropped if nobody else wants it and it has not started).
 *
 * @returns {Promise<boolean>} true when the clip is ready and the client is
 *   still there to receive it; false when the client has gone
 * @throws when the job fails and the client is still waiting to hear about it
 */
async function waitForClip(res, jobs, cacheKey, produce) {
  if (res.destroyed) return false;

  const ticket = jobs.join(cacheKey, produce);
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    ticket.leave();
  };
  res.once('close', onClose);

  try {
    await ticket.done;
  } catch (error) {
    if (clientGone) return false;
    throw error;
  } finally {
    res.off('close', onClose);
  }
  return !clientGone;
}

/** Answer 400 if the clip runs past the end of the source. */
function rejectIfPastEnd(res, clip, source) {
  if (source.duration !== null && clip.end > source.duration) {
    res.status(400).send('End time exceeds video duration.');
    return true;
  }
  return false;
}

/**
 * The original-quality clip (?useOriginalVideo=true).
 *
 * @returns {Promise<boolean>} true when the request has been dealt with; false
 *   when this source cannot be copied and the caller should send the
 *   transcoded clip instead
 */
async function serveOriginalClip(req, res, clip) {
  if (clip.duration > MAX_ORIGINAL_CLIP_DURATION) {
    res.status(400).send(`Original-quality clips are limited to ${MAX_ORIGINAL_CLIP_DURATION} seconds.`);
    return true;
  }

  // The `-original` suffix is what clearOriginalSegmentsCache (utils.mjs)
  // matches to give these files their short life. Change one, change the other.
  const cacheKey = `${clip.keyBase}-original`;
  const cachedPath = getCachedClipPath(cacheKey, '.mp4');

  if (!(await fileExists(cachedPath))) {
    if (failedRecently(cacheKey)) return false;

    const source = await describeSource(clip);
    if (rejectIfPastEnd(res, clip, source)) return true;

    if (!canCopyOriginal(source)) {
      logger.info(
        `Original-quality clip of ${clip.title} is not a copy candidate ` +
        `(${source.codec} ${source.pixFmt}${source.dovi ? ', Dolby Vision RPU' : ''}); sending the transcode`
      );
      return false;
    }

    try {
      const clientWaiting = await waitForClip(res, copyJobs, cacheKey, async () => {
        // Checked again inside the job: one finished between the lookup above and now.
        if (await fileExists(cachedPath)) return;
        logger.info(`Copying original-quality clip: ${cacheKey}`);
        await copyOriginalClip({
          videoPath: clip.videoPath,
          start: clip.start,
          duration: clip.duration,
          source,
          outputPath: cachedPath,
        });
      });
      if (!clientWaiting) return true;
    } catch (error) {
      // The transcode is the clip that always works; the copy is the better
      // picture when it can be had. So a copy that fails is reported and the
      // viewer still gets a clip.
      if (error instanceof ClipNotCopyableError) {
        logger.info(`Original-quality clip of ${clip.title}: ${error.message}; sending the transcode`);
      } else {
        logger.error(`Original-quality clip of ${clip.title} failed, sending the transcode: ${error.message}`);
      }
      rememberFailure(cacheKey);
      return false;
    }
  }

  // These files are evicted eight minutes after their last use, so say when that was.
  await sendFileWithRanges(req, res, cachedPath, {
    contentType: CLIP_CONTENT_TYPE,
    cacheControl: CLIP_CACHE_CONTROL,
    touchAccessTime: true,
  });
  return true;
}

/**
 * The encoded clip: what a browser gets, and the fallback for the original
 * path. Each codec, quality level and encoder is its own file; see
 * planEncoders for which of them a request takes and makes.
 */
async function serveTranscodedClip(req, res, clip) {
  const send = (cachedPath) =>
    sendFileWithRanges(req, res, cachedPath, {
      contentType: CLIP_CONTENT_TYPE,
      cacheControl: CLIP_CACHE_CONTROL,
    });

  // Anything already made that this request can have, before making anything.
  for (const encoder of clip.encoders.accept) {
    const cachedPath = clipCachePath(clip, encoder);
    if (await fileExists(cachedPath)) return send(cachedPath);
  }

  const source = await describeSource(clip);
  if (rejectIfPastEnd(res, clip, source)) return;

  for (const [index, encoder] of clip.encoders.make.entries()) {
    const fallback = clip.encoders.make[index + 1];
    const cachedPath = clipCachePath(clip, encoder);
    const cacheKey = cachedPath; // one job, and one failure record, per file

    if (!(await fileExists(cachedPath))) {
      if (fallback && failedRecently(cacheKey)) continue;

      try {
        const clientWaiting = await waitForClip(res, transcodeJobs, cacheKey, async () => {
          if (await fileExists(cachedPath)) return;
          logger.info(`Encoding clip with ${encoder}: ${cachedPath}`);
          await transcodeClip({
            videoPath: clip.videoPath,
            start: clip.start,
            duration: clip.duration,
            source,
            quality: clip.quality,
            encoder,
            outputPath: cachedPath,
          });
        });
        if (!clientWaiting) return;
      } catch (error) {
        if (!fallback) throw error;
        // The GPU was asked to do this and could not. The same clip from the
        // software encoder is still the clip the request wanted.
        logger.error(`${encoder} failed for ${cachedPath}, making the clip with ${fallback}: ${error.message}`);
        rememberFailure(cacheKey);
        continue;
      }
    }

    return send(cachedPath);
  }
}

/**
 * Handles video clip requests: a cached MP4 clip of a movie or episode.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {string} type - Type of media ('movies' or 'tv').
 * @param {string} basePath - Base path to media files.
 */
export async function handleVideoClipRequest(req, res, type, basePath) {
  const useOriginalVideo = req.query.useOriginalVideo === 'true';
  try {
    // Parse and validate start and end parameters
    const start = parseFloat(req.query.start);
    const end = parseFloat(req.query.end);

    if (isNaN(start) || isNaN(end) || start < 0 || end <= start) {
      return res.status(400).send('Invalid start or end parameters.');
    }

    if ((end - start) > MAX_CLIP_DURATION) {
      return res.status(400).send(`Clip duration exceeds maximum allowed duration of ${MAX_CLIP_DURATION} seconds.`);
    }

    // See utils/clipCodec.mjs. Not echoed back: res.send answers text/html.
    const codec = resolveClipCodec(req.query.codec);
    if (!codec) {
      return res.status(400).send(`Unsupported codec. Supported values: ${(await supportedCodecValues()).join(', ')}.`);
    }

    const encoderChoice = resolveClipEncoderChoice(req.query.encoder);
    if (encoderChoice === null) {
      return res.status(400).send(`Unsupported encoder. Supported values: ${CLIP_ENCODER_VALUES.join(', ')}.`);
    }
    if (encoderChoice !== undefined && codec !== 'av1') {
      return res.status(400).send('The encoder parameter applies to codec=av1 only.');
    }

    // A server whose ffmpeg cannot make AV1 refuses it exactly as it did before
    // AV1 was an option. A page that lists the AV1 URL first then plays the
    // H.264 one, which is the point of listing both.
    const encoders = await planEncoders(codec, encoderChoice);
    if (!encoders) {
      return res.status(400).send(`Unsupported codec. Supported values: ${(await supportedCodecValues()).join(', ')}.`);
    }

    // How much picture the encoded clip carries (CLIP_QUALITIES in
    // ffmpeg/clipEncode.mjs). An original-quality clip is a copy and has no
    // levels; there it only decides the clip sent when the source cannot be copied.
    const quality = resolveClipQuality(req.query.quality);
    if (!quality) {
      return res.status(400).send(`Unsupported quality. Supported values: ${CLIP_QUALITY_VALUES.join(', ')}.`);
    }

    const { title, videoPath } = await resolveClipMedia(type, req.params, basePath);

    // Check if video file exists
    if (!videoPath || !(await fileExists(videoPath))) {
      return res.status(404).send('Video not found.');
    }

    // The file's identity, not its path or title: replacing a video in place
    // rotates the uuid (infoManager.mjs), which retires every clip cut from
    // the old file.
    const info = await getInfo(videoPath);
    if (!info?.uuid) {
      throw new Error(`No uuid in the .info sidecar of ${videoPath}`);
    }

    const clip = {
      title,
      videoPath,
      sourceId: info.uuid,
      start,
      end,
      duration: end - start,
      quality,
      encoders,
      keyBase: `${title}-key_${info.uuid}-start_${start}-end_${end}-v${VIDEO_CLIP_VERSION}`,
    };

    if (useOriginalVideo && (await serveOriginalClip(req, res, clip))) {
      return;
    }
    await serveTranscodedClip(req, res, clip);
  } catch (error) {
    logger.error('Error in clip generation:' + error.message);
    if (res.destroyed) {
      return; // the client has gone; there is nobody to answer
    }
    if (res.headersSent) {
      res.end();
      return;
    }

    // Provide helpful error responses based on error type
    // Use 4xx status codes to avoid Apache error page interception
    let statusCode = 422; // Unprocessable Entity - for processing failures
    let errorMessage = "Failed to generate video clip";
    let details = {};

    if (error instanceof ClipNotFoundError) {
      statusCode = 404;
      errorMessage = error.message;
      details = {
        suggestion: "Verify the media exists in the library"
      };
    } else if (error.message.includes("FFmpeg")) {
      errorMessage = "Video encoding error";
      details = {
        suggestion: "The video file may have encoding issues or unsupported format",
        ...(!useOriginalVideo && { hint: "Try using ?useOriginalVideo=true to serve without re-encoding" })
      };
    }

    // Ensure proper Content-Type to prevent Apache interception
    res.setHeader('Content-Type', 'application/json');
    res.status(statusCode).json({
      error: errorMessage,
      statusCode,
      timestamp: new Date().toISOString(),
      type: type,
      ...(Object.keys(details).length > 0 && { details })
    });
  }
}
