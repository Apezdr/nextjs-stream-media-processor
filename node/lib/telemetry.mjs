/**
 * OpenTelemetry initialization module
 * IMPORTANT: This module must be imported before any other imports in app.mjs,
 * so the instrumentations patch modules before anything loads them.
 *
 * Off unless OTEL_ENABLED=true. Configured by the standard variables:
 * OTEL_EXPORTER_OTLP_ENDPOINT / _PROTOCOL / _HEADERS, OTEL_SERVICE_NAME,
 * OTEL_RESOURCE_ATTRIBUTES, OTEL_PROPAGATORS, OTEL_TRACES_SAMPLER,
 * OTEL_METRIC_EXPORT_INTERVAL and OTEL_LOG_LEVEL (the SDK's own diagnostics).
 *
 * Traces and metrics go over OTLP. Logs don't: the collector reads the
 * container's JSON log lines, which lib/logger.mjs stamps with trace_id and
 * span_id, and the alert rules count those lines.
 *
 * app.mjs's gracefulShutdown calls shutdownTelemetry() last, so the spans and
 * metrics of a stop or a crash still reach the collector.
 */

import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter as OTLPTraceExporterGrpc } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as OTLPTraceExporterJson } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPTraceExporterProto } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export const isOpenTelemetryEnabled = process.env.OTEL_ENABLED?.toLowerCase() === 'true';

// Which build is running: build.ps1 / build.sh bake the image's Docker Hub tag
// and its commit in as APP_VERSION and GIT_COMMIT (Dockerfile ARGs). Outside an
// image (local development) the package.json version stands in.
function serviceVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const packageJson = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(packageJson, 'utf8')).version;
}

// The service's own resource. OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
// (service.namespace, deployment.environment) are merged over it by the SDK's
// env detector, along with its process and host detectors.
export function buildResourceAttributes() {
  const attributes = {
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'media-processor',
    [ATTR_SERVICE_VERSION]: serviceVersion(),
    'service.instance.id': randomUUID(),
    'deployment.environment': process.env.NODE_ENV || 'development',
    'application.type': 'nodejs-media-processor',
  };
  if (process.env.GIT_COMMIT) attributes['vcs.ref.head.revision'] = process.env.GIT_COMMIT;
  return attributes;
}

// The trace exporter the SDK would build from the environment: passing span
// processors (for the SigNoz keys below) makes it skip building its own. Each
// exporter reads OTEL_EXPORTER_OTLP_ENDPOINT and _HEADERS itself.
export function traceExporterFromEnv(env = process.env) {
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL || env.OTEL_EXPORTER_OTLP_PROTOCOL || 'http/protobuf').trim();
  switch (protocol) {
    case 'grpc':
      return new OTLPTraceExporterGrpc();
    case 'http/protobuf':
      return new OTLPTraceExporterProto();
    case 'http/json':
      return new OTLPTraceExporterJson();
    default:
      throw new Error(`OTEL_EXPORTER_OTLP_PROTOCOL: unsupported protocol "${protocol}" (use grpc, http/protobuf or http/json)`);
  }
}

// instrumentation-mongodb emits only the stable database conventions
// (db.system.name, db.namespace, db.operation.name), but SigNoz still reads the
// deprecated keys: its span metrics count a database call only when the span
// has db.system (the service's Database Calls tab), and its trace index fills
// the DB system, name and operation columns from db.system, db.name and
// db.operation. This copies each stable value to its old key as the span starts.
// Remove it once SigNoz reads db.system.name. (The same bridge runs in the
// nextjs-stream app, src/instrumentation.ts.)
const DEPRECATED_DB_KEYS = [
  ['db.system.name', 'db.system'],
  ['db.namespace', 'db.name'],
  ['db.operation.name', 'db.operation'],
];

export const signozDbKeysProcessor = {
  onStart(span) {
    const { attributes } = span;
    if (attributes['db.system.name'] === undefined) return;
    for (const [stable, deprecated] of DEPRECATED_DB_KEYS) {
      const value = attributes[stable];
      if (value !== undefined && attributes[deprecated] === undefined) span.setAttribute(deprecated, value);
    }
  },
  onEnd() {},
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

let sdk = null;

if (isOpenTelemetryEnabled) {
  sdk = new NodeSDK({
    resource: resourceFromAttributes(buildResourceAttributes()),
    spanProcessors: [signozDbKeysProcessor, new BatchSpanProcessor({ exporter: traceExporterFromEnv() })],
    instrumentations: [
      getNodeAutoInstrumentations({
        // Off, as upstream ships it: on, it made ~54M spans a day (48M of them
        // `fs stat` from the media scans), ~99% of everything this service sent
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: true },
        // lib/logger.mjs adds trace_id/span_id to each line itself, and logs reach
        // SigNoz from the container log, not through the OTel logs API
        '@opentelemetry/instrumentation-winston': { enabled: false },
      }),
    ],
  });
  sdk.start();
}

/**
 * Flush and stop the SDK. gracefulShutdown (app.mjs) calls it last, after the
 * server and connections close, so their spans are exported too. Capped so an
 * unreachable collector can't hold up the stop.
 */
export async function shutdownTelemetry(timeoutMs = 3000) {
  if (!sdk) return;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  // A failed flush is reported; it must not stop the process from exiting
  const flushed = sdk.shutdown().catch((error) => {
    console.warn(`OpenTelemetry shutdown failed: ${error?.message || error}`);
  });
  try {
    await Promise.race([flushed, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
