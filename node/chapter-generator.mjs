import { createCategoryLogger } from './lib/logger.mjs';
import { getVideoDuration, chapterInfo } from './ffmpeg/ffprobe.mjs';
const logger = createCategoryLogger('chapter-generator');

export async function generateChapters(mediaPath, chapterData = null) {
  try {
    const chapters = chapterData || await chapterInfo(mediaPath) || [];

    if (chapters.length === 0) {
      logger.warn(`No chapter information found for ${mediaPath}`);
      return "WEBVTT\n\n"; // Return a default WebVTT content
    }

    const duration = await getVideoDuration(mediaPath);

    let vttContent = "WEBVTT\n\n";

    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const chapterIndex = i + 1;
      const startTime = formatTime(chapter.start_time);
      const endTime = i === chapters.length - 1 ? formatDuration(duration) : formatTime(chapters[i + 1].start_time);
      const chapterTitle = chapterTitleFor(chapter, chapterIndex);

      vttContent += `${startTime} --> ${endTime}\n${chapterTitle}\n\n`;
    }

    return vttContent;
  } catch (error) {
    let errorMessage;
    if (typeof error === 'object') {
      errorMessage = `Error generating chapters for ${mediaPath}: An unexpected object was encountered: ${error}`;
    } else {
      errorMessage = `Error generating chapters for ${mediaPath}: ${error.toString()}`;
    }
    logger.error(errorMessage);
    throw new Error(errorMessage);
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
