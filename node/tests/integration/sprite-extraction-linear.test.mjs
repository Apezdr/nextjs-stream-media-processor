/**
 * Linear sprite extraction against the real ffmpeg: the whole file decoded
 * once into per-frame PNGs, composed with sharp, with progress read from
 * ffmpeg's -progress output. The old tile-filter form emitted nothing until
 * the very end, which is what made progress reporting impossible.
 *
 * SPRITE_SEEK_MODE is read when sprite.mjs loads, so this file pins linear
 * mode before importing; the seek strategy has its own file. Skipped when
 * ffmpeg/ffprobe are not installed where ffprobe.mjs looks for them.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

process.env.SPRITE_SEEK_MODE = 'linear';

const run = promisify(execFile);

const ffprobeBinary = process.env.FFPROBE_BINARY
  ? path.normalize(process.env.FFPROBE_BINARY)
  : process.platform === 'win32'
    ? path.join('C:', 'ffmpeg', 'bin', 'ffprobe.exe')
    : path.join('/usr', 'bin', 'ffprobe');
const ffmpegBinary = path.join(path.dirname(ffprobeBinary), path.basename(ffprobeBinary).replace('ffprobe', 'ffmpeg'));

async function usable(binary, args) {
  try {
    await run(binary, args);
    return true;
  } catch {
    return false;
  }
}

// sprite.mjs spawns plain `ffmpeg`, so it also has to be on PATH.
const haveTools = (await usable(ffprobeBinary, ['-version'])) && (await usable(ffmpegBinary, ['-version'])) && (await usable('ffmpeg', ['-version']));
const describeWithTools = haveTools ? describe : describe.skip;

describeWithTools('linear sprite extraction (real ffmpeg)', () => {
  const CLIP_SECONDS = 32; // 7 tiles at 5s: 0,5,...,30
  const INTERVAL = 5;
  let dir;
  let clip;
  let generateSpriteSheetWithFFmpeg;
  let sharp;

  beforeAll(async () => {
    ({ generateSpriteSheetWithFFmpeg } = await import('../../sprite.mjs'));
    sharp = (await import('sharp')).default;

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sprite-linear-'));
    clip = path.join(dir, 'clip.mkv');
    await run(ffmpegBinary, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${CLIP_SECONDS}`,
      '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p',
      clip,
    ]);
  });

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes the sheet and reports rising progress that ends at 1', async () => {
    const out = path.join(dir, 'sheet.png');
    const fractions = [];

    await generateSpriteSheetWithFFmpeg(clip, out, INTERVAL, 10, 1, 'png', {
      onProgress: (fraction) => fractions.push(fraction),
    });

    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(3200);   // 10 columns of 320px
    expect(meta.height).toBe(180);   // one row, 160x90 scaled to 320x180

    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
    for (const f of fractions) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it('leaves no frames directory behind', async () => {
    const leftovers = (await fs.readdir(dir)).filter((name) => name.startsWith('sprite_frames_'));
    expect(leftovers).toEqual([]);
  });
});
