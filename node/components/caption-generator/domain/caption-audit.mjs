import { promises as fs } from 'fs';
import { join } from 'path';
import { isVideoFile } from '../../../utils/mediaResolution.mjs';
import { stripVideoExtension } from '../../../utils/utils.mjs';
import { judgeUnmappedCaption } from './audio-track.mjs';

/**
 * Finding the auto-captions on disk that should not be there, or were made from
 * the wrong audio.
 *
 * Until captions were transcribed from a track chosen by language
 * (audio-track.mjs), each was made from whichever track ffmpeg picked. Those
 * files are still in the media folders, served as "English - Auto Generated".
 * This module lists every `.auto.srt` and says what to do with it; the
 * controller does it.
 */

const AUTO_CAPTION_FILE = /^(.+)\.([a-z]{2,3})\.auto\.srt$/i;

async function entriesOf(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function captionsIn(dir, entries, describe) {
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const captions = [];
  for (const name of files) {
    const match = name.match(AUTO_CAPTION_FILE);
    if (!match) continue;
    const [, base, language] = match;
    captions.push({
      srtPath: join(dir, name),
      language: language.toLowerCase(),
      // The caption is named after the video it was made from.
      videoFile: files.find((file) => isVideoFile(file) && stripVideoExtension(file) === base) ?? null,
      videoDir: dir,
      ...describe(name),
    });
  }
  return captions;
}

/**
 * Every auto-caption under the media root, with the title it belongs to in the
 * terms a caption request uses.
 *
 * @param {string} basePath - Media root (BASE_PATH)
 * @returns {Promise<Array<{ srtPath: string, language: string, videoFile: string|null,
 *   videoDir: string, mediaType: 'movie'|'tv', mediaTitle: string,
 *   season: string|null, episode: string|null }>>}
 */
export async function listAutoCaptions(basePath) {
  const captions = [];

  const moviesDir = join(basePath, 'movies');
  for (const movie of await entriesOf(moviesDir)) {
    if (!movie.isDirectory()) continue;
    const dir = join(moviesDir, movie.name);
    captions.push(
      ...captionsIn(dir, await entriesOf(dir), () => ({
        mediaType: 'movie',
        mediaTitle: movie.name,
        season: null,
        episode: null,
      }))
    );
  }

  const tvDir = join(basePath, 'tv');
  for (const show of await entriesOf(tvDir)) {
    if (!show.isDirectory()) continue;
    const showDir = join(tvDir, show.name);
    for (const seasonFolder of await entriesOf(showDir)) {
      if (!seasonFolder.isDirectory()) continue;
      // The season number is the folder's first run of digits, as the scanner reads it.
      const season = seasonFolder.name.match(/\d+/)?.[0] ?? null;
      const dir = join(showDir, seasonFolder.name);
      captions.push(
        ...captionsIn(dir, await entriesOf(dir), (name) => ({
          mediaType: 'tv',
          mediaTitle: show.name,
          season,
          episode: name.match(/S\d+E(\d+)/i)?.[1] ?? null,
        }))
      );
    }
  }

  return captions;
}

/**
 * What to do with one auto-caption.
 *
 * @param {Object} params
 * @param {boolean} params.hasVideo - The video the caption is named after is still there
 * @param {Array<Object>|null} params.tracks - That video's audio tracks (null without a video)
 * @param {string} params.language - The caption's language, from its filename
 * @param {Date} params.writtenAt - The caption file's modification time
 * @param {Date|null} params.madeBefore - Captions written from this moment on were made
 *   from a track chosen by language, and are not second-guessed. Null judges them all.
 * @returns {{ verdict: 'ok'|'orphan'|'no-audio-in-language'|'wrong-track', action: 'keep'|'remove'|'regenerate' }}
 *   'orphan': its video is gone (replaced by another release). Remove.
 *   'no-audio-in-language': the video has no track tagged with the caption's
 *     language, so no caption would be made for it now. Remove.
 *   'wrong-track': ffmpeg's own pick was not such a track, and the video has
 *     one. Make it again.
 */
export function decideAutoCaption({ hasVideo, tracks, language, writtenAt, madeBefore }) {
  if (!hasVideo) return { verdict: 'orphan', action: 'remove' };

  const verdict = judgeUnmappedCaption(tracks, language);
  if (verdict === 'no-audio-in-language') return { verdict, action: 'remove' };
  if (verdict === 'wrong-track' && (!madeBefore || writtenAt < madeBefore)) {
    return { verdict, action: 'regenerate' };
  }
  return { verdict: 'ok', action: 'keep' };
}
