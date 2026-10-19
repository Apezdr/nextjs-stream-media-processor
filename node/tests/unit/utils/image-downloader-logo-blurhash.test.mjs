/**
 * downloadMediaImages writes a `.blurhash` sidecar for the poster and the
 * backdrop it downloads, and none for the logo (kindHasBlurhash). A logo
 * downloaded again still loses the sidecar left from before, which no longer
 * matches the image.
 *
 * The HTTP fetch and the encoder are mocked; the files are real.
 */

import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

jest.unstable_mockModule('axios', () => ({
  default: jest.fn(async () => ({ status: 200, data: Readable.from([Buffer.from('image bytes')]) })),
}));

const generateBlurhash = jest.fn(async () => 'LEHV6nWB2yk8pyo0adR*.7kCMdnj');
jest.unstable_mockModule('../../../utils/blurhashNative.mjs', () => ({ generateBlurhash }));

const { downloadMediaImages } = await import('../../../utils/imageDownloader.mjs');

const root = join(tmpdir(), `image-downloader-logo-${randomUUID()}`);
const exists = (path) => fs.access(path).then(() => true, () => false);
const METADATA = { poster_path: '/p.jpg', backdrop_path: '/b.jpg', logo_path: '/l.png' };

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  generateBlurhash.mockClear();
});

describe('downloadMediaImages and logo sidecars', () => {
  it.each([
    ['movie', 'poster.jpg', 'backdrop.jpg', 'logo.png'],
    ['tv', 'show_poster.jpg', 'show_backdrop.jpg', 'show_logo.png'],
  ])('a %s: the poster and backdrop get a sidecar, the logo none', async (mediaType, poster, backdrop, logo) => {
    const dir = join(root, mediaType, 'Fresh');
    await fs.mkdir(dir, { recursive: true });

    const results = await downloadMediaImages(METADATA, dir, {}, mediaType);

    for (const kind of ['poster', 'backdrop', 'logo']) expect(results[kind].success).toBe(true);
    expect(await exists(join(dir, logo))).toBe(true);
    expect(await exists(join(dir, `${poster}.blurhash`))).toBe(true);
    expect(await exists(join(dir, `${backdrop}.blurhash`))).toBe(true);
    expect(await exists(join(dir, `${logo}.blurhash`))).toBe(false);
    expect(results.logo.blurhash).toBeNull();
    expect(generateBlurhash.mock.calls.map(([path]) => path).sort()).toEqual(
      [join(dir, backdrop), join(dir, poster)].sort()
    );
  });

  it('removes the old sidecar of a logo it downloads again, and writes no new one', async () => {
    const dir = join(root, 'movie', 'Again');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'logo.png'), 'old logo');
    await fs.writeFile(join(dir, 'logo.png.blurhash'), 'old hash');

    await downloadMediaImages({ logo_path: '/l.png' }, dir, {}, 'movie', { forceDownload: true });

    expect(await fs.readFile(join(dir, 'logo.png'), 'utf8')).toBe('image bytes');
    expect(await exists(join(dir, 'logo.png.blurhash'))).toBe(false);
    expect(generateBlurhash).not.toHaveBeenCalled();
  });
});
