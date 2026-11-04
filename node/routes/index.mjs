import express from 'express';
import { telemetryErrorMiddleware } from '../middleware/telemetryMiddleware.mjs';
import { setupMetadataHashesRoutes } from './metadataHashes.mjs';
import { setupSystemStatusRoutes } from './systemStatus.mjs';
import { setupTmdbRoutes } from './tmdb.mjs';
import { setupAdminRoutes } from './admin.mjs';
import { setupCaptionsRoutes } from './captions.mjs';
import { setupLogsRoutes } from './logs.mjs';
import { setupAlertsRoutes } from './alerts.mjs';
import { setupDiscordRoutes } from '../integrations/discord/routes.mjs';
import { setupAlertIntakeRoutes } from '../integrations/alert-intake/routes.mjs';
import { ALERT_INTAKE_PREFIX } from '../integrations/alert-intake/config.mjs';

/**
 * Initialize and configure all API routes
 * @returns {object} Configured Express router
 */
export function setupRoutes() {
  const router = express.Router();

  // Mount route modules
  // First: alerts other apps send in (integrations/alert-intake/). It answers
  // every path under its prefix and every error itself.
  router.use(ALERT_INTAKE_PREFIX, setupAlertIntakeRoutes());
  router.use('/api', setupMetadataHashesRoutes());
  router.use('/api', setupSystemStatusRoutes());
  router.use('/api', setupLogsRoutes());
  router.use('/api', setupAlertsRoutes());
  router.use('/api/tmdb', setupTmdbRoutes());
  router.use('/api/admin', setupAdminRoutes());
  // Captions module declares both /admin/captions/* and /captions/* — mount at /api
  router.use('/api', setupCaptionsRoutes());
  // Integrations
  router.use('/api', setupDiscordRoutes());  // Discord webhook events

  // Debug logging to verify routes are mounted
  console.log('[Routes] Mounted: /api/metadata-hashes, /api/system-status, /api/logs, /api/alerts');
  console.log('[Routes] Mounted: /api/tmdb/*, /api/admin/*, /api/discord, /api/alert-intake/*');
  console.log('[Routes] Mounted: /api/captions/health, /api/admin/captions/generate');

  // Error middleware must be added last: it records a handler's error on the request's span
  router.use(telemetryErrorMiddleware());

  return router;
}
