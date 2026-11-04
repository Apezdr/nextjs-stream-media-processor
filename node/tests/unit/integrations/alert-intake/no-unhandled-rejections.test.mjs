/**
 * No path through the relay leaves a promise rejected and unhandled: in the
 * processor that shuts the process down (app.mjs's unhandledRejection
 * handler). Run in a child process, because Jest's ESM sandbox doesn't show
 * process-level unhandled rejections to a listener (checked: a bare
 * Promise.reject in a test never reaches process.on('unhandledRejection')).
 */

import { describe, it, expect } from '@jest/globals';
import { execFile } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'helpers', 'alertIntakeRejections.mjs');

const run = (env = {}) =>
  new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { timeout: 20_000, env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr })
    );
  });

describe('the relay', () => {
  it('runs a probe that does catch an unhandled rejection', async () => {
    const { code, stdout } = await run({ ALERT_INTAKE_PROBE_SELF_TEST: '1' });
    expect(stdout).toContain('self test');
    expect(code).toBe(1);
  }, 30_000);

  it('leaves no rejection unhandled when sends, late settlements, summaries and logging all fail', async () => {
    const { code, stdout } = await run();
    expect(stdout.trim()).toBe('ok');
    expect(code).toBe(0);
  }, 30_000);
});
