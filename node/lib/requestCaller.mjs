/**
 * Who made a request, recorded on the request's span so a trace can be tied to
 * a user or a key. A key is never recorded, only which setting matched it and
 * its fingerprint, so a span can't be replayed as a credential. The frontend
 * records the same attributes on its own spans (src/lib/requestCaller.ts):
 *
 *   nextjs_stream.caller.type         'user' or 'webhook'
 *   user.id                           the signed-in user's id (never the email)
 *   nextjs_stream.caller.credential   the setting that matched (WEBHOOK_ID_2)
 *   nextjs_stream.caller.fingerprint  sha256: and 8 hex digits, as the logs show it
 *
 * They go on the HTTP server span, the one that carries http.route, not on
 * whichever router span is active while a middleware runs. With OpenTelemetry
 * off there is no span and nothing is recorded.
 */

import { context, trace } from '@opentelemetry/api';
import { getRPCMetadata } from '@opentelemetry/core';
import { webhookIdFingerprint } from './webhookIdRedaction.mjs';

/** The request's HTTP server span, else the active span; undefined outside a traced request. */
export function requestSpan() {
  const active = context.active();
  return getRPCMetadata(active)?.span ?? trace.getSpan(active);
}

export function recordUserCaller(userId) {
  if (!userId) return;
  requestSpan()?.setAttributes({ 'nextjs_stream.caller.type': 'user', 'user.id': String(userId) });
}

export function recordWebhookCaller(webhookId, credential) {
  requestSpan()?.setAttributes({
    'nextjs_stream.caller.type': 'webhook',
    'nextjs_stream.caller.credential': credential,
    'nextjs_stream.caller.fingerprint': webhookIdFingerprint(webhookId),
  });
}
