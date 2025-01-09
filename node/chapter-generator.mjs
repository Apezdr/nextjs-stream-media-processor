import { createCategoryLogger } from './lib/logger.mjs';
import { getVideoDuration, chapterInfo } from './ffmpeg/ffprobe.mjs';
const logger = createCategoryLogger('chapter-generator');

export async function generateChapters(mediaPath) {
  try {
    const chapters = await chapterInfo(mediaPath) || [];

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
      const chapterTitle = chapter.metadata ? chapter.metadata.title : `Chapter ${chapterIndex.toString().padStart(2, "0")}`;

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

function formatDuration(durationMillis) {
  const durationSeconds = Math.floor(durationMillis / 1000);
  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);
  const seconds = durationSeconds % 60;
  const formattedDuration = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.000`;
  return formattedDuration;
}
