import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

// Ensure base log directory exists
const logDirectory = path.resolve('logs');
if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory);
}

const isProduction = process.env.NODE_ENV === 'production';

// Base Winston logger configuration
const baseLogger = createLogger({
  level: isProduction ? 'info' : 'debug',
  format: format.combine(
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
      filename: path.join(logDirectory, 'application-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '4m',
      maxFiles: '14d',
    }),
    new transports.File({ filename: path.join(logDirectory, 'error.log'), level: 'error' }),
  ],
  exceptionHandlers: [
    new transports.File({ filename: path.join(logDirectory, 'exceptions.log') })
  ]
});

// Add a separate transport for Python script logs
const pythonTransport = new DailyRotateFile({
  filename: path.join(logDirectory, 'python-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '4m',
  maxFiles: '14d',
  level: isProduction ? 'info' : 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.json()
  )
});
baseLogger.add(pythonTransport);

// In-memory store for categories
const categories = new Set();

/**
 * Returns all registered categories
 */
export function getCategories() {
  return Array.from(categories);
}

/**
 * Create a category-specific logger that tags each message with `category`.
 * All logs go to the base transports; Python logs also get routed to python-%DATE%.log
 */
function makeLogger(category) {
  categories.add(category);
  return {
    info:  (message, meta = {}) => baseLogger.info(message,  { ...meta, category }),
    warn:  (message, meta = {}) => baseLogger.warn(message,  { ...meta, category }),
    error: (message, meta = {}) => baseLogger.error(message, { ...meta, category }),
    debug: (message, meta = {}) => baseLogger.debug(message, { ...meta, category }),
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
