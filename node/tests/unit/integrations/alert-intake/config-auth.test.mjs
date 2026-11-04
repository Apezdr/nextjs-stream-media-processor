/**
 * Keys (integrations/alert-intake/config.mjs) and where each format reads
 * them (auth.mjs). A bad entry fails the whole intake loudly, problems name
 * entries by position and never by text, and the comparison checks every key.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { timingSafeEqual } from 'crypto';
import { parseIntakeConfig, intakeKeyValues, DEFAULT_LIMITS } from '../../../../integrations/alert-intake/config.mjs';
import { readCredential, createKeyMatcher } from '../../../../integrations/alert-intake/auth.mjs';
import { ADAPTERS } from '../../../../integrations/alert-intake/adapters/index.mjs';
import { KEY, OTHER_KEY } from '../../../helpers/alertIntake.mjs';

const THIRD = 'gtfya.e2NcJK7AenXBPIRB3S03JsBlmy0V6xP8h0hwSiAJae8';

describe('ALERT_INTAKE_KEYS', () => {
  it('is off when unset or blank', () => {
    expect(parseIntakeConfig({}).state).toBe('off');
    expect(parseIntakeConfig({ ALERT_INTAKE_KEYS: '  ' }).state).toBe('off');
  });

  it('reads source:key entries split by commas or newlines, several keys per source', () => {
    const config = parseIntakeConfig({ ALERT_INTAKE_KEYS: `SigNoz:${KEY},\n uptime-kuma : ${OTHER_KEY}\n\nsignoz:${THIRD}` });
    expect(config.state).toBe('on');
    expect(config.problems).toEqual([]);
    expect(config.sources).toEqual(['signoz', 'uptime-kuma']);
    expect(config.keys.map((key) => [key.source, key.sourceIndex])).toEqual([['signoz', 0], ['uptime-kuma', 1], ['signoz', 0]]);
    expect(config.keys[0].fingerprint).toMatch(/^sha256:[0-9a-f]{8}$/);
    expect(config.limits).toEqual(DEFAULT_LIMITS);
  });

  it('refuses the whole list over one bad entry, naming its position, never its text', () => {
    const secretish = 'short+key/with=bad';
    const cases = [
      [`signoz${KEY}`, 'entry 1 is not source:key'],
      [`-bad-:${KEY}`, 'entry 1: the source'],
      [`signoz:${secretish}`, 'entry 1 (signoz): the key must be 32 to 256'],
      [`signoz:${'a'.repeat(31)}`, 'the key must be 32 to 256'],
      [`signoz:${KEY.slice(0, 30)}+${KEY.slice(30)}`, 'the key must be'],
      [`a:${KEY},b:${KEY}`, 'entry 2 (b) repeats the key of entry 1'],
    ];
    for (const [value, problem] of cases) {
      const config = parseIntakeConfig({ ALERT_INTAKE_KEYS: value });
      expect({ value, state: config.state }).toEqual({ value, state: 'misconfigured' });
      expect(config.problems.join('\n')).toContain(problem);
      expect(config.problems.join('\n')).not.toContain(secretish);
      expect(config.problems.join('\n')).not.toContain(KEY);
    }
    expect(parseIntakeConfig({ ALERT_INTAKE_KEYS: `ok:${KEY},bad` }).keys).toHaveLength(1);
  });

  it('refuses a key that is also a webhook ID or SERVER_API_KEY', () => {
    expect(parseIntakeConfig({ ALERT_INTAKE_KEYS: `s:${KEY}`, WEBHOOK_ID_1: `other, ${KEY}` }).problems[0]).toContain('is a WEBHOOK_ID or SERVER_API_KEY value');
    expect(parseIntakeConfig({ ALERT_INTAKE_KEYS: `s:${KEY}`, SERVER_API_KEY: KEY }).state).toBe('misconfigured');
  });

  it('takes the burst and per-hour overrides, and refuses nonsense in them', () => {
    expect(parseIntakeConfig({ ALERT_INTAKE_KEYS: `s:${KEY}`, ALERT_INTAKE_BURST: '4', ALERT_INTAKE_SOURCE_PER_HOUR: '12' }).limits).toMatchObject({ sourceBurst: 4, sourcePerHour: 12 });
    expect(parseIntakeConfig({ ALERT_INTAKE_KEYS: `s:${KEY}`, ALERT_INTAKE_BURST: '0' }).state).toBe('misconfigured');
    expect(parseIntakeConfig({ ALERT_INTAKE_KEYS: `s:${KEY}`, ALERT_INTAKE_SOURCE_PER_HOUR: 'lots' }).problems[0]).toContain('ALERT_INTAKE_SOURCE_PER_HOUR');
  });

  it('lists the key values for log redaction, malformed entries included when they look like keys', () => {
    expect(intakeKeyValues({ ALERT_INTAKE_KEYS: `a:${KEY},${OTHER_KEY},b:short` })).toEqual([KEY, OTHER_KEY]);
    expect(intakeKeyValues({})).toEqual([]);
  });
});

const headers = (value) => ({ headers: value, query: {} });
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const ntfyAuth = (value) => Buffer.from(value).toString('base64').replace(/=+$/, '');

describe('where each format reads the key', () => {
  it('reads Bearer and Basic (password, else username) for alertmanager and generic', () => {
    for (const adapter of [ADAPTERS.alertmanager, ADAPTERS.generic]) {
      expect(readCredential(headers({ authorization: `Bearer ${KEY}` }), adapter.credentials)).toEqual({ method: 'bearer', key: KEY });
      expect(readCredential(headers({ authorization: `bearer  ${KEY}` }), adapter.credentials)).toEqual({ method: 'bearer', key: KEY });
      expect(readCredential(headers({ authorization: basic('signoz', KEY) }), adapter.credentials)).toEqual({ method: 'basic', key: KEY });
      expect(readCredential(headers({ authorization: basic(KEY, '') }), adapter.credentials)).toEqual({ method: 'basic', key: KEY });
      expect(readCredential(headers({ authorization: 'Digest abc' }), adapter.credentials)).toEqual({ malformed: true });
      expect(readCredential(headers({ authorization: 'Basic' }), adapter.credentials)).toEqual({ malformed: true });
      expect(readCredential(headers({ authorization: basic('', '') }), adapter.credentials)).toEqual({ malformed: true });
      // Query keys are only where the format's clients send them.
      expect(readCredential({ headers: {}, query: { token: KEY, auth: ntfyAuth(`Bearer ${KEY}`) } }, adapter.credentials)).toBeNull();
    }
  });

  it('reads Gotify\'s ?token=, then X-Gotify-Key, then Bearer, and the first present one decides', () => {
    const { credentials } = ADAPTERS.gotify;
    expect(readCredential({ headers: { 'x-gotify-key': OTHER_KEY }, query: { token: KEY } }, credentials)).toEqual({ method: 'query', key: KEY });
    expect(readCredential({ headers: { 'x-gotify-key': KEY, authorization: `Bearer ${OTHER_KEY}` }, query: {} }, credentials)).toEqual({ method: 'header', key: KEY });
    expect(readCredential(headers({ authorization: `Bearer ${KEY}` }), credentials)).toEqual({ method: 'bearer', key: KEY });
    // Gotify's Basic is user credentials: not read.
    expect(readCredential(headers({ authorization: basic('u', KEY) }), credentials)).toBeNull();
    expect(readCredential({ headers: {}, query: { token: [KEY, OTHER_KEY] } }, credentials)).toEqual({ malformed: true });
    expect(readCredential({ headers: {}, query: { token: '' } }, credentials)).toEqual({ malformed: true });
  });

  it('reads ntfy\'s ?auth= (or ?authorization=) over the header, in either base64 alphabet, padded or not', () => {
    const { credentials } = ADAPTERS.ntfy;
    const wrongHeader = { authorization: `Bearer ${OTHER_KEY}` };
    expect(readCredential({ headers: wrongHeader, query: { auth: ntfyAuth(`Bearer ${KEY}`) } }, credentials)).toEqual({ method: 'query-bearer', key: KEY });
    expect(readCredential({ headers: {}, query: { authorization: ntfyAuth(basic('', KEY)) } }, credentials)).toEqual({ method: 'query-basic', key: KEY });
    const padded = Buffer.from(`Bearer ${KEY}x1`).toString('base64');
    expect(padded.endsWith('=')).toBe(true);
    expect(readCredential({ headers: {}, query: { auth: padded } }, credentials).key).toBe(`${KEY}x1`);
    const urlSafe = Buffer.from(`Bearer ${KEY}`).toString('base64url');
    expect(readCredential({ headers: {}, query: { auth: urlSafe } }, credentials).key).toBe(KEY);
    expect(readCredential({ headers: {}, query: { auth: ntfyAuth('nonsense') } }, credentials)).toEqual({ malformed: true });
    expect(readCredential(headers({ authorization: basic('', KEY) }), credentials)).toEqual({ method: 'basic', key: KEY });
  });
});

describe('createKeyMatcher', () => {
  const config = parseIntakeConfig({ ALERT_INTAKE_KEYS: `signoz:${KEY},kuma:${OTHER_KEY},signoz:${THIRD}` });

  it('finds the entry for a configured key and nothing for another', () => {
    const match = createKeyMatcher(config.keys);
    expect(match(KEY).source).toBe('signoz');
    expect(match(OTHER_KEY).source).toBe('kuma');
    expect(match(`${KEY}x`)).toBeNull();
    expect(match('')).toBeNull();
  });

  it('compares the presented digest with every key, whichever matches', () => {
    for (const presented of [KEY, THIRD, 'nobody-nobody-nobody-nobody-nobody']) {
      const equal = jest.fn(timingSafeEqual);
      createKeyMatcher(config.keys, equal)(presented);
      expect(equal).toHaveBeenCalledTimes(3);
      for (const [a, b] of equal.mock.calls) expect([a.length, b.length]).toEqual([32, 32]);
    }
  });
});
