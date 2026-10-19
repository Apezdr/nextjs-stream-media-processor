import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { trace, context } from '@opentelemetry/api';
import { isOpenTelemetryEnabled } from './telemetry.mjs';
import path from 'path';
import fs from 'fs';

// Ensure base log directory exists. `recursive: true` makes this idempotent so
// concurrent importers (e.g. parallel Jest workers) can't race an existsSync
// check and lose with EEXIST. GET /api/logs (routes/logs.mjs) reads the
// application-%DATE%.log files written here; lib/logReader.mjs depends on
// that name and on the date pattern below.
export const LOG_DIRECTORY = path.resolve('logs');
fs.mkdirSync(LOG_DIRECTORY, { recursive: true });

const isProduction = process.env.NODE_ENV === 'production';

// Custom format to add trace context to logs
const traceContextFormat = format((info) => {
  // Only add trace context if OpenTelemetry is enabled
  if (isOpenTelemetryEnabled) {
    const span = trace.getSpan(context.active());
    if (span) {
      const spanContext = span.spanContext();
      info.trace_id = spanContext.traceId;
      info.span_id = spanContext.spanId;
      info.trace_flags = spanContext.traceFlags;
    }
  }
  return info;
});

// Base Winston logger configuration
const baseLogger = createLogger({
  level: isProduction ? 'info' : 'debug',
  format: format.combine(
    traceContextFormat(),
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: isProduction
        ? format.combine(format.timestamp(), format.json())
        : format.combine(format.colorize(), format.simple()),
      level: isProduction ? 'info' : 'debug',
    }),
    new DailyRotateFile({
      filename: path.join(LOG_DIRECTORY, 'application-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '4m',
      maxFiles: '14d',
    }),
    new transports.File({ filename: path.join(LOG_DIRECTORY, 'error.log'), level: 'error' }),
  ],
  exceptionHandlers: [
    new transports.File({ filename: path.join(LOG_DIRECTORY, 'exceptions.log') })
  ]
});

// In-memory store for categories
const categories = new Set();

/**
 * Returns all registered categories
 */
export function getCategories() {
  return Array.from(categories);
}

/**
 * Turn a log call's second argument into record fields. Spreading it raw lost
 * an Error's message and stack (not enumerable) and split a string into one
 * field per character ("0": "R", "1": "e", …) in SigNoz.
 */
export function normalizeLogMeta(meta) {
  if (meta instanceof Error) {
    const status = meta.status ?? meta.response?.status;
    return {
      error: meta.message,
      stack: meta.stack,
      ...(status != null ? { status } : {}),
    };
  }
  if (meta === null || meta === undefined) return {};
  if (typeof meta !== 'object' || Array.isArray(meta)) return { detail: meta };
  return meta;
}

/**
 * Create a category-specific logger that tags each message with `category`.
 * Every category goes to the same transports. (A python-%DATE%.log transport
 * used to sit on the base logger too, so it got a full second copy of every
 * line, not just the Python ones.)
 */
function makeLogger(category) {
  categories.add(category);
  return {
    info:  (message, meta) => baseLogger.info(message,  { ...normalizeLogMeta(meta), category }),
    warn:  (message, meta) => baseLogger.warn(message,  { ...normalizeLogMeta(meta), category }),
    error: (message, meta) => baseLogger.error(message, { ...normalizeLogMeta(meta), category }),
    debug: (message, meta) => baseLogger.debug(message, { ...normalizeLogMeta(meta), category }),
  };
}

/**
 * General category logger
 */
export function createCategoryLogger(category) {
  return makeLogger(category);
}

/**
 * Python script logger (prefixes category with "python:")
 */
export function createPythonLogger(category) {
  return makeLogger(`python:${category}`);
}

export default baseLogger;
