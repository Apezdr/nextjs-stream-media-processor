/**
 * Log fingerprints (lib/logFingerprint.mjs): one ID per kind of message, so
 * "97.1MB" and "98.3MB" lines are the same problem. Secret masking
 * (lib/logSecrets.mjs): secret-shaped values no specific redaction knew about
 * are masked, and the record is marked for the "secret in a log line" alert.
 */

import { describe, it, expect } from '@jest/globals';
import { fingerprintOf, templateOf } from '../../../lib/logFingerprint.mjs';
import { maskSecrets, SECRETS_MASKED } from '../../../lib/logSecrets.mjs';

describe('templateOf / fingerprintOf', () => {
  it('gives lines that differ only in their numbers, IDs, paths, URLs or quoted values one template', () => {
    const pairs = [
      ['Memory pressure detected: 97.1MB used (94.0% of heap)', 'Memory pressure detected: 510.0MB used (85.4% of heap)'],
      ['Failed to fetch https://api.example/tv/1?x=1', 'Failed to fetch https://api.example/movie/99'],
      ['Cannot read /var/www/html/movies/A/a.mkv', 'Cannot read /var/www/html/tv/B/S01/b.mkv'],
      ['Job 581bf51c-0000-4000-8000-000000000000 failed', 'Job 0a1b2c3d-1111-4222-8333-444455556666 failed'],
      ['hash 3f9a2b7c1d0e mismatch', 'hash a1b2c3d4e5f6 mismatch'],
      ['No match for "Some Title"', 'No match for "Another One"'],
      ['Invalid webhook ID on GET /api/logs from [webhook-id sha256:1a2b3c4d]', 'Invalid webhook ID on GET /api/logs from [webhook-id sha256:9f8e7d6c]'],
    ];
    for (const [a, b] of pairs) {
      expect(templateOf(a)).toBe(templateOf(b));
      expect(fingerprintOf('cat', a)).toBe(fingerprintOf('cat', b));
    }
  });

  it('keeps short route paths and apostrophes in words, which say what happened', () => {
    expect(templateOf('No credentials on GET /api/logs')).toBe('No credentials on GET /api/logs');
    expect(templateOf("Couldn't read it, it's missing")).toBe("Couldn't read it, it's missing");
  });

  it('tells different messages and different categories apart, as 12 hex characters', () => {
    expect(fingerprintOf('cat', 'Scan failed')).not.toBe(fingerprintOf('cat', 'Sync failed'));
    expect(fingerprintOf('a', 'Scan failed')).not.toBe(fingerprintOf('b', 'Scan failed'));
    expect(fingerprintOf('cat', 'Scan failed')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('maskSecrets', () => {
  it('masks a key in a query string, a Bearer token and a credential-named field, and marks the record', () => {
    const headers = { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345', Accept: 'json' };
    const info = {
      level: 'warn',
      message: 'GET https://sonarr.local/feed/calendar.ics?apikey=0123456789abcdef&unmonitored=true failed',
      headers,
      note: 'sent Bearer abcdefghijklmnopqrstuvwxyz012345',
    };

    maskSecrets(info);

    expect(info.message).toBe('GET https://sonarr.local/feed/calendar.ics?apikey=[masked]&unmonitored=true failed');
    expect(info.headers).toEqual({ Authorization: '[masked]', Accept: 'json' });
    expect(info.note).toBe('sent Bearer [masked]');
    expect(info[SECRETS_MASKED].sort()).toEqual(['bearer', 'field', 'query']);
    // The caller's own object is left as it was.
    expect(headers.Authorization).toBe('Bearer abcdefghijklmnopqrstuvwxyz012345');
  });

  it('leaves values an earlier redaction hid, and ordinary lines, unmarked', () => {
    const info = {
      message: 'GET /feed?apikey=[redacted] and token=*** ok',
      'x-webhook-id': '[webhook-id sha256:1a2b3c4d]',
      password: '[masked]',
    };
    maskSecrets(info);
    expect(info.message).toBe('GET /feed?apikey=[redacted] and token=*** ok');
    expect(info[SECRETS_MASKED]).toBeUndefined();

    const plain = { message: 'Finished processing movies: 850 titles' };
    maskSecrets(plain);
    expect(plain[SECRETS_MASKED]).toBeUndefined();
  });
});
