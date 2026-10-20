/**
 * Log alerts for this process: the one alert manager, started from app.mjs
 * once Mongo is up, ticking once a minute. If Mongo isn't reachable yet the
 * start is retried every minute; alerting never holds up anything else.
 * GET /api/alerts (routes/alerts.mjs) reads it.
 */

import os from 'os';
import { createCategoryLogger, logTally } from '../logger.mjs';
import { getProcessorId } from '../processorIdentity.mjs';
import { getNotificationManager } from '../../integrations/index.mjs';
import { createAlertStore } from './store.mjs';
import { createAlertNotifier } from './notifier.mjs';
import { createAlertManager } from './manager.mjs';
import { createSettingsLoader } from './settings.mjs';
import { getAppConfigDb } from '../../database.mjs';
import { evaluateRules } from './rules.mjs';

const logger = createCategoryLogger('log-alerts');
const TICK_MS = 60_000;

let manager = null;
let starting = null;

function serverLabel() {
  try {
    if (process.env.FILE_SERVER_NODE_URL) return new URL(process.env.FILE_SERVER_NODE_URL).hostname;
  } catch {
    // fall through to the hostname
  }
  return os.hostname();
}

async function create() {
  const processorId = await getProcessorId();
  const candidate = createAlertManager({
    tally: logTally,
    store: createAlertStore(),
    notifier: createAlertNotifier({
      notificationManager: getNotificationManager(),
      processor: { id: processorId, label: serverLabel() },
    }),
    loadSettings: createSettingsLoader({ getDb: getAppConfigDb }),
    evaluateRules,
    processorId,
    logger,
  });
  await candidate.start();
  return candidate;
}

export function startLogAlerts() {
  if (starting) return starting;
  starting = (async () => {
    for (;;) {
      try {
        manager = await create();
        break;
      } catch (error) {
        logger.error(`Log alerts couldn't start, retrying in a minute: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, TICK_MS).unref());
      }
    }
    setInterval(() => {
      manager.tick().catch((error) => logger.error(`Log alert check failed: ${error.message}`));
    }, TICK_MS).unref();
    logger.info('Log alerts started');
  })();
  return starting;
}

/** The running manager, or null before it has started. */
export function getLogAlerts() {
  return manager;
}
