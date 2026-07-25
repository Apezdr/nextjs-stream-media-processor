/**
 * Eligibility answers a narrower question than "can the transcoder decode
 * this?" — its ladder handles essentially anything ffmpeg can demux, so that
 * predicate would always be true and therefore useless. It answers: is routing
 * this file through JIT a strict improvement, or does it quietly cost the
 * viewer something direct playback gives them today?
 */

import { describe, it, expect } from '@jest/globals';
import { evaluateJitEligibility } from '../../../components/media-scanner/domain/jit-eligibility.mjs';
import { jitPathKey, jitMasterUrl, isJitUrlConfigured } from '../../../utils/jitUrl.mjs';

const h264 = {
  container: 'mkv',
  formatName: 'matroska,webm',
  videoCodec: 'h264',
  audioLanguages: ['eng'],
  hostEnabled: true,
};

describe('evaluateJitEligibility', () => {
  it('accepts a well-described single-language source', () => {
    expect(evaluateJitEligibility(h264)).toEqual({ eligible: true, reason: 'ok' });
  });

  it('is off entirely when the host toggle is off', () => {
    expect(evaluateJitEligibility({ ...h264, hostEnabled: false })).toEqual({
      eligible: false,
      reason: 'host-disabled',
    });
  });

  it.each(['mp4', 'm4v', 'mov', 'mkv', 'webm'])('accepts container %s', (container) => {
    expect(evaluateJitEligibility({ ...h264, container }).eligible).toBe(true);
  });

  it('excludes .avi — still playable, just never advertised', () => {
    const v = evaluateJitEligibility({ ...h264, container: 'avi' });
    expect(v).toEqual({ eligible: false, reason: 'container-unsupported' });
  });

  it('is case-insensitive about the container', () => {
    expect(evaluateJitEligibility({ ...h264, container: 'MKV' }).eligible).toBe(true);
  });

  it('FAILS CLOSED on incomplete probe data', () => {
    // A sidecar written before v1.0011 has no container/codec block, so the
    // flag simply does not appear until it converges. This is what lets the
    // probe bump and this rollout self-order with no sequencing between them.
    expect(evaluateJitEligibility({ ...h264, formatName: null })).toEqual({
      eligible: false,
      reason: 'probe-incomplete',
    });
    expect(evaluateJitEligibility({ ...h264, videoCodec: null })).toEqual({
      eligible: false,
      reason: 'probe-incomplete',
    });
  });

  it('rejects multi-language sources — JIT would silently drop languages', () => {
    expect(evaluateJitEligibility({ ...h264, audioLanguages: ['eng', 'jpn'] })).toEqual({
      eligible: false,
      reason: 'multi-audio-language',
    });
  });

  it('accepts a multi-TRACK source that carries only one language', () => {
    // Several tracks of the same language (stereo + 5.1) lose nothing.
    expect(evaluateJitEligibility({ ...h264, audioLanguages: ['eng'] }).eligible).toBe(true);
  });

  it('accepts untagged audio — loss is unprovable, so do not assume it', () => {
    expect(evaluateJitEligibility({ ...h264, audioLanguages: [] }).eligible).toBe(true);
  });

  it('does NOT disqualify HDR — the tone-map path is always present', () => {
    expect(
      evaluateJitEligibility({ ...h264, videoCodec: 'hevc', formatName: 'matroska,webm' }).eligible
    ).toBe(true);
  });
});

describe('jit URL construction', () => {
  const withEnv = (vars, fn) => {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('encodes the path as unpadded base64url, matching the transcoder', () =>
    withEnv({ JIT_SOURCE_PREFIX: '' }, () => {
      const key = jitPathKey('movies/Some.Movie.mkv');
      expect(key).toBe(Buffer.from('movies/Some.Movie.mkv', 'utf8').toString('base64url'));
      // base64url alphabet only, and never padded — the transcoder rejects '='.
      expect(key).not.toMatch(/[+/=]/);
      // Round-trips.
      expect(Buffer.from(key, 'base64url').toString('utf8')).toBe('movies/Some.Movie.mkv');
    }));

  it('normalizes Windows separators so both hosts produce the same key', () =>
    withEnv({ JIT_SOURCE_PREFIX: '' }, () => {
      expect(jitPathKey('movies\\Dune (2021)\\Dune.mkv')).toBe(
        jitPathKey('movies/Dune (2021)/Dune.mkv')
      );
    }));

  it('survives spaces, parentheses and unicode in the path', () =>
    withEnv({ JIT_SOURCE_PREFIX: '' }, () => {
      const p = 'movies/Amélie (2001)/Amélie.mkv';
      expect(Buffer.from(jitPathKey(p), 'base64url').toString('utf8')).toBe(p);
    }));

  it('applies JIT_SOURCE_PREFIX when the mounts differ', () =>
    withEnv({ JIT_SOURCE_PREFIX: 'library' }, () => {
      expect(Buffer.from(jitPathKey('movies/X.mkv'), 'base64url').toString('utf8')).toBe(
        'library/movies/X.mkv'
      );
    }));

  it('builds a master playlist URL and trims a trailing slash on the base', () =>
    withEnv({ JIT_TRANSCODER_URL: 'https://t.example.com/', JIT_SOURCE_PREFIX: '' }, () => {
      const url = jitMasterUrl('movies/X.mkv');
      expect(url).toBe(`https://t.example.com/stream/${jitPathKey('movies/X.mkv')}/master.m3u8`);
      expect(url).not.toContain('//stream');
    }));

  it('emits nothing when no transcoder URL is configured', () =>
    withEnv({ JIT_TRANSCODER_URL: undefined }, () => {
      expect(isJitUrlConfigured()).toBe(false);
      expect(jitMasterUrl('movies/X.mkv')).toBeNull();
    }));
});
