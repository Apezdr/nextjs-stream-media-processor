/**
 * Chapter cue titles. ffprobe exposes a chapter's title under `tags`; the
 * generator used to read `chapter.metadata`, which ffprobe never emits, so
 * every generated chapter file in the library was titled "Chapter NN" even
 * when the source named its chapters ("Recap", "Intro", "Credits"). These
 * tests pin the title selection and the VTT the generator writes, with the
 * probes mocked; the real ffprobe is covered in
 * tests/integration/ffprobe-real-binary.test.mjs.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const chapterInfo = jest.fn();
const getVideoDuration = jest.fn();
jest.unstable_mockModule('../../ffmpeg/ffprobe.mjs', () => ({ chapterInfo, getVideoDuration }));

const quiet = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../lib/logger.mjs', () => ({
  createCategoryLogger: () => quiet,
}));

const { generateChapters, chapterTitleFor } = await import('../../chapter-generator.mjs');

describe('chapterTitleFor', () => {
  it('uses the source title from tags', () => {
    expect(chapterTitleFor({ start_time: '0.000000', tags: { title: 'Studio Logo' } }, 1)).toBe('Studio Logo');
  });

  it('keeps a source title that merely looks generic', () => {
    expect(chapterTitleFor({ tags: { title: 'Chapter 1' } }, 1)).toBe('Chapter 1');
  });

  it('falls back to "Chapter NN" when the source has no title', () => {
    expect(chapterTitleFor({ start_time: '0.000000' }, 1)).toBe('Chapter 01');
    expect(chapterTitleFor({ tags: {} }, 12)).toBe('Chapter 12');
    expect(chapterTitleFor({ tags: { title: '' } }, 3)).toBe('Chapter 03');
    expect(chapterTitleFor({ metadata: { title: 'old shape' } }, 4)).toBe('Chapter 04');
  });

  it('falls back for titles with no letters or digits, and for bare timestamps', () => {
    expect(chapterTitleFor({ tags: { title: '\\' } }, 1)).toBe('Chapter 01');
    expect(chapterTitleFor({ tags: { title: '00:08:04.526' } }, 2)).toBe('Chapter 02');
    expect(chapterTitleFor({ tags: { title: '1:02:03,500' } }, 3)).toBe('Chapter 03');
  });

  it('flattens a title onto one line and keeps "-->" out of it', () => {
    expect(chapterTitleFor({ tags: { title: '  Recap\n\tIntro ' } }, 1)).toBe('Recap Intro');
    expect(chapterTitleFor({ tags: { title: 'A --> B' } }, 1)).toBe('A - B');
  });

  it('does not entity-escape: the frontend shows raw cue text', () => {
    expect(chapterTitleFor({ tags: { title: 'Tom & Jerry <3' } }, 1)).toBe('Tom & Jerry <3');
  });
});

describe('generateChapters', () => {
  beforeEach(() => {
    chapterInfo.mockReset();
    getVideoDuration.mockReset();
  });

  it('writes one cue per chapter with the source titles, the last ending at the duration', async () => {
    chapterInfo.mockResolvedValue([
      { start_time: '0.000000', tags: { title: 'Recap' } },
      { start_time: '61.500000', tags: { title: 'Intro' } },
      { start_time: '3000.250000' },
    ]);
    getVideoDuration.mockResolvedValue(3600.75);

    const vtt = await generateChapters('/lib/tv/Show/Season 1/Show - S01E01.mkv');

    expect(vtt).toBe(
      'WEBVTT\n\n' +
        '00:00:00.000 --> 00:01:01.500\nRecap\n\n' +
        '00:01:01.500 --> 00:50:00.250\nIntro\n\n' +
        '00:50:00.250 --> 01:00:00.750\nChapter 03\n\n'
    );
  });

  it('uses chapter data handed in by the caller instead of probing again', async () => {
    getVideoDuration.mockResolvedValue(10);

    const vtt = await generateChapters('/lib/movie.mkv', [{ start_time: '0.000000', tags: { title: 'Only' } }]);

    expect(chapterInfo).not.toHaveBeenCalled();
    expect(vtt).toContain('00:00:00.000 --> 00:00:10.000\nOnly\n');
  });

  it('returns an empty file without probing the duration when there are no chapters', async () => {
    chapterInfo.mockResolvedValue(null);

    await expect(generateChapters('/lib/movie.mkv')).resolves.toBe('WEBVTT\n\n');
    expect(getVideoDuration).not.toHaveBeenCalled();
  });
});
