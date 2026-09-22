/**
 * HTTP surface for the identity service. Mounted under /api by app.mjs.
 *
 *   POST /api/identity/webhook/:provider   a provider's Webhook connection
 *   GET  /api/identity/status              providers, last index, recent events
 *   GET  /api/identity/report              the last full reconcile report
 *   POST /api/identity/reconcile           run a reconcile now (returns the report)
 *
 * Auth: every route accepts the processor's webhook id or an admin session
 * (`authenticateWebhookOrUser`). The webhook route additionally reads the id
 * from HTTP Basic credentials, because Radarr and Sonarr's Webhook connection
 * offers username/password fields but no custom headers: put the webhook id
 * in the password field (username is free text) and it authenticates like an
 * `X-Webhook-ID` header would.
 */

import express from 'express';
import { authenticateWebhookOrUser } from '../../middleware/auth.mjs';
import { createCategoryLogger } from '../../lib/logger.mjs';

const logger = createCategoryLogger('identity-routes');

/**
 * Lift a webhook id out of Basic credentials into the header the shared auth
 * middleware reads. Password wins; username is used only when password is empty.
 */
export function basicAuthToWebhookHeader(req, _res, next) {
  if (!req.headers['x-webhook-id']) {
    const auth = req.headers.authorization ?? '';
    if (/^basic\s+/i.test(auth)) {
      try {
        const decoded = Buffer.from(auth.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        const user = colon >= 0 ? decoded.slice(0, colon) : decoded;
        const pass = colon >= 0 ? decoded.slice(colon + 1) : '';
        const candidate = (pass || user).trim();
        if (candidate) req.headers['x-webhook-id'] = candidate;
      } catch {
        // malformed header — fall through to the normal auth failure
      }
    }
  }
  next();
}

/**
 * @param {ReturnType<import('./index.mjs').createIdentityService>} service
 * @param {Object} [options]
 * @param {Function} [options.authenticate] injectable auth middleware (tests)
 * @returns {express.Router}
 */
export function setupIdentityRoutes(service, { authenticate = authenticateWebhookOrUser } = {}) {
  const router = express.Router();

  router.post('/identity/webhook/:provider', basicAuthToWebhookHeader, authenticate, async (req, res) => {
    try {
      const result = await service.handleWebhook(req.params.provider, req.body, req.headers);
      if (!result.accepted) {
        logger.warn(`identity webhook rejected for '${req.params.provider}': ${result.error}`);
        return res.status(result.status).json({ error: result.error });
      }
      return res.status(200).json(result);
    } catch (error) {
      logger.error(`identity webhook failed: ${error.message}`);
      return res.status(500).json({ error: 'identity webhook failed' });
    }
  });

  router.get('/identity/status', authenticate, (_req, res) => {
    res.json(service.getStatus());
  });

  router.get('/identity/report', authenticate, (_req, res) => {
    const report = service.getLastReport();
    if (!service.enabled) return res.status(200).json({ enabled: false });
    if (!report) return res.status(202).json({ enabled: true, pending: true, message: 'no reconcile has run yet' });
    res.json(report);
  });

  router.post('/identity/reconcile', authenticate, async (_req, res) => {
    try {
      const report = await service.reconcileForTick({ reason: 'manual' });
      res.json(report);
    } catch (error) {
      logger.error(`manual identity reconcile failed: ${error.message}`);
      res.status(500).json({ error: 'reconcile failed' });
    }
  });

  return router;
}
