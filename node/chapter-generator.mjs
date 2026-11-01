// chapter-generator.mjs
//
// A video's chapters file (chapters/<name>_chapters.vtt), kept in step with
// the video it came from. The scanners used to write it only when it was
// missing, so a folder whose video was replaced (an upgrade to another
// release) kept the old video's chapters: 38 chapters to 2:51:57 against a
// 2:03:47 video, and the chapter menu asked /frame for times past the end.
//
// Each file now names its source in a NOTE block (a WebVTT comment, which
// players skip): a hash of the video's file name and size. A file whose NOTE
// is missing or names another video is rebuilt from the current one, or
// removed when that video has no chapters. Chapters starting at or past the
// end of the video (a 24:00:00 end marker, say) are dropped.

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { basename, dirname } from 'path';
import { createCategoryLogger } from './lib/logger.mjs';
import { getVideoDuration, chapterInfo } from './ffmpeg/ffprobe.mjs';
const logger = createCategoryLogger('chapter-generator');

const SOURCE_NOTE = /^NOTE source ([0-9a-f]{16})$/m;

/**
 * Which video a chapters file was built from: its file name and size. A
 * replaced video differs in at least one, an untouched one in neither.
 * @param {string} mediaPath
 * @returns {Promise<string>} 16 hex digits
 */
export async function videoSourceStamp(mediaPath) {
  const { size } = await fs.stat(mediaPath);
  return createHash('sha256').update(`${basename(mediaPath)}\n${size}`).digest('hex').slice(0, 16);
}

/**
 * The chapters file for these chapters, or null when none starts before the
 * end of the video. The last cue ends at the duration.
 * @param {Array<{start_time: string, tags?: {title?: string}}>} chapters - From chapterInfo.
 * @param {number} duration - The video's length in seconds.
 * @param {string} source - videoSourceStamp of the video.
 * @returns {string|null}
 */
export function chaptersVtt(chapters, duration, source) {
  const inRange = chapters.filter((chapter) => parseFloat(chapter.start_time) < duration);
  if (inRange.length === 0) return null;

  let vttContent = `WEBVTT\n\nNOTE source ${source}\n\n`;
  for (let i = 0; i < inRange.length; i++) {
    const chapter = inRange[i];
    const startTime = formatTime(chapter.start_time);
    const endTime = i === inRange.length - 1 ? formatDuration(duration) : formatTime(inRange[i + 1].start_time);
    vttContent += `${startTime} --> ${endTime}\n${chapterTitleFor(chapter, i + 1)}\n\n`;
  }
  return vttContent;
}

/**
 * Bring the chapters file at `chaptersPath` in step with the video at
 * `mediaPath`: keep it when it names this video, otherwise rebuild it, or
 * remove it when the video has no chapters before its end. Never throws: a
 * probe that fails is logged and leaves the file as it was.
 *
 * Callers compute the directory hash after this, since the hash covers
 * chapters/ (see the scanners).
 * @param {string} chaptersPath
 * @param {string} mediaPath
 * @returns {Promise<void>}
 */
export async function syncChapterFile(chaptersPath, mediaPath) {
  try {
    const source = await videoSourceStamp(mediaPath);
    const existing = await fs.readFile(chaptersPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing !== null && SOURCE_NOTE.exec(existing)?.[1] === source) return;

    const chapters = (await chapterInfo(mediaPath)) ?? [];
    const content = chapters.length > 0 ? chaptersVtt(chapters, await getVideoDuration(mediaPath), source) : null;

    if (content === null) {
      if (existing !== null) {
        await fs.rm(chaptersPath, { force: true });
        logger.info(`Removed a chapters file whose video has no chapters before its end: ${chaptersPath}`);
      }
      return;
    }
    await fs.mkdir(dirname(chaptersPath), { recursive: true });
    await fs.writeFile(chaptersPath, content);
    logger.debug(`${existing === null ? 'Generated' : 'Rebuilt'} chapter file: ${chaptersPath}`);
  } catch (error) {
    logger.error(`Failed to generate chapters for ${mediaPath}: ${error.message}`);
  }
}

/**
 * Cue text for a chapter: the source title when it carries information,
 * otherwise "Chapter NN". ffprobe exposes titles under `tags`; the old
 * `metadata` lookup matched nothing, so every chapter was generic.
 *
 * The frontend shows raw cue text, so nothing is entity-escaped; the title is
 * only forced onto one line (a blank line ends a cue) with no "-->" in it.
 * Titles that are empty, all punctuation (a lone backslash), or a bare timestamp (what
 * some muxers write when a chapter has no name) fall back too.
 * @param {{tags?: {title?: string}}} chapter - One entry from chapterInfo.
 * @param {number} index - 1-based chapter number, used by the fallback.
 * @returns {string}
 */
export function chapterTitleFor(chapter, index) {
  const fallback = `Chapter ${String(index).padStart(2, "0")}`;
  const raw = chapter?.tags?.title;
  if (typeof raw !== "string") {
    return fallback;
  }
  const title = raw.replace(/\s+/g, " ").replace(/-->/g, "-").trim();
  const hasContent = /[\p{L}\p{N}]/u.test(title);
  const isBareTimestamp = /^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?$/.test(title);
  return hasContent && !isBareTimestamp ? title : fallback;
}

function formatTime(timeString) {
  if (!timeString) {
    return '00:00:00.000'; // Return a default time if timeString is falsy
  }

  const decimalTimeRegex = /^\d+\.\d+$/;
  if (decimalTimeRegex.test(timeString)) {
    // Handle decimal time format
    const totalSeconds = parseFloat(timeString);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const milliseconds = Math.floor((totalSeconds % 1) * 1000);

    const formattedTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
    return formattedTime;
  }

  const timeRegex = /^(\d+):?(\d+):?(\d+(?:\.\d+)?)?$/;
  const match = timeString.match(timeRegex);

  if (!match) {
    logger.warn(`Invalid time string format: ${timeString}`);
    return '00:00:00.000'; // Return a default time if the format is invalid
  }

  const [, hours, minutes, seconds] = match;
  const [secondsPart, millisecondsPart = '000'] = (seconds || '0').split('.');

  const formattedTime = `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${secondsPart.padStart(2, '0')}.${millisecondsPart.padStart(3, '0')}`;
  return formattedTime;
}

function formatDuration(totalSecondsInput) {
  // Ensure the input is treated as a floating-point number
  const totalSeconds = parseFloat(totalSecondsInput);

  if (isNaN(totalSeconds) || totalSeconds < 0) {
    logger.warn(`Invalid duration value: ${totalSecondsInput}, returning default timestamp.`);
    return '00:00:00.000'; // Or handle error as appropriate
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60); // Integer part of seconds
  const milliseconds = Math.floor((totalSeconds % 1) * 1000); // Fractional part as milliseconds

  const formattedTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
  return formattedTime;
}
