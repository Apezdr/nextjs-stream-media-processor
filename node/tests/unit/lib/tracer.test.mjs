/**
 * Contract tests for withSpan() in node/lib/tracer.mjs.
 *
 * Pins the one property that once shipped broken: the callback RECEIVES the
 * span as its argument. workerTracer.mjs's withWorkerSpan() calls
 * span.setAttributes() on it as its first action — when withSpan invoked the
 * callback with no arguments, every worker-pool task threw
 * "Cannot read properties of undefined (reading 'setAttributes')" before the
 * pool was ever reached, and all blurhash work silently fell back to the main
 * thread.
 */
import { jest } from '@jest/globals';
import { withSpan } from '../../../lib/tracer.mjs';

function makeFakeSpan() {
  return {
    setAttribute: jest.fn(),
    setAttributes: jest.fn(),
    setStatus: jest.fn(),
    recordException: jest.fn(),
    end: jest.fn(),
  };
}

function makeFakeTracer(span) {
  return { startSpan: jest.fn(() => span) };
}

describe('withSpan', () => {
  test('passes the started span to the callback', async () => {
    const span = makeFakeSpan();
    const tracer = makeFakeTracer(span);

    let received;
    await withSpan(tracer, 'test.op', async (s) => {
      received = s;
      return 'ok';
    });

    expect(received).toBe(span);
  });

  test('callback can set attributes on the received span (the workerTracer usage)', async () => {
    const span = makeFakeSpan();
    const tracer = makeFakeTracer(span);

    const result = await withSpan(tracer, 'worker.task', async (s) => {
      s.setAttributes({ 'worker.type': 'blurhash' });
      s.setAttribute('worker.state', 'completed');
      return 42;
    });

    expect(result).toBe(42);
    expect(span.setAttributes).toHaveBeenCalledWith({ 'worker.type': 'blurhash' });
    expect(span.setAttribute).toHaveBeenCalledWith('worker.state', 'completed');
    expect(span.end).toHaveBeenCalled();
  });

  test('zero-argument callbacks still work unchanged', async () => {
    const span = makeFakeSpan();
    const tracer = makeFakeTracer(span);

    const result = await withSpan(tracer, 'test.op', async () => 'plain');

    expect(result).toBe('plain');
    expect(span.end).toHaveBeenCalled();
  });

  test('errors are recorded on the span and rethrown, and the span still ends', async () => {
    const span = makeFakeSpan();
    const tracer = makeFakeTracer(span);
    const boom = new Error('boom');

    await expect(withSpan(tracer, 'test.op', async () => { throw boom; })).rejects.toBe(boom);
    expect(span.recordException).toHaveBeenCalledWith(boom);
    expect(span.end).toHaveBeenCalled();
  });
});
