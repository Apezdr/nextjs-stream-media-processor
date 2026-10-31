/**
 * lib/telemetry.mjs: the OpenTelemetry setup, and how app.mjs wires it.
 *
 * Tests run without OTEL_ENABLED, so importing the module starts no SDK; the
 * helpers it builds the SDK from are tested directly. app.mjs cannot be loaded
 * in a test, so its wiring is read off the source, as
 * app-request-body-wiring.test.mjs does.
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OTLPTraceExporter as OTLPTraceExporterGrpc } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OTLPTraceExporterJson } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPTraceExporterProto } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  buildResourceAttributes,
  isOpenTelemetryEnabled,
  shutdownTelemetry,
  signozDbKeysProcessor,
  traceExporterFromEnv,
} from '../../../lib/telemetry.mjs';

const NODE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const APP_SOURCE = readFileSync(join(NODE_DIR, 'app.mjs'), 'utf8');
const TELEMETRY_SOURCE = readFileSync(join(NODE_DIR, 'lib', 'telemetry.mjs'), 'utf8');
const PACKAGE_VERSION = JSON.parse(readFileSync(join(NODE_DIR, 'package.json'), 'utf8')).version;

const savedEnv = { APP_VERSION: process.env.APP_VERSION, GIT_COMMIT: process.env.GIT_COMMIT };

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('traceExporterFromEnv', () => {
  const cases = [
    [{}, OTLPTraceExporterProto],
    [{ OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf' }, OTLPTraceExporterProto],
    [{ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }, OTLPTraceExporterGrpc],
    [{ OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }, OTLPTraceExporterJson],
    // The signal-specific variable wins over the general one, as in the SDK
    [{ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc', OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json' }, OTLPTraceExporterJson],
  ];

  it.each(cases)('picks the exporter for %j', async (env, expected) => {
    const exporter = traceExporterFromEnv(env);
    expect(exporter).toBeInstanceOf(expected);
    await exporter.shutdown();
  });

  it('refuses a protocol it cannot build', () => {
    expect(() => traceExporterFromEnv({ OTEL_EXPORTER_OTLP_PROTOCOL: 'thrift' })).toThrow('unsupported protocol "thrift"');
  });
});

describe('signozDbKeysProcessor', () => {
  function start(attributes) {
    const span = { attributes: { ...attributes }, setAttribute: (key, value) => { span.set.push([key, value]); }, set: [] };
    signozDbKeysProcessor.onStart(span);
    return span.set;
  }

  it('copies the stable database attributes to the keys SigNoz reads', () => {
    expect(start({
      'db.system.name': 'mongodb',
      'db.namespace': 'Media',
      'db.operation.name': 'find',
    })).toEqual([
      ['db.system', 'mongodb'],
      ['db.name', 'Media'],
      ['db.operation', 'find'],
    ]);
  });

  it('leaves spans that are not database calls alone', () => {
    expect(start({ 'http.request.method': 'GET', 'db.namespace': 'not-a-db-span' })).toEqual([]);
  });

  it('keeps a deprecated key a span already carries', () => {
    expect(start({ 'db.system.name': 'mongodb', 'db.system': 'mongodb', 'db.namespace': 'Media' })).toEqual([['db.name', 'Media']]);
  });
});

describe('buildResourceAttributes', () => {
  it('reports the image build as service.version and vcs.ref.head.revision', () => {
    process.env.APP_VERSION = '2026.10.31-2-vulkan';
    process.env.GIT_COMMIT = '8c94b90126813fa7d6467eea274d09cca91fbced';

    const attributes = buildResourceAttributes();

    expect(attributes['service.version']).toBe('2026.10.31-2-vulkan');
    expect(attributes['vcs.ref.head.revision']).toBe('8c94b90126813fa7d6467eea274d09cca91fbced');
  });

  it('falls back to the package.json version outside an image', () => {
    delete process.env.APP_VERSION;
    delete process.env.GIT_COMMIT;

    const attributes = buildResourceAttributes();

    expect(attributes['service.version']).toBe(PACKAGE_VERSION);
    expect(attributes).not.toHaveProperty('vcs.ref.head.revision');
  });
});

describe('shutdown wiring', () => {
  it('has nothing to flush when telemetry is off', async () => {
    expect(isOpenTelemetryEnabled).toBe(false);
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('is imported first by app.mjs, before anything it instruments', () => {
    const firstImport = APP_SOURCE.match(/^import .*$/m)[0];
    expect(firstImport).toBe("import { shutdownTelemetry } from './lib/telemetry.mjs';");
  });

  it('flushes last in gracefulShutdown, just before process.exit', () => {
    const body = APP_SOURCE.slice(APP_SOURCE.indexOf('async function gracefulShutdown'));
    const shutdown = body.slice(0, body.indexOf('\n}\n'));
    expect(shutdown).toMatch(/await shutdownTelemetry\(\);\s+process\.exit\(code\);\s*$/);
  });

  it('registers no signal handlers of its own (gracefulShutdown owns the exit)', () => {
    expect(TELEMETRY_SOURCE).not.toMatch(/process\.(on|once)\(\s*['"]SIG/);
    expect(TELEMETRY_SOURCE).not.toMatch(/process\.exit\(/);
  });
});
