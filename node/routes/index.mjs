import express from 'express';
import { telemetryMiddleware, telemetryErrorMiddleware } from '../middleware/telemetryMiddleware.mjs';
import { setupBlurhashRoutes } from './blurhash.mjs';
import { setupMetadataHashesRoutes } from './metadataHashes.mjs';
import { setupSystemStatusRoutes } from './systemStatus.mjs';
import { setupTmdbRoutes } from './tmdb.mjs';
import { setupAdminRoutes } from './admin.mjs';
import { setupDiscordRoutes } from '../integrations/discord/routes.mjs';

/**
 * Initialize and configure all API routes
 * @returns {object} Configured Express router
 */
export function setupRoutes() {
  const router = express.Router();
  
  // Add OpenTelemetry middleware for all routes
  router.use(telemetryMiddleware());
  
  // Mount route modules
  router.use('/api', setupBlurhashRoutes());
  router.use('/api', setupMetadataHashesRoutes());
  router.use('/api', setupSystemStatusRoutes());
  router.use('/api/tmdb', setupTmdbRoutes());
  router.use('/api/admin', setupAdminRoutes());
  // Integrations
  router.use('/api', setupDiscordRoutes());  // Discord webhook events
  
  // Debug logging to verify routes are mounted
  console.log('[Routes] Mounted: /api/blurhash, /api/metadata-hashes, /api/system-status');
  console.log('[Routes] Mounted: /api/tmdb/*, /api/admin/*, /api/discord');
  if (process.env.OTEL_ENABLED?.toLowerCase() === 'true') {
    console.log('[Telemetry] Added OpenTelemetry tracing middleware');
  }

  // Error middleware must be added last
  router.use(telemetryErrorMiddleware());
  
  return router;
}
