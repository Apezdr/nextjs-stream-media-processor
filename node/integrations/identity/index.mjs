/**
 * Identity service — the single object app.mjs talks to.
 *
 * Wires the registry, the index build, the reconciler, and webhook handling
 * behind a few calls:
 *
 *   reconcileForTick({ reason })   run now (scan tick, manual, job, webhook)
 *   start() / stop()               the service's own reconcile job
 *   handleWebhook(name, body)      a provider pushed an event
 *   getStatus() / getLastReport()  for the admin endpoints
 *
 * Freshness is the service's own responsibility, not the scan tick's. A scan
 * tick can run for ten minutes after a batch of repairs; the job below keeps
 * pulling the providers every IDENTITY_RECONCILE_INTERVAL_SECONDS regardless,
 * and a change detector makes a quiet minute cost only the pulls:
 *
 *   - the index fingerprints every provider list over (path, tmdbId, hasFile)
 *   - the library's folder names are fingerprinted the same way
 *   - if neither moved since the last real run, the report keeps its `at` and
 *     gets a fresh `checkedAt` with `unchanged: true`; nothing on disk is read
 *     or written
 *
 * Runs with reason `scan-tick` or `manual` are forced: they always reconcile,
 * so a scan starts from fresh pins and the button always does something.
 *
 * Disabled (no provider configured) is a first-class state: every call is a
 * cheap no-op that says so, and the scan proceeds exactly as before.
 */

import { createIdentityProviders, parseUnsourcedPinTreatment } from './registry.mjs';
import { buildIdentityIndex } from './index-builder.mjs';
import { reconcileIdentities, reconcileClaim, listAllLibraryFolders, fingerprintFolders } from './reconciler.mjs';
import { createExternalIdResolver } from './external-id-resolver.mjs';
import { SCAN_TRIGGER_KINDS, EVENT_KINDS } from './provider.mjs';

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 15;
/** The scan cadence in app.mjs; freshness falls back to it when the job is off. */
const SCAN_TICK_MS = 3 * 60 * 1000;
const STALE_FACTOR = 3;
/** Reasons that always reconcile, bypassing the change detector. */
const FORCED_REASONS = new Set(['scan-tick', 'manual']);
const RECENT_EVENTS_CAP = 50;

/**
 * IDENTITY_RECONCILE_INTERVAL_SECONDS → milliseconds. `0` turns the job off
 * (the scan tick still reconciles). Below the minimum is raised to it; an
 * unparseable value is the default, with a warning.
 * @param {string|undefined} raw
 * @param {Object} [logger]
 * @returns {number}
 */
export function parseReconcileIntervalMs(raw, logger = null) {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_INTERVAL_SECONDS * 1000;
  const seconds = Number.parseInt(value, 10);
  if (!Number.isInteger(seconds) || seconds < 0) {
    logger?.warn(`identity: IDENTITY_RECONCILE_INTERVAL_SECONDS='${raw}' is not a non-negative integer; using ${DEFAULT_INTERVAL_SECONDS}`);
    return DEFAULT_INTERVAL_SECONDS * 1000;
  }
  if (seconds === 0) return 0;
  if (seconds < MIN_INTERVAL_SECONDS) {
    logger?.warn(`identity: IDENTITY_RECONCILE_INTERVAL_SECONDS=${seconds} is below the ${MIN_INTERVAL_SECONDS}s minimum; using ${MIN_INTERVAL_SECONDS}`);
    return MIN_INTERVAL_SECONDS * 1000;
  }
  return seconds * 1000;
}

/**
 * @param {Object} options
 * @param {Object} [options.env=process.env]
 * @param {string} options.basePath          library root (BASE_PATH)
 * @param {Object} [options.logger]
 * @param {(reason: string) => Promise<any>|void} [options.requestScan]  ask the host to scan soon
 * @param {Function} [options.fetchImpl]      injectable fetch for tests
 * @param {number} [options.intervalMs]       overrides the env-derived job interval (tests)
 * @param {Function} [options.build]          injectable buildIdentityIndex
 * @param {Function} [options.reconcile]      injectable reconcileIdentities
 * @param {Function} [options.reconcileOne]   injectable reconcileClaim
 * @param {Function} [options.resolveExternalId]  injectable external-id resolver (default: TMDB /find)
 * @param {Function} [options.listFolders]    injectable listAllLibraryFolders
 * @param {() => Date} [options.now]          injectable clock
 * @param {Function} [options.setIntervalImpl]  injectable timer (tests)
 * @param {Function} [options.clearIntervalImpl]
 */
