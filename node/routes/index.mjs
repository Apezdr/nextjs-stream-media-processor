import express from 'express';
import blurhashRoutes from './blurhash.mjs';
import metadataHashesRoutes from './metadataHashes.mjs';
import systemStatusRoutes from './systemStatus.mjs';

/**
 * Initialize and configure all API routes
 * @returns {object} Configured Express router
 */
export function setupRoutes() {
  const router = express.Router();
  
  // Mount route modules
  router.use('/api', blurhashRoutes);
  router.use('/api', metadataHashesRoutes);
  router.use('/api', systemStatusRoutes);
  
  return router;
}
