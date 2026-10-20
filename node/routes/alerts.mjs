/**
 * GET /api/alerts: this processor's log alerts, firing and resolved in the
 * last day ({ processorId, active, recent, checkedAt }; lib/alerts/).
 *
 * For this server's own admins, like /api/logs: the home frontend's Logs page
 * and admin dashboard read it through /api/authenticated/admin/alerts, which
 * forwards the admin's session. 503 until the alert manager has started.
 */

import express from 'express';
import { authenticateUser, requireAdmin } from '../middleware/auth.mjs';
import { createCategoryLogger } from '../lib/logger.mjs';
import { getLogAlerts } from '../lib/alerts/index.mjs';

const logger = createCategoryLogger('alerts-route');

/** @param {{ getAlerts?: () => { list(): Promise<object> } | null }} [options] the manager (tests pass their own) */
export function setupAlertsRoutes({ getAlerts = getLogAlerts } = {}) {
  const router = express.Router();

  router.get('/alerts', authenticateUser, requireAdmin, async (req, res) => {
    const alerts = getAlerts();
    if (!alerts) return res.status(503).json({ error: 'Log alerts are still starting' });
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await alerts.list());
    } catch (error) {
      logger.error('Listing log alerts failed', error);
      res.status(500).json({ error: 'Failed to list log alerts' });
    }
  });

  return router;
}
