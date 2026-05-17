import { describe, it, expect } from '@jest/globals';
import { postProcessSrt } from '../../../components/caption-generator/domain/srt-postprocess.mjs';

describe('postProcessSrt', () => {
  it('renumbers cues and trims whitespace', () => {
    const input =
      '1\n00:00:00,000 --> 00:00:02,000\n  Hello world\n\n' +
      '2\n00:00:02,000 --> 00:00:04,000\nSecond cue\n\n';
    const out = postProcessSrt(input);
    expect(out).toBe(
      '1\n00:00:00,000 --> 00:00:02,000\nHello world\n\n' +
      '2\n00:00:02,000 --> 00:00:04,000\nSecond cue\n'
    );
  });

  it('drops cues consisting solely of placeholder tokens', () => {
    const input =
      '1\n00:00:00,000 --> 00:00:01,000\n[BLANK_AUDIO]\n\n' +
      '2\n00:00:01,000 --> 00:00:03,000\nReal text\n\n' +
      '3\n00:00:03,000 --> 00:00:04,000\n[ Music ]\n\n';
    const out = postProcessSrt(input);
    expect(out.split('\n\n')).toHaveLength(1);
    expect(out).toContain('Real text');
    expect(out).not.toContain('BLANK_AUDIO');
    expect(out).not.toContain('Music');
  });

  it('handles cues with no leading index line', () => {
    const input =
      '00:00:00,000 --> 00:00:02,000\nNo index\n\n' +
      '00:00:02,000 --> 00:00:04,000\nAlso no index\n';
    const out = postProcessSrt(input);
    expect(out).toContain('1\n00:00:00,000 --> 00:00:02,000\nNo index');
    expect(out).toContain('2\n00:00:02,000 --> 00:00:04,000\nAlso no index');
  });

  it('normalizes CRLF line endings', () => {
    const input = '1\r\n00:00:00,000 --> 00:00:02,000\r\nHello\r\n\r\n';
    const out = postProcessSrt(input);
    expect(out).toBe('1\n00:00:00,000 --> 00:00:02,000\nHello\n');
  });

  it('throws when zero cues remain', () => {
    const input =
      '1\n00:00:00,000 --> 00:00:01,000\n[BLANK_AUDIO]\n\n' +
      '2\n00:00:01,000 --> 00:00:02,000\n[ Silence ]\n';
    expect(() => postProcessSrt(input)).toThrow(/no cues/);
  });

  it('preserves multi-line cue text', () => {
    const input =
      '1\n00:00:00,000 --> 00:00:03,000\nFirst line\nSecond line\n';
    const out = postProcessSrt(input);
    expect(out).toContain('First line\nSecond line');
  });
});
