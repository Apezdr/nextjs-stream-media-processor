/**
 * Alert intake: other apps send alerts here, in a format they already speak
 * (Alertmanager, Gotify, ntfy, or our own generic JSON), and this processor
 * relays them as Discord DMs from its bot and to its Discord webhooks. Forward
 * only: nothing is stored. The key is the authentication, over any URL.
 * Setup: integrations/alert-intake/README.md.
 *
 * This module builds the one intake for the process from the environment
 * (createAlertIntake, getAlertIntake) and reports its state once at startup,
 * loudly when it can't work: under alert-intake-setup, an ordinary category,
 * so a misconfiguration can become a log alert. A startup line can't loop.
 * Everything the intake logs while running goes under alert-intake, whose
 * lines are never fingerprinted (lib/alerts/tally.mjs UNALERTED_CATEGORIES),
 * so a failed relay can't turn into a log alert that tries Discord again.
 */

import { createCategoryLogger } from '../../lib/logger.mjs';
import { serverLabel } from '../../lib/serverLabel.mjs';
import { ADAPTERS } from './adapters/index.mjs';
import { createKeyMatcher } from './auth.mjs';
import { ALERT_INTAKE_PREFIX, KEYS_VARIABLE, parseIntakeConfig } from './config.mjs';
import { createDiscordSink } from './discordSink.mjs';
import { createLogThrottle, foldedText } from './logThrottle.mjs';
import { createIntakeRelay } from './relay.mjs';

/**
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} [options.log]       runtime lines (alert-intake)
 * @param {{ info: Function, warn: Function, error: Function, debug: Function }} [options.setupLog]  startup lines (alert-intake-setup)
 * @param {{ deliver(embeds: object[]): Promise<object>, hasTargets(): boolean }} [options.sink]  tests stub Discord here
 * @param {Function[]} [options.observers]  v2's seam (relay.mjs)
 */
export function createAlertIntake({
  env = process.env,
  log = createCategoryLogger('alert-intake'),
  setupLog = createCategoryLogger('alert-intake-setup'),
  // integrations/index.mjs pulls in the Discord bot and Mongo: loaded at the first send
  sink = createDiscordSink({ getManager: async () => (await import('../index.mjs')).getNotificationManager(), env }),
  now = Date.now,
  timers,
  observers = [],
  relayOptions = {},
} = {}) {
  const config = parseIntakeConfig(env);
  const throttled = createLogThrottle({ now });
  let lastId = 0;

  if (config.state === 'off') {
    setupLog.info(`Alert intake is off: ${KEYS_VARIABLE} is not set`);
  } else if (config.state === 'misconfigured') {
    for (const problem of config.problems) setupLog.error(`Alert intake configuration problem: ${problem}`);
    setupLog.error(`Alert intake is refusing every request (503) until ${KEYS_VARIABLE} is fixed: ${config.problems.length} problem(s) above`);
  } else {
    setupLog.info(
      `Alert intake on at ${ALERT_INTAKE_PREFIX} for ${config.sources.length} source(s): ${config.sources.join(', ')}; formats ${Object.keys(ADAPTERS).join(', ')}`
    );
    if (!sink.hasTargets()) {
      setupLog.error(
        'Alert intake has no Discord channel to relay to: configure NOTIFICATION_<n>_TYPE=discord_bot with DISCORD_NOTIFY_USERS, or a discord webhook channel. Until then every intake request answers 503'
      );
    }
  }

  const relay = createIntakeRelay({ sink, limits: config.limits, processorLabel: serverLabel(env), log, observers, now, timers, ...relayOptions });

  return {
    state: config.state,
    matchKey: createKeyMatcher(config.keys),
    relay,
    now,
    nextId: () => {
      lastId += 1;
      return lastId;
    },

    /** A request refused for its key. Only the route and the socket address are logged: the rest of a refused request is the caller's to choose. */
    refused({ reason, method, route, address }) {
      throttled('refused', reason, (folded) =>
        log.warn(`Refused an alert intake request (${reason}): ${method} ${route} from ${address ?? 'an unknown address'}${foldedText(folded)}`)
      );
    },

    /** A keyed sender's request the format couldn't read. The code is ours; the payload is never logged. */
    rejected({ source, format, code }) {
      throttled(`rejected:${source}:${format}`, code, (folded) => log.warn(`Refused ${/^[aeiou]/.test(format) ? 'an' : 'a'} ${format} request from ${source}: ${code}${foldedText(folded)}`));
    },

    /**
     * A bug: an exception inside the intake. Its name and where it was thrown,
     * not its message, which can quote the request.
     */
    failed(error) {
      const name = typeof error?.name === 'string' ? error.name.slice(0, 40) : 'Error';
      const frame = String(error?.stack ?? '').split('\n')[1]?.trim().slice(0, 200) ?? 'no stack';
      throttled('failed', name, (folded) => log.warn(`An alert intake request failed: ${name} ${frame}${foldedText(folded)}`));
    },
  };
}

let shared = null;

/** The process's one intake, built on first use (routes/index.mjs mounts it at startup). */
export function getAlertIntake() {
  shared ??= createAlertIntake();
  return shared;
}
