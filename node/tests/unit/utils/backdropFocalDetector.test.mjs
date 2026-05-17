/**
 * Unit tests for backdropFocalDetector.mjs
 *
 * Test suite is split into two parts:
 *
 *   Part 1 — Synthetic images
 *     Generated programmatically from raw pixel data using sharp.  These tests
 *     always run (no external files needed) and verify the core algorithm logic.
 *
 *   Part 2 — Real backdrop fixtures
 *     Reads node/tests/fixtures/backdrops/manifest.json.  Each entry maps a
 *     filename to the expected 'left' | 'right' | 'center' result.  Drop real
 *     JPEG/PNG backdrops into that folder, populate the manifest, and these
 *     tests will pick them up automatically.
 *
 *     Manifest format:
 *       [
 *         { "file": "the-batman-backdrop.jpg", "expectedFocal": "right", "notes": "Batman on right" },
 *         ...
 *       ]
 */

import { describe, it, expect } from '@jest/globals';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { detectBackdropFocal } = await import('../../../utils/backdropFocalDetector.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IMG_W = 300;
const IMG_H = 170;

/**
 * Create an in-memory JPEG buffer where each pixel's grey value is determined
 * by pixelFn(x, y, width, height) → 0-255.
 */
async function makeSyntheticImage(pixelFn) {
  const channels = 3;
  const raw = Buffer.alloc(IMG_W * IMG_H * channels);

  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const i = (y * IMG_W + x) * channels;
      const val = Math.round(pixelFn(x, y, IMG_W, IMG_H));
      raw[i] = raw[i + 1] = raw[i + 2] = val;
    }
  }

  return sharp(raw, { raw: { width: IMG_W, height: IMG_H, channels } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Part 1 — Synthetic tests (always run)
// ---------------------------------------------------------------------------

describe('backdropFocalDetector – synthetic images', () => {
  it('dark left half → subject on right → returns "right"', async () => {
    // Left third: ~20 luma, right third: ~230 luma
    const buf = await makeSyntheticImage((x, _y, w) => (x < w / 2 ? 20 : 230));
    expect(await detectBackdropFocal(buf)).toBe('right');
  });

  it('dark right half → subject on left → returns "left"', async () => {
    const buf = await makeSyntheticImage((x, _y, w) => (x < w / 2 ? 230 : 20));
    expect(await detectBackdropFocal(buf)).toBe('left');
  });

  it('dark left third only → subject on right → returns "right"', async () => {
    // Left third dark, centre+right bright
    const buf = await makeSyntheticImage((x, _y, w) => (x < w / 3 ? 15 : 220));
    expect(await detectBackdropFocal(buf)).toBe('right');
  });

  it('dark right third only → subject on left → returns "left"', async () => {
    const buf = await makeSyntheticImage((x, _y, w) => (x > (2 * w) / 3 ? 15 : 220));
    expect(await detectBackdropFocal(buf)).toBe('left');
  });

  it('dark left + centre thirds, bright right → subject on right → returns "right"', async () => {
    // Two dark columns, one bright — subject is on the bright (right) side
    const buf = await makeSyntheticImage((x, _y, w) => (x > (2 * w) / 3 ? 230 : 15));
    expect(await detectBackdropFocal(buf)).toBe('right');
  });

  it('dark right + centre thirds, bright left → subject on left → returns "left"', async () => {
    const buf = await makeSyntheticImage((x, _y, w) => (x < w / 3 ? 230 : 15));
    expect(await detectBackdropFocal(buf)).toBe('left');
  });

  it('dark centre, bright edges → subject centred → returns "center"', async () => {
    // Subject in the middle, text would go on sides — report as center
    const buf = await makeSyntheticImage((x, _y, w) => {
      const third = w / 3;
      return x >= third && x < 2 * third ? 15 : 220;
    });
    expect(await detectBackdropFocal(buf)).toBe('center');
  });

  it('uniform grey → not enough contrast → returns "center"', async () => {
    const buf = await makeSyntheticImage(() => 128);
    expect(await detectBackdropFocal(buf)).toBe('center');
  });

  it('nearly-uniform image (spread < threshold) → returns "center"', async () => {
    // Spread of ~5 luma units — below the 8-unit threshold
    const buf = await makeSyntheticImage((x, _y, w) => 100 + Math.floor((x / w) * 5));
    expect(await detectBackdropFocal(buf)).toBe('center');
  });

  it('gradient from very dark left to very bright right → returns "right"', async () => {
    const buf = await makeSyntheticImage((x, _y, w) => Math.round((x / (w - 1)) * 255));
    expect(await detectBackdropFocal(buf)).toBe('right');
  });

  it('gradient from very bright left to very dark right → returns "left"', async () => {
    const buf = await makeSyntheticImage((x, _y, w) => 255 - Math.round((x / (w - 1)) * 255));
    expect(await detectBackdropFocal(buf)).toBe('left');
  });
});

// ---------------------------------------------------------------------------
// Part 2 — Real backdrop fixtures
// ---------------------------------------------------------------------------

const fixturesDir = join(__dirname, '../../fixtures/backdrops');
const manifestPath = join(fixturesDir, 'manifest.json');

let manifest = [];
try {
  const raw = await fs.readFile(manifestPath, 'utf8');
  manifest = JSON.parse(raw);
} catch {
  // No manifest or unreadable — fixture tests are skipped via the todo below
}

if (manifest.length > 0) {
  describe('backdropFocalDetector – real backdrop fixtures', () => {
    it.each(manifest)(
      '$file → expects "$expectedFocal"',
      async ({ file, expectedFocal, notes }) => {
        const imagePath = join(fixturesDir, file);

        // Verify the fixture file actually exists before running
        await expect(fs.access(imagePath)).resolves.toBeUndefined();

        const result = await detectBackdropFocal(imagePath);
        expect(result).toBe(expectedFocal);

        // notes is informational only — log so it appears in verbose output
        if (notes) {
          console.log(`  [fixture note] ${file}: ${notes}`);
        }
      }
    );
  });
} else {
  describe('backdropFocalDetector – real backdrop fixtures', () => {
    it.todo(
      'Drop real backdrop JPEGs into node/tests/fixtures/backdrops/ and add entries ' +
      'to manifest.json: [{ "file": "name.jpg", "expectedFocal": "left|right|center", "notes": "..." }]'
    );
  });
}
