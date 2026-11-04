/**
 * No feedback loop (PLAN.md §7): a failing relay must not become a log alert,
 * which would go to Discord in turn. The alert-intake category's lines are
 * counted but never fingerprinted (lib/alerts/tally.mjs
 * UNALERTED_CATEGORIES), the intake's Discord path logs nothing, and the
 * intake writes under no other runtime category. Runs the real tally and the
 * real rules with their default settings; the same lines under another
 * category do fire, so the test can fail.
 */

import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LogTally, UNALERTED_CATEGORIES } from '../../../../lib/alerts/tally.mjs';
import { evaluateRules } from '../../../../lib/alerts/rules.mjs';
import { DEFAULT_ALERTING } from '../../../../lib/alerts/settings.mjs';

const MINUTE = 60_000;
const FINGERPRINT_RULES = ['recurring', 'error-burst', 'new-error', 'fingerprint-flood'];

/** 500 relay-failure lines, warn and error, over 30 minutes, then what the rules say. */
function firingAfterBurst(category) {
  let clock = Date.parse('2026-11-04T09:00:00Z');
  const tally = new LogTally({ now: () => clock });
  for (let index = 0; index < 500; index += 1) {
    clock += (30 * MINUTE) / 500;
    tally.record({ level: index % 2 ? 'warn' : 'error', category, message: `Relay to Discord failed for signoz: Discord refused it: Cannot send messages to this user; new sends pause for 30 s` });
  }
  const newFingerprints = new Map(tally.drainFingerprints().map((sighting) => [sighting.fp, sighting]));
  const firing = evaluateRules({
    snapshot: tally.snapshot(),
    active: new Map(),
    newFingerprints,
    home: { failingSince: null, url: null },
    rules: DEFAULT_ALERTING.rules,
  });
  return { tally, rules: [...firing.values()].map((alert) => alert.rule).filter((rule) => FINGERPRINT_RULES.includes(rule)) };
}

describe('relay failures and the log alert rules', () => {
  it('start no fingerprint rule from alert-intake lines, which still count toward the totals', () => {
    expect(UNALERTED_CATEGORIES.has('alert-intake')).toBe(true);
    const { tally, rules } = firingAfterBurst('alert-intake');
    expect(rules).toEqual([]);
    const counted = tally.snapshot().minutes.reduce((sum, minute) => sum + (minute.categories.get('alert-intake') ?? 0), 0);
    expect(counted).toBe(500);
  });

  it('do start them under any other category (the test can fail)', () => {
    const { rules } = firingAfterBurst('notificationManager');
    expect(rules).toEqual(expect.arrayContaining(['error-burst', 'new-error']));
  });

  it('keep the setup category alertable: a startup misconfiguration is loud', () => {
    expect(UNALERTED_CATEGORIES.has('alert-intake-setup')).toBe(false);
  });
});

const INTAKE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'integrations', 'alert-intake');

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith('.mjs') ? [{ name: full.slice(INTAKE_DIR.length + 1), text: readFileSync(full, 'utf8') }] : [];
  });
}

describe('the intake source', () => {
  const files = sources(INTAKE_DIR);
  const code = (text) => text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');

  it('never sends through sendDiscordEmbed, whose failures log warn lines under notificationManager', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((file) => /sendDiscordEmbed\s*\(/.test(code(file.text))).map((file) => file.name)).toEqual([]);
  });

  it('logs under alert-intake, and under alert-intake-setup only in index.mjs, at startup', () => {
    const loggers = files.flatMap((file) => [...file.text.matchAll(/createCategoryLogger\(\s*'([^']+)'\s*\)/g)].map((match) => [file.name, match[1]]));
    expect(loggers.sort()).toEqual([
      ['index.mjs', 'alert-intake'],
      ['index.mjs', 'alert-intake-setup'],
    ]);
  });

  it('never passes an error on to Express', () => {
    expect(files.filter((file) => /\bnext\s*\(\s*(err|error)\b/.test(code(file.text))).map((file) => file.name)).toEqual([]);
  });
});
