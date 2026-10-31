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

const { context, ROOT_CONTEXT } = await import('@opentelemetry/api');
const { AsyncLocalStorageContextManager } = await import('@opentelemetry/context-async-hooks');
const { RPCType, setRPCMetadata } = await import('@opentelemetry/core');
const { httpRouteMiddleware } = await import('../../../middleware/telemetryMiddleware.mjs');

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
