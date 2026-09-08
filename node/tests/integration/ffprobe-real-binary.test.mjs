/**
 * Runs getVideoDuration against the real ffprobe on clips encoded on the fly
 * with the real ffmpeg. The point is the MKV: Matroska stores duration only
 * on the container, so this is the case the per-stream-only probe used to
 * throw on. Skipped when the binaries are not installed where ffprobe.mjs
 * looks for them (FFPROBE_BINARY, else the platform default).
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

// Mirror ffprobe.mjs's resolution; ffmpeg ships beside ffprobe.
const ffprobeBinary = process.env.FFPROBE_BINARY
  ? path.normalize(process.env.FFPROBE_BINARY)
  : process.platform === 'win32'
    ? path.join('C:', 'ffmpeg', 'bin', 'ffprobe.exe')
    : path.join('/usr', 'bin', 'ffprobe');
const ffmpegBinary = path.join(
  path.dirname(ffprobeBinary),
  path.basename(ffprobeBinary).replace('ffprobe', 'ffmpeg')
);

async function usable(binary) {
  try {
    await run(binary, ['-version']);
    return true;
  } catch {
    return false;
  }
}

const haveTools = (await usable(ffprobeBinary)) && (await usable(ffmpegBinary));
const describeWithTools = haveTools ? describe : describe.skip;

describeWithTools('getVideoDuration against the real ffprobe', () => {
  const CLIP_SECONDS = 2.5;
  let dir;
  let mkv;
  let mp4;
  let notMedia;
  let getVideoDuration;

  beforeAll(async () => {
    ({ getVideoDuration } = await import('../../ffmpeg/ffprobe.mjs'));

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffprobe-duration-'));
    mkv = path.join(dir, 'clip.mkv');
    mp4 = path.join(dir, 'clip.mp4');
    notMedia = path.join(dir, 'notmedia.txt');

    // Native mpeg4 encoder so this does not depend on the build having libx264.
    const encode = (out) =>
      run(ffmpegBinary, [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc=size=64x36:rate=10:duration=${CLIP_SECONDS}`,
        '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p',
        out,
      ]);
    await encode(mkv);
    await encode(mp4);
    await fs.writeFile(notMedia, 'not a media file');
  });

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('MKV: the per-stream duration is absent, so the container duration is returned', async () => {
    const { stdout } = await run(ffprobeBinary, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=duration', '-of', 'default=noprint_wrappers=1:nokey=1',
      mkv,
    ]);
    // What the old probe parsed. If a future ffprobe starts reporting a
    // per-stream duration for Matroska this expectation is the one to relax.
    expect(stdout.trim()).toBe('N/A');

    await expect(getVideoDuration(mkv)).resolves.toBeCloseTo(CLIP_SECONDS, 1);
  });

  it('MP4: the stream duration is returned', async () => {
    await expect(getVideoDuration(mp4)).resolves.toBeCloseTo(CLIP_SECONDS, 1);
  });

  it('non-media input still throws', async () => {
    await expect(getVideoDuration(notMedia)).rejects.toThrow();
  });
});

describeWithTools('chapters against the real ffprobe', () => {
  let dir;
  let chaptered;
  let chapterInfo;
  let generateChapters;

  beforeAll(async () => {
    ({ chapterInfo } = await import('../../ffmpeg/ffprobe.mjs'));
    ({ generateChapters } = await import('../../chapter-generator.mjs'));

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffprobe-chapters-'));
    const plain = path.join(dir, 'plain.mkv');
    const metadata = path.join(dir, 'chapters.ffmeta');
    chaptered = path.join(dir, 'chaptered.mkv');

    await run(ffmpegBinary, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=2.5',
      '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p',
      plain,
    ]);
    // One named chapter and one left unnamed, the way mixed sources arrive.
    await fs.writeFile(
      metadata,
      ';FFMETADATA1\n' +
        '[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Opening\n' +
        '[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2500\n'
    );
    await run(ffmpegBinary, [
      '-v', 'error', '-y',
      '-i', plain, '-i', metadata,
      '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy',
      chaptered,
    ]);
  });

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('chapterInfo returns each chapter with its title under tags', async () => {
    const chapters = await chapterInfo(chaptered);

    expect(chapters).toHaveLength(2);
    expect(parseFloat(chapters[0].start_time)).toBeCloseTo(0, 3);
    expect(chapters[0].tags?.title).toBe('Opening');
    expect(parseFloat(chapters[1].start_time)).toBeCloseTo(1, 3);
    expect(chapters[1].tags?.title).toBeUndefined();
  });

  it('generateChapters names the cue from the source and falls back for the unnamed one', async () => {
    const vtt = await generateChapters(chaptered);

    expect(vtt).toBe(
      'WEBVTT\n\n' +
        '00:00:00.000 --> 00:00:01.000\nOpening\n\n' +
        '00:00:01.000 --> 00:00:02.500\nChapter 02\n\n'
    );
  });
});
