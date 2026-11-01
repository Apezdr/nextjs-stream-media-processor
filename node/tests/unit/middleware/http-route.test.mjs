/**
 * middleware/telemetryMiddleware.mjs httpRouteMiddleware: hands the matched
 * Express route to the HTTP instrumentation through the request's RPC
 * metadata, which names the server span and labels
 * http.server.request.duration with http.route.
 *
 * Tests run with OpenTelemetry off, so the flag is mocked on; a context
 * manager carries the metadata into the middleware the way the SDK does.
 */

import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';

jest.unstable_mockModule('../../../lib/telemetry.mjs', () => ({ isOpenTelemetryEnabled: true }));

const { context, trace, ROOT_CONTEXT, SpanStatusCode } = await import('@opentelemetry/api');
const { AsyncLocalStorageContextManager } = await import('@opentelemetry/context-async-hooks');
const { RPCType, setRPCMetadata } = await import('@opentelemetry/core');
const { httpRouteMiddleware, telemetryErrorMiddleware } = await import('../../../middleware/telemetryMiddleware.mjs');

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterAll(() => {
  context.disable();
});

/** Runs a request through the middleware, then ends the response, and returns the metadata. */
function handle(req, rpcType = RPCType.HTTP) {
  const rpcMetadata = { type: rpcType };
  const end = jest.fn();
  const res = { end };
  const next = jest.fn();
  context.with(setRPCMetadata(ROOT_CONTEXT, rpcMetadata), () => httpRouteMiddleware()(req, res, next));
  // The router matches after the middleware ran; the response ends later still
  if (req.matched) req.route = { path: req.matched };
  res.end('body');
  return { rpcMetadata, end, next };
}

describe('httpRouteMiddleware', () => {
  it('reports the matched route, mount path included', () => {
    const { rpcMetadata, end, next } = handle({ baseUrl: '/api/tmdb', matched: '/comprehensive/:type' });

    expect(rpcMetadata.route).toBe('/api/tmdb/comprehensive/:type');
    expect(end).toHaveBeenCalledWith('body');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('reports an app-level route as it is', () => {
    const { rpcMetadata } = handle({ baseUrl: '', matched: '/frame/movie/:movieName/:timestamp{.:ext}' });

    expect(rpcMetadata.route).toBe('/frame/movie/:movieName/:timestamp{.:ext}');
  });

  it('reports no route when nothing matched (a 404 keeps the method alone)', () => {
    const { rpcMetadata, end } = handle({ baseUrl: '' });

    expect(rpcMetadata.route).toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('leaves a request without HTTP metadata alone', () => {
    const { rpcMetadata } = handle({ baseUrl: '', matched: '/x' }, 'other');

    expect(rpcMetadata.route).toBeUndefined();
  });
});

describe('telemetryErrorMiddleware', () => {
  // spanContext: lib/logger.mjs stamps each line with the active span's ids
  const fakeSpan = () => ({
    recordException: jest.fn(),
    setStatus: jest.fn(),
    setAttribute: jest.fn(),
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
  });

  function handleError(err) {
    const serverSpan = fakeSpan();
    const routerSpan = fakeSpan();
    const ctx = setRPCMetadata(trace.setSpan(ROOT_CONTEXT, routerSpan), { type: RPCType.HTTP, span: serverSpan });
    const next = jest.fn();
    context.with(ctx, () => telemetryErrorMiddleware()(err, { path: '/x', method: 'GET' }, {}, next));
    return { serverSpan, routerSpan, next };
  }

  it('records the error on the HTTP server span, not the error handler\'s router span', () => {
    const err = new TypeError('boom');
    const { serverSpan, routerSpan, next } = handleError(err);

    expect(serverSpan.recordException).toHaveBeenCalledWith(err);
    expect(serverSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'boom' });
    expect(routerSpan.recordException).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });

  it('leaves the status unset for an error that answers with a 4xx', () => {
    // As decodeParam raises it for a malformed escape in a route parameter
    const err = Object.assign(new URIError("Failed to decode param '%E0%A4%A'"), { status: 400 });
    const { serverSpan, next } = handleError(err);

    expect(serverSpan.recordException).toHaveBeenCalledWith(err);
    expect(serverSpan.setStatus).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });
});
