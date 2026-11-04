/**
 * The alert intake's HTTP surface, mounted at /api/alert-intake by
 * routes/index.mjs (PLAN.md §3):
 *
 *   POST|PUT  /alertmanager     Alertmanager, SigNoz, Grafana
 *   POST      /gotify/message   Gotify clients (base URL …/gotify)
 *   POST|PUT  /ntfy             ntfy JSON publishing (base URL …/ntfy)
 *   POST|PUT  /ntfy/:topic      ntfy topic publishing
 *   POST      /generic          our own JSON
 *
 * Per request: route and method, the intake's state, the key (from headers
 * and query only: no body byte is read before it matches), the body with the
 * format's own parser and limit, the adapter, the relay, the reply in the
 * format's shape.
 *
 * Every request that reaches this router is answered here. Handlers catch
 * everything, a catch-all answers unknown paths under the prefix (the app's
 * 404 logger would log the URL), and the router's own error middleware
 * answers what Express raises inside it (a malformed %-escape in a param). So
 * nothing from this router reaches the app's error handlers, which log at
 * error level under categories the alert rules count. Middleware mounted
 * ahead of it on the app still can: CORS refuses a disallowed Origin by
 * raising an error there, on this path as on any other (a pre-existing
 * behaviour, PLAN.md §12).
 */

import express from 'express';
import { recordWebhookCaller } from '../../lib/requestCaller.mjs';
import { ADAPTERS } from './adapters/index.mjs';
import { reject } from './adapters/common.mjs';
import { readCredential } from './auth.mjs';
import { ALERT_INTAKE_PREFIX, KEYS_VARIABLE } from './config.mjs';
import { failureStatus } from './relay.mjs';
import { getAlertIntake } from './index.mjs';

const mediaType = (header) => (typeof header === 'string' ? header.split(';')[0].trim().toLowerCase() || null : null);

/** The adapter a path under the prefix belongs to, for the shape of an error; generic when none. */
function adapterOfPath(path) {
  const segment = String(path ?? '').split('/')[1]?.toLowerCase();
  return Object.hasOwn(ADAPTERS, segment ?? '') ? ADAPTERS[segment] : ADAPTERS.generic;
}

function send(res, { status, body }, headers = {}) {
  res.set({ 'Cache-Control': 'no-store', ...headers });
  res.status(status).json(body);
}

/** The body as a Buffer, through the format's raw parser: empty when there is none. */
function readBody(parser, req, res) {
  return new Promise((resolve, reject) => {
    parser(req, res, (error) => (error ? reject(error) : resolve(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0))));
  });
}

function failureReply(adapter, outcome) {
  const status = failureStatus(outcome);
  const reason =
    {
      breaker: 'relaying to Discord is paused after a failed send; retry shortly',
      pending: 'the relay to Discord is still in progress; retry shortly',
      'no-target': 'this server has no Discord channel to relay to',
      'not-ready': 'the Discord bot is not ready yet; retry shortly',
      rejected: 'Discord refused the relayed message',
      error: 'the relay to Discord failed',
      abandoned: 'the relay to Discord did not finish',
    }[outcome.reason] ?? 'the relay to Discord failed';
  return { reply: adapter.replyError(reject(status, outcome.reason, reason)), retryAfter: outcome.retryAfterSec };
}

/**
 * @param {object} [options]
 * @param {ReturnType<import('./index.mjs').createAlertIntake>} [options.intake] tests pass their own
 */
