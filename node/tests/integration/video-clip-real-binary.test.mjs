/**
 * Makes real clips with the real ffmpeg, from sources encoded on the fly, and
 * checks what comes out: the container, the codecs, where the index sits, and
 * where the clip starts. These are the properties a strict player (Safari on
 * an iPhone, AVPlayer on Apple TV) needs and a forgiving one hides.
 *
 * Skipped when ffmpeg/ffprobe are not on PATH or the build has no libx264. The
 * HEVC and HDR cases are skipped on their own when the build cannot make the
 * source (libx265) or run the CPU tone-map (zscale). Whether libplacebo is
 * usable is whatever this machine says: with a Vulkan device the HDR case runs
 * through it, without one through zscale, and the assertions hold for both.
 */

import { describe, it, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import express from 'express';

const run = promisify(execFile);

// For the last block, which drives the real request handler: the library
// lookups are stubbed (one known movie, whose file and cache directory the test
// sets below), everything from the handler down to ffmpeg is real.
const library = { videoPath: null, cacheDir: null };
const quiet = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../lib/logger.mjs', () => ({ createCategoryLogger: () => quiet }));
jest.unstable_mockModule('../../sqliteDatabase.mjs', () => ({
  getMovieByName: async (name) => (name === 'A Film' ? { name } : null),
  getTVShowByName: async () => null,
}));
jest.unstable_mockModule('../../utils/mediaResolution.mjs', () => ({
  resolveMovieVideo: async () => ({ path: library.videoPath }),
  resolveEpisodeVideo: async () => null,
  findEpisodeEntry: () => null,
}));
jest.unstable_mockModule('../../infoManager.mjs', () => ({ getInfo: async () => ({ uuid: 'real-binary-test' }) }));
jest.unstable_mockModule('../../utils/utils.mjs', () => ({
  fileExists: (target) => fs.access(target).then(() => true, () => false),
  getCachedClipPath: (cacheKey, extension = '.mp4') => path.join(library.cacheDir, `${cacheKey}${extension}`),
}));

async function toolOutput(binary, args) {
  try {
    const { stdout } = await run(binary, args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

const encoders = await toolOutput('ffmpeg', ['-hide_banner', '-encoders']);
const filters = await toolOutput('ffmpeg', ['-hide_banner', '-filters']);
const haveProbe = (await toolOutput('ffprobe', ['-version'])) !== null;

const haveTools = haveProbe && encoders !== null && /\blibx264\b/.test(encoders);
const haveHevc = haveTools && /\blibx265\b/.test(encoders);
const haveToneMap = haveHevc && filters !== null && /\bzscale\b/.test(filters) && /\btonemap\b/.test(filters);

const describeWithTools = haveTools ? describe : describe.skip;
const itWithHevc = haveHevc ? it : it.skip;
const itWithToneMap = haveToneMap ? it : it.skip;

const ffmpeg = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** What a player sees when it opens the file. */
async function inspect(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-count_packets', file,
  ]);
  const probe = JSON.parse(stdout);
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');

  // Top-level box order, read straight from the file: faststart means the
  // index (moov) comes before the media (mdat).
  const bytes = await fs.readFile(file);
  const boxes = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    boxes.push(bytes.toString('latin1', offset + 4, offset + 8));
    if (size < 8) break; // 64-bit or to-end-of-file size: nothing after it matters here
    offset += size;
  }

  return {
    streamTypes: probe.streams.map((stream) => stream.codec_type),
    formatName: probe.format.format_name,
    boxes,
    video,
    audio,
    videoStart: Number(video.start_time),
    videoDuration: Number(video.duration),
    videoPackets: Number(video.nb_read_packets),
    audioStart: audio ? Number(audio.start_time) : null,
    audioDuration: audio ? Number(audio.duration) : null,
  };
}

describeWithTools('clips made by the real ffmpeg', () => {
  let dir;
  let out;
  let clipEncode;
  const sources = {};

  const source = (name) => path.join(dir, name);
  const output = (name) => path.join(out, name);

  beforeAll(async () => {
    clipEncode = await import('../../ffmpeg/clipEncode.mjs');

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-clip-'));
    out = path.join(dir, 'cache');
    await fs.mkdir(out);

    const picture = (size, seconds, rate = 24) => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`];
    const tone = (seconds) => ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`];

    // 1080p H.264 + AAC in MP4, a keyframe every 2 s.
    await ffmpeg([
      ...picture('1920x1080', 12), ...tone(12),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
      '-c:a', 'aac', source('h264.mp4'),
    ]);

    // An odd-sized standard-definition picture with 5.1 audio, in Matroska.
    await ffmpeg([
      ...picture('853x480', 8, 30), ...tone(8),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv444p',
      '-c:a', 'ac3', '-ac', '6', source('odd.mkv'),
    ]);

    // The same film with cover art embedded, which demuxes as a second video stream.
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=300x450:d=1', '-frames:v', '1', source('cover.png')]);
    await ffmpeg([
      '-i', source('cover.png'), '-i', source('h264.mp4'),
      '-map', '0:v', '-map', '1:v', '-map', '1:a',
      '-c:v:0', 'mjpeg', '-c:v:1', 'copy', '-c:a', 'copy', '-disposition:v:0', 'attached_pic',
      source('with-cover.mp4'),
    ]);

    // The same picture in a file whose timestamps start at 5 s, not 0.
    await ffmpeg(['-i', source('h264.mp4'), '-c', 'copy', '-output_ts_offset', '5', source('offset.mkv')]);

    if (haveHevc) {
      // 10-bit HEVC tagged as HDR10 (the tags go on the frames, so the encoder
      // and the container both carry them), in Matroska with 5.1 audio.
      await ffmpeg([
        ...picture('1920x1080', 10), ...tone(10),
        '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
        '-x265-params', 'log-level=error:keyint=48:min-keyint=48',
        '-c:a', 'ac3', '-ac', '6', source('hdr10.mkv'),
      ]);
    }

    for (const name of ['h264.mp4', 'odd.mkv', 'with-cover.mp4', 'offset.mkv', ...(haveHevc ? ['hdr10.mkv'] : [])]) {
      sources[name] = await clipEncode.probeClipSource(source(name));
    }
  }, 120_000);

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  /** The properties every encoded clip must have, whatever it was cut from. */
  function expectStrictMp4(clip) {
    expect(clip.formatName).toContain('mp4');
    expect(clip.boxes.indexOf('moov')).toBeGreaterThan(-1);
    expect(clip.boxes.indexOf('moov')).toBeLessThan(clip.boxes.indexOf('mdat'));
    expect(clip.video.codec_name).toBe('h264');
    expect(clip.video.profile).toBe('High');
    expect(clip.video.pix_fmt).toBe('yuv420p');
    expect(clip.video.codec_tag_string).toBe('avc1');
    expect(clip.video.width % 2).toBe(0);
    expect(clip.video.height % 2).toBe(0);
    expect(clip.video.width).toBeLessThanOrEqual(1280);
    expect(clip.video.height).toBeLessThanOrEqual(720);
  }

  describe('the encoded clip', () => {
    it('is H.264 + AAC stereo in a faststart MP4, starting exactly where asked', async () => {
      const outputPath = output('h264-transcode.mp4');
      // 3.5 s is between keyframes (2 s and 4 s): the old copy-then-encode
      // started such a clip at the keyframe, 1.5 s early.
      await clipEncode.transcodeClip({
        videoPath: source('h264.mp4'), start: 3.5, duration: 4, source: sources['h264.mp4'], outputPath,
      });

      const clip = await inspect(outputPath);
      expectStrictMp4(clip);
      expect(clip.streamTypes).toEqual(['video', 'audio']);
      expect([clip.video.width, clip.video.height]).toEqual([1280, 720]);
      expect(clip.audio.codec_name).toBe('aac');
      expect(clip.audio.channels).toBe(2);
      expect(clip.audio.sample_rate).toBe('48000');

      // Both streams start at zero and run the requested four seconds.
      expect(clip.videoStart).toBeCloseTo(0, 1);
      expect(clip.audioStart).toBeCloseTo(0, 1);
      expect(clip.videoDuration).toBeCloseTo(4, 1);
      expect(clip.audioDuration).toBeCloseTo(4, 1);
      expect(clip.videoPackets).toBe(96); // 4 s at 24 fps, not 4 s plus a lead-in
    });

    it('makes a smaller picture and a smaller file at each lower quality level', async () => {
      const made = {};
      for (const quality of ['high', 'medium', 'low']) {
        const outputPath = output(`h264-${quality}.mp4`);
        await clipEncode.transcodeClip({
          videoPath: source('h264.mp4'), start: 3.5, duration: 4, source: sources['h264.mp4'], quality, outputPath,
        });
        made[quality] = { clip: await inspect(outputPath), size: (await fs.stat(outputPath)).size };
        expect(made[quality].clip.video.codec_name).toBe('h264');
        expect(made[quality].clip.video.profile).toBe('High');
        expect(made[quality].clip.video.pix_fmt).toBe('yuv420p');
        expect(made[quality].clip.videoPackets).toBe(96); // the same four seconds at every level
      }

      expect([made.high.clip.video.width, made.high.clip.video.height]).toEqual([1280, 720]);
      expect([made.medium.clip.video.width, made.medium.clip.video.height]).toEqual([1280, 720]);
      expect([made.low.clip.video.width, made.low.clip.video.height]).toEqual([854, 480]);
      expect(made.medium.size).toBeLessThan(made.high.size);
      expect(made.low.size).toBeLessThan(made.medium.size);
    });

    it('keeps a small picture small, makes an odd size even, and downmixes 5.1', async () => {
      const outputPath = output('odd-transcode.mp4');
      await clipEncode.transcodeClip({
        videoPath: source('odd.mkv'), start: 2, duration: 3, source: sources['odd.mkv'], outputPath,
      });

      const clip = await inspect(outputPath);
      expectStrictMp4(clip); // 4:4:4 in, 4:2:0 out
      expect([clip.video.width, clip.video.height]).toEqual([852, 480]);
      expect(clip.audio.channels).toBe(2);
    });

    it('leaves embedded cover art out of the clip', async () => {
      // The source really does carry it as a video stream.
      const withCover = await inspect(source('with-cover.mp4'));
      expect(withCover.streamTypes.filter((type) => type === 'video').length).toBe(2);

      const outputPath = output('cover-transcode.mp4');
      await clipEncode.transcodeClip({
        videoPath: source('with-cover.mp4'), start: 1, duration: 2, source: sources['with-cover.mp4'], outputPath,
      });

      const clip = await inspect(outputPath);
      expectStrictMp4(clip);
      expect(clip.streamTypes).toEqual(['video', 'audio']);
      expect([clip.video.width, clip.video.height]).toEqual([1280, 720]);
      expect(clip.videoPackets).toBe(48);
    });

    itWithToneMap('tone-maps HDR10 to 8-bit BT.709', async () => {
      expect(sources['hdr10.mkv']).toMatchObject({ transfer: 'pq', assumedPq: false });

      const outputPath = output('hdr10-transcode.mp4');
      await clipEncode.transcodeClip({
        videoPath: source('hdr10.mkv'), start: 3, duration: 3, source: sources['hdr10.mkv'], outputPath,
      });

      const clip = await inspect(outputPath);
      expectStrictMp4(clip);
      expect(clip.video.color_transfer).toBe('bt709');
      expect(clip.video.color_primaries).toBe('bt709');
      expect(clip.video.color_space).toBe('bt709');
      expect(clip.videoDuration).toBeCloseTo(3, 1);
    }, 60_000);

    it('leaves no temp file behind', async () => {
      const leftovers = (await fs.readdir(out)).filter((name) => name.endsWith(clipEncode.CLIP_TEMP_SUFFIX));
      expect(leftovers).toEqual([]);
    });
  });

  describe('the original-quality clip', () => {
    it('copies H.264 from the keyframe before the requested time, with audio starting there too', async () => {
      const outputPath = output('h264-original.mp4');
      await clipEncode.copyOriginalClip({
        videoPath: source('h264.mp4'), start: 3.5, duration: 4, source: sources['h264.mp4'], outputPath,
      });

      const clip = await inspect(outputPath);
      expect(clip.formatName).toContain('mp4');
      expect(clip.boxes.indexOf('moov')).toBeLessThan(clip.boxes.indexOf('mdat'));
      expect(clip.streamTypes).toEqual(['video', 'audio']);
      expect(clip.video.codec_name).toBe('h264');
      expect([clip.video.width, clip.video.height]).toEqual([1920, 1080]); // the source's own picture
      expect(clip.audio.codec_name).toBe('aac');
      expect(clip.audio.channels).toBe(2);

      // Keyframe at 2 s, so the copy covers 2 s - 7.5 s: 5.5 s, 132 frames.
      // Landing a GOP early (the Matroska seek trap) would make it 180.
      expect(clip.videoPackets).toBeGreaterThanOrEqual(130);
      expect(clip.videoPackets).toBeLessThanOrEqual(136);
      // Audio and video begin together, and end within the seek margin of each other.
      expect(Math.abs(clip.videoStart - clip.audioStart)).toBeLessThan(0.25);
      expect(Math.abs(clip.videoDuration - clip.audioDuration)).toBeLessThan(0.5);
    });

    it('starts on the right keyframe in a file whose timestamps do not start at zero', async () => {
      expect(sources['offset.mkv'].startTime).toBeGreaterThan(4);

      const outputPath = output('offset-original.mp4');
      await clipEncode.copyOriginalClip({
        videoPath: source('offset.mkv'), start: 3.5, duration: 4, source: sources['offset.mkv'], outputPath,
      });

      // Same picture as above, so the same answer: 2 s - 7.5 s of it.
      const clip = await inspect(outputPath);
      expect(clip.videoPackets).toBeGreaterThanOrEqual(130);
      expect(clip.videoPackets).toBeLessThanOrEqual(136);
    });

    itWithHevc('copies HEVC out of Matroska as hvc1, HDR tags intact, with AAC in place of 5.1 AC-3', async () => {
      const outputPath = output('hdr10-original.mp4');
      await clipEncode.copyOriginalClip({
        videoPath: source('hdr10.mkv'), start: 3, duration: 4, source: sources['hdr10.mkv'], outputPath,
      });

      const clip = await inspect(outputPath);
      expect(clip.formatName).toContain('mp4');
      expect(clip.boxes.indexOf('moov')).toBeLessThan(clip.boxes.indexOf('mdat'));
      expect(clip.video.codec_name).toBe('hevc');
      expect(clip.video.codec_tag_string).toBe('hvc1'); // AVFoundation does not open hev1
      expect(clip.video.pix_fmt).toBe('yuv420p10le');
      expect(clip.video.color_transfer).toBe('smpte2084');
      expect(clip.video.color_primaries).toBe('bt2020');
      expect(clip.audio.codec_name).toBe('aac');
      expect(clip.audio.channels).toBe(2);

      // Keyframe at 2 s, so 2 s - 7 s: 120 frames (168 if the seek fell a GOP short).
      expect(clip.videoPackets).toBeGreaterThanOrEqual(118);
      expect(clip.videoPackets).toBeLessThanOrEqual(130);
    });
  });

  describe('through the request handler', () => {
    let server;
    let origin;

    const url = (query) => `${origin}/videoClip/movie/A%20Film?${query}`;
    const download = async (response) => Buffer.from(await response.arrayBuffer());
    const isMp4 = (bytes) => bytes.toString('latin1', 4, 8) === 'ftyp';

    beforeAll(async () => {
      library.videoPath = source('h264.mp4');
      library.cacheDir = path.join(dir, 'handler-cache');
      await fs.mkdir(library.cacheDir);

      const { handleVideoClipRequest } = await import('../../videoHandler.mjs');
      const app = express();
      app.get('/videoClip/movie/:movieName', (req, res) => handleVideoClipRequest(req, res, 'movies', dir));
      server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
      if (server) await new Promise((resolve) => server.close(resolve));
    });

    it('gives a burst of requests for a new clip the same finished file, from one encode', async () => {
      const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(url('start=3.5&end=7.5'))));
      const bodies = await Promise.all(responses.map(download));

      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('video/mp4');
        expect(response.headers.get('etag')).toBe(responses[0].headers.get('etag'));
      }
      for (const bytes of bodies) {
        expect(isMp4(bytes)).toBe(true);
        expect(bytes.equals(bodies[0])).toBe(true);
      }

      // One clip in the cache, no temp file, and it is what was sent.
      const cacheFile = 'A Film-key_real-binary-test-start_3.5-end_7.5-v2-h264-high.mp4';
      expect(await fs.readdir(library.cacheDir)).toEqual([cacheFile]);
      const clip = await inspect(path.join(library.cacheDir, cacheFile));
      expectStrictMp4(clip);
      expect(bodies[0].length).toBe((await fs.stat(path.join(library.cacheDir, cacheFile))).size);

      // What a media element does next: probe two bytes, then read the tail.
      const probe = await fetch(url('start=3.5&end=7.5'), { headers: { Range: 'bytes=0-1' } });
      expect(probe.status).toBe(206);
      expect(probe.headers.get('content-range')).toBe(`bytes 0-1/${bodies[0].length}`);
      const tail = await fetch(url('start=3.5&end=7.5'), { headers: { Range: 'bytes=-64' } });
      expect(tail.status).toBe(206);
      expect((await download(tail)).equals(bodies[0].subarray(-64))).toBe(true);
    });

    it('serves the TV app its original-quality clip whole, then again from the cache', async () => {
      const first = await fetch(url('start=3.5&end=7.5&useOriginalVideo=true'));
      expect(first.status).toBe(200);
      const bytes = await download(first);
      expect(isMp4(bytes)).toBe(true);
      expect(first.headers.get('content-length')).toBe(String(bytes.length));

      const cacheFile = path.join(library.cacheDir, 'A Film-key_real-binary-test-start_3.5-end_7.5-v2-original.mp4');
      const written = await fs.stat(cacheFile);
      const clip = await inspect(cacheFile);
      expect([clip.video.width, clip.video.height]).toEqual([1920, 1080]);

      // No Range header the second time either, as the TV app's requests in
      // the production logs: the same file comes back, and ffmpeg did not run again.
      const second = await fetch(url('start=3.5&end=7.5&useOriginalVideo=true'));
      expect((await download(second)).equals(bytes)).toBe(true);
      expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
      expect((await fs.stat(cacheFile)).mtimeMs).toBe(written.mtimeMs);
    });

    it('serves a lower quality level when the URL asks for one', async () => {
      const response = await fetch(url('start=3.5&end=7.5&quality=low'));
      expect(response.status).toBe(200);
      const bytes = await download(response);
      expect(isMp4(bytes)).toBe(true);

      const cacheFile = path.join(library.cacheDir, 'A Film-key_real-binary-test-start_3.5-end_7.5-v2-h264-low.mp4');
      const clip = await inspect(cacheFile);
      expect([clip.video.width, clip.video.height]).toEqual([854, 480]);

      const high = await fs.stat(path.join(library.cacheDir, 'A Film-key_real-binary-test-start_3.5-end_7.5-v2-h264-high.mp4'));
      expect(bytes.length).toBeLessThan(high.size);
    });

    it('answers 404 for a title it does not know, without running anything', async () => {
      const response = await fetch(`${origin}/videoClip/movie/Unknown?start=0&end=5`);
      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe('Movie not found: Unknown');
    });
  });
});
