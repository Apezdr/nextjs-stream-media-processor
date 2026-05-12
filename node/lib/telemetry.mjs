/**
 * OpenTelemetry initialization module
 * IMPORTANT: This module must be imported before any other imports in app.mjs
 * 
 * This configures OpenTelemetry SDK with:
 * - OTLP exporter for SigNoz collector
 * - Auto-instrumentation for Express, HTTP, MongoDB, etc.
 * - Custom resource attributes
 * - Graceful shutdown handling
 */

import process from 'node:process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

// OpenTelemetry imports
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter as OTLPTraceExporterGRPC } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter as OTLPMetricExporterGRPC } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter as OTLPTraceExporterHTTP } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter as OTLPMetricExporterHTTP } from '@opentelemetry/exporter-metrics-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { diag, DiagLogLevel, DiagConsoleLogger } from '@opentelemetry/api';
import { CompositePropagator, W3CTraceContextPropagator, W3CBaggagePropagator } from '@opentelemetry/core';

// Get package.json version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = resolve(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const serviceVersion = packageJson.version;

// Set OpenTelemetry logging level based on environment
const otelLogLevel = process.env.OTEL_LOG_LEVEL || 'info';
const logLevelMap = {
  'error': DiagLogLevel.ERROR,
  'warn': DiagLogLevel.WARN,
  'info': DiagLogLevel.INFO,
  'debug': DiagLogLevel.DEBUG,
  'verbose': DiagLogLevel.VERBOSE,
  'all': DiagLogLevel.ALL,
};

// Configure OpenTelemetry diagnostic logging
diag.setLogger(new DiagConsoleLogger(), logLevelMap[otelLogLevel] || DiagLogLevel.INFO);

// Check if OpenTelemetry is enabled
const isOtelEnabled = process.env.OTEL_ENABLED?.toLowerCase() === 'true';

// Early exit if OpenTelemetry is disabled
// Export variable to indicate if OpenTelemetry is enabled
export const isOpenTelemetryEnabled = isOtelEnabled;

// Define a variable for the SDK
let sdk = null;

// Early exit if OpenTelemetry is disabled
if (!isOtelEnabled) {
  diag.info('OpenTelemetry is disabled via OTEL_ENABLED environment variable');
} else {

diag.info('Initializing OpenTelemetry...');

// Extract service name from environment variable or use default
const serviceName = process.env.OTEL_SERVICE_NAME || 'media-processor';

// Configure the OTLP exporter endpoint from environment variables
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317';
const otlpProtocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.toLowerCase() || 'grpc';

diag.info(`OpenTelemetry configured with endpoint: ${otlpEndpoint} using ${otlpProtocol} protocol`);

// Configure propagators based on environment variables or use defaults
const propagatorsEnv = process.env.OTEL_PROPAGATORS || 'tracecontext,baggage';
const propagators = [];

if (propagatorsEnv.includes('tracecontext')) {
  propagators.push(new W3CTraceContextPropagator());
}

if (propagatorsEnv.includes('baggage')) {
  propagators.push(new W3CBaggagePropagator());
}

// Create a custom resource with service and deployment information
let resource = defaultResource().merge(
  resourceFromAttributes({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
    [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: `${serviceName}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
    'application.type': 'nodejs-media-processor',
  })
);

// Parse additional resource attributes from environment variable
if (process.env.OTEL_RESOURCE_ATTRIBUTES) {
  const customAttributes = {};
  process.env.OTEL_RESOURCE_ATTRIBUTES.split(',').forEach(attr => {
    const [key, value] = attr.split('=');
    if (key && value) {
      customAttributes[key.trim()] = value.trim();
    }
  });
  
  if (Object.keys(customAttributes).length > 0) {
    resource = resource.merge(resourceFromAttributes(customAttributes));
  }
}

// Create exporter based on configuration
// Check if protocol includes 'http' (handles 'http', 'http/protobuf', 'http/json')
const useHttp = otlpProtocol.includes('http') && !otlpProtocol.includes('grpc');

let traceExporter;
let metricExporter;

if (useHttp) {
  // HTTP exporters - endpoint should already include port 4318
  traceExporter = new OTLPTraceExporterHTTP({
    url: `${otlpEndpoint}/v1/traces`
  });
  metricExporter = new OTLPMetricExporterHTTP({
    url: `${otlpEndpoint}/v1/metrics`
  });
  diag.info(`Using HTTP exporters with endpoint: ${otlpEndpoint}`);
} else {
  // gRPC exporters - endpoint should use port 4317
  traceExporter = new OTLPTraceExporterGRPC({
    url: otlpEndpoint
  });
  metricExporter = new OTLPMetricExporterGRPC({
    url: otlpEndpoint
  });
  diag.info(`Using gRPC exporters with endpoint: ${otlpEndpoint}`);
}

// Configure the OpenTelemetry SDK with auto-instrumentation
const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Enable all auto-instrumentations with default settings
      '@opentelemetry/instrumentation-fs': { enabled: true },
      '@opentelemetry/instrumentation-http': { enabled: true },
      '@opentelemetry/instrumentation-express': { enabled: true },
      '@opentelemetry/instrumentation-mongodb': { enabled: true },
      '@opentelemetry/instrumentation-dns': { enabled: true },
    }),
  ],
  // Set propagators if configured
  textMapPropagator: propagators.length > 0 ? new CompositePropagator({ propagators }) : undefined,
});

// Start the SDK
sdk.start();

// Gracefully shut down the SDK on process exit
process.on('SIGTERM', () => {
  diag.info('SIGTERM signal received. Shutting down OpenTelemetry SDK...');
  sdk.shutdown()
    .then(() => {
      diag.info('OpenTelemetry SDK has been shutdown successfully');
      process.exit(0);
    })
    .catch((error) => {
      diag.error('Error shutting down OpenTelemetry SDK', error);
      process.exit(1);
    });
});

process.on('SIGINT', () => {
  diag.info('SIGINT signal received. Shutting down OpenTelemetry SDK...');
  sdk.shutdown()
    .then(() => {
      diag.info('OpenTelemetry SDK has been shutdown successfully');
      process.exit(0);
    })
    .catch((error) => {
      diag.error('Error shutting down OpenTelemetry SDK', error);
      process.exit(1);
    });
});

diag.info('OpenTelemetry initialization complete');
}

// Export the SDK and enabled status
export default {
  sdk,
  isEnabled: isOtelEnabled
};