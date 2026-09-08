/**
 * chapterInfo must ask ffprobe for chapter titles. They live in the chapter
 * `tags` sub-section (selected with `chapter_tags`); the old request for a
 * `metadata` entry matched nothing, so callers only ever saw start times.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const execFileAsync = jest.fn();
jest.unstable_mockModule('../../../utils/utils.mjs', () => ({ execFileAsync }));

const quiet = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../lib/logger.mjs', () => ({
  createCategoryLogger: () => quiet,
}));

const { chapterInfo } = await import('../../../ffmpeg/ffprobe.mjs');

describe('chapterInfo', () => {
  beforeEach(() => execFileAsync.mockReset());

  it('requests start times and titles, and returns the chapters with titles under tags', async () => {
    const chapters = [
      { start_time: '0.000000', tags: { title: 'Opening' } },
      { start_time: '600.000000' },
    ];
    execFileAsync.mockResolvedValue({ stdout: JSON.stringify({ chapters }), stderr: '' });

    await expect(chapterInfo('/lib/clip.mkv')).resolves.toEqual(chapters);

    const [, args] = execFileAsync.mock.calls[0];
    expect(args[args.indexOf('-show_entries') + 1]).toBe('chapter=start_time:chapter_tags=title');
    expect(args[args.indexOf('-print_format') + 1]).toBe('json');
    expect(args[args.length - 1]).toBe('/lib/clip.mkv');
  });

  it('returns null for a file without chapters', async () => {
    execFileAsync.mockResolvedValue({ stdout: JSON.stringify({ chapters: [] }), stderr: '' });
    await expect(chapterInfo('/lib/clip.mp4')).resolves.toBeNull();
  });
});
