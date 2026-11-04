/**
 * The name this processor goes by in its own notifications: the host of
 * FILE_SERVER_NODE_URL, else the machine's hostname. Log alerts
 * (lib/alerts/index.mjs) and relayed alerts (integrations/alert-intake/) both
 * put it on their Discord embeds, so a sysadmin with several processors can
 * tell them apart. Kept apart from lib/alerts/index.mjs, which pulls in Mongo.
 */

import os from 'os';

export function serverLabel(env = process.env) {
  try {
    if (env.FILE_SERVER_NODE_URL) return new URL(env.FILE_SERVER_NODE_URL).hostname;
  } catch {
    // fall through to the hostname
  }
  return os.hostname();
}
