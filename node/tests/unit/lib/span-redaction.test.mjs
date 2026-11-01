/**
 * lib/spanRedaction.mjs: credentials sent in a URL never reach the trace
 * store. The HTTP instrumentation records every TMDB call's url.full with its
 * ?api_key=, so the processor rewrites URL attributes and span names as each
 * span starts.
 */

import { jest, describe, it, expect } from '@jest/globals';

const { credentialSpanProcessor, redactUrlCredentials } = await import('../../../lib/spanRedaction.mjs');

describe('redactUrlCredentials', () => {
  it("blanks a TMDB call's api_key and keeps the rest of the URL", () => {
    expect(redactUrlCredentials('https://api.themoviedb.org/3/movie/603?api_key=0123456789abcdef&language=en-US')).toBe(
      'https://api.themoviedb.org/3/movie/603?api_key=REDACTED&language=en-US'
    );
  });

  it('matches every spelling of a name, whatever its case', () => {
    for (const name of ['apiKey', 'APIKEY', 'api-key', 'Token', 'accessToken', 'webhook-id', 'X-Plex-Token', 'X-Amz-Signature']) {
      expect(redactUrlCredentials(`/x?page=2&${name}=s3cret`)).toBe(`/x?page=2&${name}=REDACTED`);
    }
  });

  it('leaves names that only contain a credential word alone', () => {
    for (const name of ['monkey', 'keyword', 'passkey', 'apikeys', 'tokens']) {
      expect(redactUrlCredentials(`/x?${name}=v`)).toBe(`/x?${name}=v`);
    }
  });

  it("redacts a URL's user:password and a Discord webhook's token", () => {
    expect(redactUrlCredentials('https://admin:hunter2@host.test/api')).toBe('https://REDACTED@host.test/api');
    expect(redactUrlCredentials('https://discord.com/api/webhooks/123456/AbC-dEf_123')).toBe(
      'https://discord.com/api/webhooks/123456/REDACTED'
    );
  });

  it('leaves URLs without credentials alone', () => {
    for (const text of ['/api/tmdb/comprehensive/movie?id=603', '/x?token=', 'GET', 'user@example.com']) {
      expect(redactUrlCredentials(text)).toBe(text);
    }
  });

  it('stays linear on URLs built to make a regex backtrack', () => {
    const size = 16_000;
    const hostile = [
      '/x' + '?'.repeat(size) + '&=',
      '/x?' + 'a'.repeat(size),
      '/x?' + ';'.repeat(size) + '=',
      'a.'.repeat(size / 2) + '://' + 'b'.repeat(size) + ':',
      '/api/webhooks/1/' + '-'.repeat(size),
    ];
    for (const text of hostile) {
      const started = process.hrtime.bigint();
      redactUrlCredentials(text);
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(20);
    }
  });
});

describe('credentialSpanProcessor', () => {
  function started(attributes, name = 'GET') {
    const span = { attributes: { ...attributes }, name, setAttribute: jest.fn(), updateName: jest.fn() };
    credentialSpanProcessor.onStart(span);
    return span;
  }

  it("rewrites a client span's url.full and a server span's url.query", () => {
    const client = started({ 'url.full': 'https://api.themoviedb.org/3/search/movie?api_key=k&query=x' });
    const server = started({ 'url.path': '/api/x', 'url.query': 'token=s3cret&page=1' });

    expect(client.setAttribute).toHaveBeenCalledWith('url.full', 'https://api.themoviedb.org/3/search/movie?api_key=REDACTED&query=x');
    expect(server.setAttribute).toHaveBeenCalledWith('url.query', 'token=REDACTED&page=1');
  });

  it('rewrites a span name that holds a URL', () => {
    const span = started({}, 'GET https://discord.com/api/webhooks/1/tok');

    expect(span.updateName).toHaveBeenCalledWith('GET https://discord.com/api/webhooks/1/REDACTED');
  });

  it('touches nothing on a span without credentials', () => {
    const span = started({ 'url.full': 'https://api.themoviedb.org/3/movie/603', 'db.system.name': 'mongodb' }, 'GET');

    expect(span.setAttribute).not.toHaveBeenCalled();
    expect(span.updateName).not.toHaveBeenCalled();
  });

  it('exports the redacted values from a real SDK span', async () => {
    const { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } = await import('@opentelemetry/sdk-trace');
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [credentialSpanProcessor, new SimpleSpanProcessor({ exporter })],
    });

    provider
      .getTracer('test')
      .startSpan('GET https://h.test/x?apikey=s3cret', {
        attributes: { 'url.full': 'https://api.themoviedb.org/3/movie/603?api_key=s3cret&language=en-US' },
      })
      .end();
    await provider.forceFlush();

    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('GET https://h.test/x?apikey=REDACTED');
    expect(span.attributes['url.full']).toBe('https://api.themoviedb.org/3/movie/603?api_key=REDACTED&language=en-US');
    await provider.shutdown();
  });
});