export function createIdentityService({
  env = process.env,
  basePath,
  logger = null,
  requestScan = null,
  fetchImpl = undefined,
  intervalMs = undefined,
  build = buildIdentityIndex,
  reconcile = reconcileIdentities,
  reconcileOne = reconcileClaim,
  resolveExternalId = undefined,
  listFolders = listAllLibraryFolders,
  now = () => new Date(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (!basePath) throw new Error('identity service needs basePath');

  const { providers, errors: configErrors } = createIdentityProviders(env, { fetchImpl, logger });
  const unsourcedPinTreatment = parseUnsourcedPinTreatment(env.IDENTITY_UNSOURCED_PINS, logger);
  const enabled = providers.length > 0;
  const reconcileIntervalMs = intervalMs ?? parseReconcileIntervalMs(env.IDENTITY_RECONCILE_INTERVAL_SECONDS, logger);
  const staleAfterMs = STALE_FACTOR * (reconcileIntervalMs || SCAN_TICK_MS);
  const resolver = resolveExternalId === undefined ? createExternalIdResolver({ logger }) : resolveExternalId;

  let lastReport = null;
  let lastIndex = null;
  let lastFingerprint = null;
  let inFlight = null;
  let timer = null;
  const recentEvents = [];

  if (enabled) {
    logger?.info(
      `identity: enabled with ${providers.map((p) => p.name).join(', ')}; unsourced pins read as ${unsourcedPinTreatment}; ` +
      (reconcileIntervalMs ? `job every ${reconcileIntervalMs / 1000}s` : 'job off (scan tick only)')
    );
  } else if (configErrors.length > 0) {
    logger?.warn('identity: disabled — every configured provider failed validation');
  } else {
    logger?.info('identity: disabled (no provider configured)');
  }

  function stamp(report, checkedAt, reason, unchanged) {
    return { ...report, checkedAt, checkedReason: reason, unchanged, staleAfterMs };
  }

  /**
   * Pull every provider and reconcile the library (or, on an unforced run
   * with nothing changed, just refresh `checkedAt`). Concurrent callers share
   * one run. Never throws.
   * @param {Object} [options]
   * @param {string} [options.reason]  scan-tick | manual | identity-tick | <provider>-webhook
   * @param {boolean} [options.force]  bypass the change detector; defaults by reason
   * @returns {Promise<Object>} report, or `{ enabled: false }` when disabled
   */
  async function reconcileForTick({ reason = 'scan-tick', force = FORCED_REASONS.has(reason) } = {}) {
    if (!enabled) return { enabled: false, reason };
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const checkedAt = now().toISOString();
      try {
        const index = await build(providers, { logger, resolveExternalId: resolver });
        lastIndex = index;

        if (!index.hasData) {
          logger?.warn('identity: no provider answered this tick; library left untouched');
          lastReport = stamp({
            at: index.builtAt,
            reason,
            durationMs: index.durationMs,
            unsourcedPinTreatment,
            index: index.summary(),
            skipped: 'no-provider-data',
          }, checkedAt, reason, false);
          return lastReport;
        }

        if (!index.allOk && !force && lastReport && !lastReport.error && !lastReport.skipped) {
          // One provider down on the job path: reconciling with half the
          // picture would list every folder of the missing type as unmanaged.
          // Keep the last good report, untouched; the failure is on the
          // provider's lastFetch for the status endpoint.
          const failed = index.providers.filter((p) => !p.ok).map((p) => p.name);
          logger?.warn(`identity: ${failed.join(', ')} failed on the job path; keeping the last report as-is`);
          // The next run after a failure must reconcile, not trust a
          // fingerprint taken before the outage.
          lastFingerprint = null;
          return { ...lastReport, deferred: 'provider-failure', failedProviders: failed };
        }

        const foldersByType = await listFolders(basePath);
        const key = `${index.fingerprint}|${fingerprintFolders(foldersByType)}|${unsourcedPinTreatment}`;

        if (!force && lastReport && !lastReport.error && !lastReport.skipped && lastFingerprint === key) {
          lastReport = stamp(lastReport, checkedAt, reason, true);
          logger?.debug(`identity: nothing changed since ${lastReport.at} (${reason}); report checked, not rebuilt`);
          return lastReport;
        }

        const report = await reconcile({
          index,
          basePath,
          unsourcedPinTreatment,
          logger,
          reason,
          listFolders: async (_base, mediaType) => foldersByType[mediaType] ?? new Set(),
        });
        // `at` and `checkedAt` are the same instant on a real run: the start
        // of this pass, on the service's clock.
        lastReport = stamp({ ...report, at: checkedAt }, checkedAt, reason, false);
        lastFingerprint = index.allOk ? key : null;

        // A repair found outside the scan tick changes an existing title;
        // regenerate it now rather than at the next tick.
        if (reason !== 'scan-tick' && requestScan && report.written.items.some((w) => w.replacedId)) {
          Promise.resolve()
            .then(() => requestScan('identity-repair'))
            .catch((error) => logger?.warn(`identity: early scan request failed: ${error.message}`));
        }
        return lastReport;
      } catch (error) {
        logger?.error(`identity: reconcile failed, scan proceeds without it: ${error.message}`);
        lastReport = stamp({ at: checkedAt, reason, error: error.message }, checkedAt, reason, false);
        return lastReport;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /**
   * Start the service's own reconcile job.
   * @returns {boolean} whether a job was started
   */
  function start() {
    if (!enabled || reconcileIntervalMs === 0 || timer) return false;
    timer = setIntervalImpl(() => {
      reconcileForTick({ reason: 'identity-tick' }).catch(() => {});
    }, reconcileIntervalMs);
    timer?.unref?.();
    logger?.info(`identity: reconcile job started (every ${reconcileIntervalMs / 1000}s)`);
    return true;
  }

  function stop() {
    if (!timer) return;
    clearIntervalImpl(timer);
    timer = null;
    logger?.info('identity: reconcile job stopped');
  }

  /**
   * A provider pushed an event. Reconciles the folder it names, refreshes the
   * report, and for import-like events asks the host to scan soon.
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
    let touchedLibrary = false;
    for (const event of events) {
      const entry = { kind: event.kind, rawType: event.rawType, libraryRelativePath: event.claim?.libraryRelativePath ?? null };
      if (event.kind === EVENT_KINDS.TEST) {
        logger?.info(`identity: ${provider.name} webhook test received`);
      } else if (event.claim && event.kind !== EVENT_KINDS.DELETED && event.kind !== EVENT_KINDS.FILE_DELETED) {
        const folders = await listFolders(basePath);
        const result = await reconcileOne(event.claim, {
          basePath,
          unsourcedPinTreatment,
          foldersOnDisk: folders[event.claim.mediaType] ?? new Set(),
        });
        entry.outcome = result.outcome;
        if (result.decision) entry.decision = { action: result.decision.action, reason: result.decision.reason, tmdbId: result.decision.tmdbId ?? null };
        if (result.error) entry.error = result.error;
        if (result.outcome === 'unidentified') entry.externalIds = event.claim.externalIds;
        touchedLibrary = true;
      }
      if (SCAN_TRIGGER_KINDS.has(event.kind) && requestScan) {
        scanRequested = true;
      }
      results.push(entry);
      recentEvents.unshift({ at: now().toISOString(), provider: provider.name, ...entry });
      if (recentEvents.length > RECENT_EVENTS_CAP) recentEvents.length = RECENT_EVENTS_CAP;
      logger?.info(`identity: ${provider.name} webhook ${event.rawType} → ${event.kind}` +
        (entry.libraryRelativePath ? ` ${entry.libraryRelativePath}` : '') +
        (entry.outcome ? ` (${entry.outcome})` : ''));
    }

    // The report must not describe a state the processor already knows is
    // old. A full run is coalesced, so a burst of imports costs one.
    let reportRefreshed = false;
    if (touchedLibrary) {
      await reconcileForTick({ reason: `${provider.name}-webhook`, force: true });
      reportRefreshed = true;
    }

    if (scanRequested) {
      // Fire and forget: the webhook answers immediately; the scan is the
      // host's normal tick started early, coalesced by the host.
      Promise.resolve()
        .then(() => requestScan(`${provider.name}-webhook`))
        .catch((error) => logger?.warn(`identity: early scan request failed: ${error.message}`));
    }

    return { accepted: true, status: 200, provider: provider.name, events: results, scanRequested, reportRefreshed };
  }

  function getStatus() {
    return {
      enabled,
      unsourcedPinTreatment,
      reconcileIntervalMs,
      staleAfterMs,
      jobRunning: !!timer,
      providers: providers.map((p) => ({ ...p.describe(), lastFetch: p.lastFetch })),
      configErrors,
      lastIndex: lastIndex?.summary() ?? null,
      lastReport: lastReport
        ? {
            at: lastReport.at,
            checkedAt: lastReport.checkedAt ?? null,
            checkedReason: lastReport.checkedReason ?? null,
            unchanged: lastReport.unchanged ?? false,
            staleAfterMs,
            reason: lastReport.reason,
            durationMs: lastReport.durationMs,
            totals: lastReport.totals ?? null,
            error: lastReport.error ?? null,
            skipped: lastReport.skipped ?? null,
          }
        : null,
      recentEvents,
    };
  }

  return {
    enabled,
    providers,
    unsourcedPinTreatment,
    reconcileIntervalMs,
    staleAfterMs,
    reconcileForTick,
    start,
    stop,
    handleWebhook,
    getStatus,
    getLastReport: () => lastReport,
  };
}
