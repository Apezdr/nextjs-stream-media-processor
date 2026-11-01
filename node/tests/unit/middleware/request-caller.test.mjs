/**
 * lib/requestCaller.mjs, through the auth middleware: who made a request goes
 * on the request's HTTP server span, a user by id and a webhook by the setting
 * it matched and its fingerprint. A key's value never reaches a span, even
 * while LOG_UNREDACTED_WEBHOOK_IDS writes keys into the logs.
 *
 * A context manager carries the HTTP instrumentation's RPC metadata (which
 * holds the server span) and an active router span into the middleware.
 */

import { jest, describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { createHash } from 'crypto';

const FIRST = 'whk-first-0123456789';
const SECOND = 'whk-second-abcdefghij';
const THIRD = 'whk-third-klmnopqrst';
process.env.WEBHOOK_ID_1 = FIRST;
process.env.WEBHOOK_ID_2 = `${SECOND}, ${THIRD}`;

const mockGetSession = jest.fn();
jest.unstable_mockModule('../../../middleware/sessionCache.mjs', () => ({
  sessionManager: { getSession: (...args) => mockGetSession(...args) },
}));

const { context, trace, ROOT_CONTEXT } = await import('@opentelemetry/api');
const { AsyncLocalStorageContextManager } = await import('@opentelemetry/context-async-hooks');
const { RPCType, setRPCMetadata } = await import('@opentelemetry/core');
const { authenticateUser, authenticateWebhookOrUser, requireWebhookOrAdmin } = await import('../../../middleware/auth.mjs');
const { matchWebhookId } = await import('../../../middleware/webhookAuth.mjs');
const { recordUserCaller, recordWebhookCaller } = await import('../../../lib/requestCaller.mjs');

const fingerprint = (value) => `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterAll(() => {
  context.disable();
});

afterEach(() => {
  mockGetSession.mockReset();
  delete process.env.LOG_UNREDACTED_WEBHOOK_IDS;
});

/**
 * Runs a middleware inside a request's context: a server span in the RPC
 * metadata (unless rpc is false) and a router span active, as Express 5 runs it.
 */
async function inRequest(middleware, req, { rpc = true } = {}) {
  const serverSpan = { setAttributes: jest.fn() };
  const routerSpan = { setAttributes: jest.fn() };
  let ctx = trace.setSpan(ROOT_CONTEXT, routerSpan);
  if (rpc) ctx = setRPCMetadata(ctx, { type: RPCType.HTTP, span: serverSpan });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await context.with(ctx, () => middleware({ method: 'GET', url: '/api/x', socket: {}, ...req }, res, next));
  return { serverSpan, routerSpan, res, next };
}

/** Every attribute value set on the spans, as one string. */
const recorded = (...spans) => JSON.stringify(spans.map((span) => span.setAttributes.mock.calls));

describe('matchWebhookId', () => {
  it('names the setting a webhook ID is configured in, comma-separated ones included', () => {
    expect(matchWebhookId(FIRST)).toBe('WEBHOOK_ID_1');
    expect(matchWebhookId(THIRD)).toBe('WEBHOOK_ID_2');
  });

  it('is null for an unknown or missing ID', () => {
    expect(matchWebhookId('whk-not-configured')).toBeNull();
    expect(matchWebhookId(undefined)).toBeNull();
    expect(matchWebhookId('')).toBeNull();
  });
});

describe('a webhook caller', () => {
  it('is recorded on the server span by setting and fingerprint, never the ID', async () => {
    const { serverSpan, routerSpan, next } = await inRequest(authenticateWebhookOrUser, {
      headers: { 'x-webhook-id': THIRD },
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(serverSpan.setAttributes).toHaveBeenCalledWith({
      'nextjs_stream.caller.type': 'webhook',
      'nextjs_stream.caller.credential': 'WEBHOOK_ID_2',
      'nextjs_stream.caller.fingerprint': fingerprint(THIRD),
    });
    expect(routerSpan.setAttributes).not.toHaveBeenCalled();
    expect(recorded(serverSpan)).not.toContain(THIRD);
  });

  it('is fingerprinted even while the logs show webhook IDs in full', async () => {
    process.env.LOG_UNREDACTED_WEBHOOK_IDS = 'true';

    const { serverSpan } = await inRequest(authenticateWebhookOrUser, { headers: { 'x-webhook-id': FIRST } });

    expect(serverSpan.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ 'nextjs_stream.caller.fingerprint': fingerprint(FIRST) })
    );
    expect(recorded(serverSpan)).not.toContain(FIRST);
  });

  it('is recorded by requireWebhookOrAdmin too', async () => {
    const { serverSpan, next } = await inRequest(requireWebhookOrAdmin, { headers: { 'x-webhook-id': FIRST } });

    expect(next).toHaveBeenCalledTimes(1);
    expect(serverSpan.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ 'nextjs_stream.caller.credential': 'WEBHOOK_ID_1' })
    );
  });

  it('records nothing for an ID that is not configured', async () => {
    const { serverSpan, routerSpan, res } = await inRequest(authenticateWebhookOrUser, {
      headers: { 'x-webhook-id': 'whk-not-configured' },
    });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(serverSpan.setAttributes).not.toHaveBeenCalled();
    expect(routerSpan.setAttributes).not.toHaveBeenCalled();
  });
});

describe('a user caller', () => {
  const user = { id: '6578feca7317f7b672cebb5e', email: 'viewer@example.com', approved: true, admin: false };

  it('is recorded by id, never the email or the session token', async () => {
    mockGetSession.mockResolvedValue(user);

    const { serverSpan, next } = await inRequest(authenticateUser, {
      headers: { authorization: 'Bearer session-token-value' },
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(serverSpan.setAttributes).toHaveBeenCalledWith({
      'nextjs_stream.caller.type': 'user',
      'user.id': '6578feca7317f7b672cebb5e',
    });
    expect(recorded(serverSpan)).not.toContain('viewer@example.com');
    expect(recorded(serverSpan)).not.toContain('session-token-value');
  });

  it('is recorded when an admin session passes the webhook-or-admin check', async () => {
    mockGetSession.mockResolvedValue({ ...user, admin: true });

    const { serverSpan, next } = await inRequest(authenticateWebhookOrUser, {
      headers: { authorization: 'Bearer session-token-value' },
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(serverSpan.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ 'user.id': '6578feca7317f7b672cebb5e' })
    );
  });

  it('is recorded when the session is refused, so the refusal names its caller', async () => {
    mockGetSession.mockResolvedValue({ ...user, approved: false });

    const { serverSpan, res, next } = await inRequest(authenticateUser, {
      headers: { authorization: 'Bearer session-token-value' },
    });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(serverSpan.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ 'user.id': '6578feca7317f7b672cebb5e' })
    );
  });

  it('is recorded when a non-admin is refused by the webhook-or-admin check', async () => {
    mockGetSession.mockResolvedValue(user);

    const { serverSpan, res } = await inRequest(authenticateWebhookOrUser, {
      headers: { authorization: 'Bearer session-token-value' },
    });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(serverSpan.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ 'user.id': '6578feca7317f7b672cebb5e' })
    );
  });

  it('is not recorded for a token that resolves to no session', async () => {
    mockGetSession.mockResolvedValue(null);

    const { serverSpan, res } = await inRequest(authenticateUser, {
      headers: { authorization: 'Bearer session-token-value' },
    });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(serverSpan.setAttributes).not.toHaveBeenCalled();
  });
});

describe('where the attributes go', () => {
  it('falls back to the active span without HTTP metadata', async () => {
    const { routerSpan } = await inRequest(
      (_req, _res, next) => {
        recordUserCaller('u1');
        next();
      },
      { headers: {} },
      { rpc: false }
    );

    expect(routerSpan.setAttributes).toHaveBeenCalledWith({ 'nextjs_stream.caller.type': 'user', 'user.id': 'u1' });
  });

  it('does nothing outside a request (OpenTelemetry off)', () => {
    expect(() => recordUserCaller('u1')).not.toThrow();
    expect(() => recordWebhookCaller(FIRST, 'WEBHOOK_ID_1')).not.toThrow();
  });
});
