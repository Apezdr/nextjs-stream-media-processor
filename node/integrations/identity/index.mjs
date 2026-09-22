/**
 * Identity service — the single object app.mjs talks to.
 *
 * Wires the registry, the per-tick index build, the reconciler, and webhook
 * handling behind three calls:
 *
 *   reconcileForTick()             run at the top of every scan tick
 *   handleWebhook(name, body)      a provider pushed an event
 *   getStatus() / getLastReport()  for the admin endpoints
 *
 * Disabled (no provider configured) is a first-class state: every call is a
 * cheap no-op that says so, and the scan proceeds exactly as before.
 */

import { createIdentityProviders, parseUnsourcedPinTreatment } from './registry.mjs';
import { buildIdentityIndex } from './index-builder.mjs';
import { reconcileIdentities, reconcileClaim, listLibraryFolders } from './reconciler.mjs';
import { SCAN_TRIGGER_KINDS, EVENT_KINDS } from './provider.mjs';

/**
 * @param {Object} options
 * @param {Object} [options.env=process.env]
 * @param {string} options.basePath          library root (BASE_PATH)
 * @param {Object} [options.logger]
 * @param {(reason: string) => Promise<any>|void} [options.requestScan]  ask the host to scan soon (webhook path)
 * @param {Function} [options.fetchImpl]      injectable fetch for tests
 * @param {Function} [options.build]          injectable buildIdentityIndex
 * @param {Function} [options.reconcile]      injectable reconcileIdentities
 * @param {Function} [options.reconcileOne]   injectable reconcileClaim
 */
export function createIdentityService({
  env = process.env,
  basePath,
  logger = null,
  requestScan = null,
  fetchImpl = undefined,
  build = buildIdentityIndex,
  reconcile = reconcileIdentities,
  reconcileOne = reconcileClaim,
} = {}) {
  if (!basePath) throw new Error('identity service needs basePath');

  const { providers, errors: configErrors } = createIdentityProviders(env, { fetchImpl, logger });
  const unsourcedPinTreatment = parseUnsourcedPinTreatment(env.IDENTITY_UNSOURCED_PINS, logger);
  const enabled = providers.length > 0;

  let lastReport = null;
  let lastIndex = null;
  let inFlight = null;
  const recentEvents = [];
  const RECENT_EVENTS_CAP = 50;

  if (enabled) {
    logger?.info(
      `identity: enabled with ${providers.map((p) => p.name).join(', ')}; unsourced pins read as ${unsourcedPinTreatment}`
    );
  } else if (configErrors.length > 0) {
    logger?.warn('identity: disabled — every configured provider failed validation');
  } else {
    logger?.info('identity: disabled (no provider configured)');
  }

  /**
   * Pull every provider and reconcile the library. Concurrent callers share
   * one run. Never throws.
   * @param {Object} [options]
   * @param {string} [options.reason]
   * @returns {Promise<Object>} report, or `{ enabled: false }` when disabled
   */
  async function reconcileForTick({ reason = 'scan-tick' } = {}) {
    if (!enabled) return { enabled: false, reason };
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const index = await build(providers, { logger });
        lastIndex = index;
        if (!index.hasData) {
          logger?.warn('identity: no provider answered this tick; library left untouched');
          lastReport = {
            at: index.builtAt,
            reason,
            durationMs: index.durationMs,
            unsourcedPinTreatment,
            index: index.summary(),
            skipped: 'no-provider-data',
          };
          return lastReport;
        }
        lastReport = await reconcile({ index, basePath, unsourcedPinTreatment, logger, reason });
        return lastReport;
      } catch (error) {
        logger?.error(`identity: reconcile failed, scan proceeds without it: ${error.message}`);
        lastReport = { at: new Date().toISOString(), reason, error: error.message };
        return lastReport;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /**
   * A provider pushed an event. Reconciles the folder it names and, for
   * import-like events, asks the host to scan soon.
   * @param {string} providerName
   * @param {Object} body
   * @param {Object} [headers]
   * @returns {Promise<Object>} what happened, for the HTTP response and the log
   */
  async function handleWebhook(providerName, body, headers = {}) {
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) {
      return { accepted: false, status: 404, error: `unknown or unconfigured identity provider '${providerName}'` };
    }
    if (!provider.supportsWebhook) {
      return { accepted: false, status: 400, error: `provider '${providerName}' does not accept webhooks` };
    }

    const events = provider.parseWebhook(body, headers);
    if (events.length === 0) {
      return { accepted: false, status: 400, error: 'payload not recognized' };
    }

    const results = [];
    let scanRequested = false;
    for (const event of events) {
      const entry = { kind: event.kind, rawType: event.rawType, libraryRelativePath: event.claim?.libraryRelativePath ?? null };
      if (event.kind === EVENT_KINDS.TEST) {
        logger?.info(`identity: ${provider.name} webhook test received`);
      } else if (event.claim && event.kind !== EVENT_KINDS.DELETED && event.kind !== EVENT_KINDS.FILE_DELETED) {
        const folders = await listLibraryFolders(basePath, event.claim.mediaType);
        const result = await reconcileOne(event.claim, { basePath, unsourcedPinTreatment, foldersOnDisk: folders });
        entry.outcome = result.outcome;
        if (result.decision) entry.decision = { action: result.decision.action, reason: result.decision.reason, tmdbId: result.decision.tmdbId ?? null };
        if (result.error) entry.error = result.error;
      }
      if (SCAN_TRIGGER_KINDS.has(event.kind) && requestScan) {
        scanRequested = true;
      }
      results.push(entry);
      recentEvents.unshift({ at: new Date().toISOString(), provider: provider.name, ...entry });
      if (recentEvents.length > RECENT_EVENTS_CAP) recentEvents.length = RECENT_EVENTS_CAP;
      logger?.info(`identity: ${provider.name} webhook ${event.rawType} → ${event.kind}` +
        (entry.libraryRelativePath ? ` ${entry.libraryRelativePath}` : '') +
        (entry.outcome ? ` (${entry.outcome})` : ''));
    }

    if (scanRequested) {
      // Fire and forget: the webhook answers immediately; the scan is the
      // host's normal tick started early, coalesced by the host.
      Promise.resolve()
        .then(() => requestScan(`${provider.name}-webhook`))
        .catch((error) => logger?.warn(`identity: early scan request failed: ${error.message}`));
    }

    return { accepted: true, status: 200, provider: provider.name, events: results, scanRequested };
  }

  function getStatus() {
    return {
      enabled,
      unsourcedPinTreatment,
      providers: providers.map((p) => ({ ...p.describe(), lastFetch: p.lastFetch })),
      configErrors,
      lastIndex: lastIndex?.summary() ?? null,
      lastReport: lastReport
        ? { at: lastReport.at, reason: lastReport.reason, durationMs: lastReport.durationMs, totals: lastReport.totals ?? null, error: lastReport.error ?? null, skipped: lastReport.skipped ?? null }
        : null,
      recentEvents,
    };
  }

  return {
    enabled,
    providers,
    unsourcedPinTreatment,
    reconcileForTick,
    handleWebhook,
    getStatus,
    getLastReport: () => lastReport,
  };
}
