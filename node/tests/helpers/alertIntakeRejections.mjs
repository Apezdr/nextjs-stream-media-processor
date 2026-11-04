/**
 * Run by tests/unit/integrations/alert-intake/no-unhandled-rejections.test.mjs
 * in its own Node process: Jest's ESM sandbox doesn't surface process-level
 * unhandled rejections, and in the processor one shuts the process down
 * (app.mjs). Drives the relay through every path that settles after a
 * request has its answer, with a sink, a summary send and a logger that all
 * throw, on real timers made short. Prints "ok" and exits 0 when no rejection
 * went unhandled; prints the reason and exits 1 otherwise.
 */

import { createIntakeRelay } from '../../integrations/alert-intake/relay.mjs';
import { intakeAlert } from '../../integrations/alert-intake/alert.mjs';

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason?.stack ?? reason)));
// Proves the probe can fail: one deliberate unhandled rejection.
if (process.env.ALERT_INTAKE_PROBE_SELF_TEST === '1') Promise.reject(new Error('self test'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The relay's timers are unref'd (the HTTP server keeps the processor alive); this stands in for it.
const keepAlive = setInterval(() => {}, 1000);
const thrower = () => {
  throw new Error('log down');
};
const log = { info: thrower, warn: thrower, debug: thrower, error: thrower };
let mode = 'reject';
let lateGate = null;
const sink = {
  hasTargets: () => true,
  deliver() {
    if (mode === 'reject') return Promise.reject(new Error('discord.js exploded'));
    if (mode === 'throw') throw new Error('sink threw synchronously');
    if (mode === 'late') {
      return new Promise((resolve, reject) => {
        lateGate = { resolve, reject };
      });
    }
    return Promise.resolve({ ok: true, delivered: 1, failed: 0 });
  },
};

const relay = createIntakeRelay({
  sink,
  processorLabel: 'probe',
  log,
  limits: { sourceBurst: 1, sourcePerHour: 3600 * 20, globalBurst: 50, globalPerHour: 3600 * 50 },
  responseBudgetMs: 20,
  breakerMs: 30,
  abandonAfterMs: 60,
  minSummaryDelayMs: 1,
  observers: [() => thrower()],
});
const alert = (fingerprint, severity = 'warning') =>
  intakeAlert({ format: 'generic', kind: 'stateful', title: `t ${fingerprint}`, fingerprint, severity }, Date.now());
const context = { source: 'probe', format: 'generic' };

await relay.deliver([alert('a')], context); // the sink rejects
await wait(40);
mode = 'throw';
await relay.deliver([alert('b')], context); // the sink throws
await wait(40);
mode = 'late';
await relay.deliver([alert('c')], context); // answers at the 20 ms budget, settles later
lateGate.reject(new Error('late failure'));
await wait(40);
mode = 'late';
await relay.deliver([alert('d')], context); // never settles: abandoned at 60 ms
await wait(100);
lateGate.resolve({ ok: true, delivered: 1, failed: 0 }); // lands after being abandoned
mode = 'reject';
await relay.deliver([alert('e')], context);
await relay.deliver([alert('f')], context); // held: the summary send rejects
await relay.deliver([alert('g')], context);
await wait(150);
mode = 'throw';
await relay.deliver([alert('h')], context);
await relay.deliver([alert('i')], context); // held: the summary send throws
await wait(150);
await relay.drain();
await wait(20);

clearInterval(keepAlive);
if (unhandled.length) {
  console.log(unhandled.join('\n---\n'));
  process.exit(1);
}
console.log('ok');
