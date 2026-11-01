/**
 * Chapter cue titles. ffprobe exposes a chapter's title under `tags`; the
 * generator used to read `chapter.metadata`, which ffprobe never emits, so
 * every generated chapter file in the library was titled "Chapter NN" even
 * when the source named its chapters ("Recap", "Intro", "Credits"). These
 * tests pin the title selection and the VTT the generator writes, with the
 * probes mocked; the real ffprobe is covered in
 * tests/integration/ffprobe-real-binary.test.mjs.
 *
 * The file is also kept in step with its video. It used to be written only
 * when missing, so a folder whose video was replaced kept the old video's
 * chapters (38 of them, to 2:51:57, against a 2:03:47 video) and the chapter
 * menu asked for frames past the end.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const chapterInfo = jest.fn();
const getVideoDuration = jest.fn();
jest.unstable_mockModule('../../ffmpeg/ffprobe.mjs', () => ({ chapterInfo, getVideoDuration }));

const quiet = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../lib/logger.mjs', () => ({
  createCategoryLogger: () => quiet,
}));

const { chaptersVtt, syncChapterFile, videoSourceStamp, chapterTitleFor } = await import('../../chapter-generator.mjs');

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

describe('chaptersVtt', () => {
  it('writes one cue per chapter with the source titles, the last ending at the duration', () => {
    const vtt = chaptersVtt(
      [
        { start_time: '0.000000', tags: { title: 'Recap' } },
        { start_time: '61.500000', tags: { title: 'Intro' } },
        { start_time: '3000.250000' },
      ],
      3600.75,
      '0123456789abcdef'
    );

    expect(vtt).toBe(
      'WEBVTT\n\n' +
        'NOTE source 0123456789abcdef\n\n' +
        '00:00:00.000 --> 00:01:01.500\nRecap\n\n' +
        '00:01:01.500 --> 00:50:00.250\nIntro\n\n' +
        '00:50:00.250 --> 01:00:00.750\nChapter 03\n\n'
    );
  });

  it('drops chapters that start at or past the end of the video', () => {
    // A 24:00:00 end marker, and a chapter list from a longer video.
    const vtt = chaptersVtt(
      [{ start_time: '0.000000' }, { start_time: '3000.000000' }, { start_time: '3198.000000' }, { start_time: '86400.000000' }],
      3198,
      '0123456789abcdef'
    );

    expect(vtt).toContain('00:50:00.000 --> 00:53:18.000\nChapter 02\n');
    expect(vtt).not.toContain('Chapter 03');
    expect(vtt).not.toContain('24:00:00');
  });

  it('is null when no chapter starts before the end', () => {
    expect(chaptersVtt([{ start_time: '7566.000000' }], 7427.552, '0123456789abcdef')).toBeNull();
    expect(chaptersVtt([], 10, '0123456789abcdef')).toBeNull();
  });
});

describe('syncChapterFile', () => {
  let dir;
  let video;
  let chaptersPath;
  const chapters = [{ start_time: '0.000000', tags: { title: 'Opening' } }, { start_time: '600.000000' }];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chapters-test-'));
    video = join(dir, 'Title 1080p.mkv');
    await writeFile(video, 'first release');
    chaptersPath = join(dir, 'chapters', 'Title_chapters.vtt');
    chapterInfo.mockReset().mockResolvedValue(chapters);
    getVideoDuration.mockReset().mockResolvedValue(1200);
    quiet.error.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const exists = (path) => access(path).then(() => true, () => false);

  it('writes the file, naming the video it came from', async () => {
    await syncChapterFile(chaptersPath, video);

    const vtt = await readFile(chaptersPath, 'utf8');
    expect(vtt).toContain(`NOTE source ${await videoSourceStamp(video)}\n`);
    expect(vtt).toContain('00:00:00.000 --> 00:10:00.000\nOpening\n');
  });

  it('keeps a file that names the current video, without probing it', async () => {
    await syncChapterFile(chaptersPath, video);
    chapterInfo.mockClear();
    getVideoDuration.mockClear();

    await syncChapterFile(chaptersPath, video);

    expect(chapterInfo).not.toHaveBeenCalled();
    expect(getVideoDuration).not.toHaveBeenCalled();
  });

  it('rebuilds the file when the video was replaced', async () => {
    await syncChapterFile(chaptersPath, video);
    const before = await readFile(chaptersPath, 'utf8');

    await writeFile(video, 'an upgraded release, a different size');
    chapterInfo.mockResolvedValue([{ start_time: '0.000000', tags: { title: 'New cut' } }]);
    await syncChapterFile(chaptersPath, video);

    const after = await readFile(chaptersPath, 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain('New cut');
    expect(after).toContain(`NOTE source ${await videoSourceStamp(video)}\n`);
  });

  it('rebuilds a file written before files named their source', async () => {
    await mkdir(join(dir, 'chapters'));
    await writeFile(chaptersPath, 'WEBVTT\n\n00:00:00.000 --> 02:51:57.349\n(01)00:00:00:000\n\n');

    await syncChapterFile(chaptersPath, video);

    expect(await readFile(chaptersPath, 'utf8')).toContain('Opening');
  });

  it('removes a stale file when the current video has no chapters', async () => {
    await syncChapterFile(chaptersPath, video);
    await writeFile(video, 'a release without chapters');
    chapterInfo.mockResolvedValue(null);

    await syncChapterFile(chaptersPath, video);

    expect(await exists(chaptersPath)).toBe(false);
    expect(getVideoDuration).toHaveBeenCalledTimes(1); // only for the first write
  });

  it('removes a stale file when every chapter starts past the end', async () => {
    await syncChapterFile(chaptersPath, video);
    await writeFile(video, 'a shorter release');
    getVideoDuration.mockResolvedValue(300);
    chapterInfo.mockResolvedValue([{ start_time: '7566.000000' }]);

    await syncChapterFile(chaptersPath, video);

    expect(await exists(chaptersPath)).toBe(false);
  });

  it('writes nothing for a video without chapters', async () => {
    chapterInfo.mockResolvedValue(null);

    await syncChapterFile(chaptersPath, video);

    expect(await exists(chaptersPath)).toBe(false);
    expect(getVideoDuration).not.toHaveBeenCalled();
  });

  it('leaves the file as it was when a probe fails, and logs it', async () => {
    await syncChapterFile(chaptersPath, video);
    const before = await readFile(chaptersPath, 'utf8');
    await writeFile(video, 'replaced, but unreadable to ffprobe');
    chapterInfo.mockRejectedValue(new Error('ffprobe exited 1'));

    await expect(syncChapterFile(chaptersPath, video)).resolves.toBeUndefined();

    expect(await readFile(chaptersPath, 'utf8')).toBe(before);
    expect(quiet.error).toHaveBeenCalledWith(expect.stringContaining('ffprobe exited 1'));
  });
});