export function setupAlertIntakeRoutes({ intake = getAlertIntake() } = {}) {
  const router = express.Router();

  for (const adapter of Object.values(ADAPTERS)) {
    const parser = express.raw({ type: () => true, limit: adapter.bodyLimitBytes });
    for (const route of adapter.routes) {
      const template = `${ALERT_INTAKE_PREFIX}${route.path}`;
      router.all(route.path, async (req, res) => {
        try {
          if (!route.methods.includes(req.method)) {
            return send(res, adapter.replyError(reject(405, 'method', `use ${route.methods.join(' or ')}`)), { Allow: route.methods.join(', ') });
          }
          if (intake.state === 'off') {
            return send(res, adapter.replyError(reject(404, 'off', 'alert intake is not enabled on this server')));
          }
          if (intake.state !== 'on') {
            return send(res, adapter.replyError(reject(503, 'misconfigured', `alert intake is misconfigured (${KEYS_VARIABLE}); see the processor log`)));
          }

          const credential = readCredential({ headers: req.headers, query: req.query }, adapter.credentials);
          const entry = credential?.key ? intake.matchKey(credential.key) : null;
          if (!entry) {
            intake.refused({ reason: !credential ? 'no key' : credential.key ? 'wrong key' : 'malformed key', method: req.method, route: template, address: req.socket?.remoteAddress });
            return send(res, adapter.replyError(reject(401, 'unauthorized', 'a valid alert intake key is required')), {
              Connection: 'close',
              'WWW-Authenticate': 'Bearer realm="alert-intake"',
            });
          }
          recordWebhookCaller(credential.key, `${KEYS_VARIABLE}:${entry.source}`);

          let body;
          try {
            body = await readBody(parser, req, res);
          } catch (error) {
            if (error?.type === 'entity.too.large') {
              intake.rejected({ source: entry.source, format: adapter.name, code: 'too-large' });
              return send(res, adapter.replyError(reject(413, 'too-large', `the body is larger than ${adapter.bodyLimitBytes} bytes`)), { Connection: 'close' });
            }
            if (error?.type === 'encoding.unsupported' || error?.type === 'charset.unsupported') {
              return send(res, adapter.replyError(reject(415, 'encoding', 'unsupported content encoding')));
            }
            return send(res, adapter.replyError(reject(400, 'unreadable', 'the body could not be read')), { Connection: 'close' });
          }

          const now = intake.now();
          const parsed = adapter.parse({
            method: req.method,
            route: route.route,
            params: req.params ?? {},
            query: req.query ?? {},
            headers: req.headers,
            body,
            contentType: mediaType(req.headers['content-type']),
            receivedAt: now,
          });
          if (!parsed.ok) {
            intake.rejected({ source: entry.source, format: adapter.name, code: parsed.code });
            return send(res, adapter.replyError(parsed));
          }

          const outcome = await intake.relay.deliver(parsed.alerts, { source: entry.source, format: adapter.name, truncated: parsed.context.truncated ?? 0 });
          if (outcome.accepted) {
            return send(res, adapter.reply(outcome, parsed.context, { sourceIndex: entry.sourceIndex, nextId: intake.nextId, now: intake.now }), {
              'X-Alert-Intake-Outcome': outcome.outcome,
            });
          }
          const { reply, retryAfter } = failureReply(adapter, outcome);
          return send(res, reply, retryAfter ? { 'Retry-After': String(retryAfter) } : {});
        } catch (error) {
          intake.failed(error);
          if (!res.headersSent) send(res, adapter.replyError(reject(500, 'internal', 'the alert intake failed on this request')));
        }
      });
    }
  }

  // Unknown paths under the prefix: answered here, so the app's 404 handler
  // never logs their URLs (a query can hold a key).
  router.use((req, res) => {
    send(res, adapterOfPath(req.path).replyError(reject(404, 'not-found', 'no such alert intake endpoint')));
  });

  // What Express raises before a handler runs, such as a malformed %-escape
  // in a path parameter. Answered here, never passed on.
  router.use((error, req, res, next) => {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) intake.failed(error);
    if (res.headersSent) return;
    const reason = status === 400 ? 'the request URL could not be decoded' : 'the alert intake failed on this request';
    send(res, adapterOfPath(req.path).replyError(reject(status, status === 400 ? 'bad-url' : 'internal', reason)));
  });

  return router;
}
