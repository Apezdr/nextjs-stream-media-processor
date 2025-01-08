import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

const logDirectory = path.resolve('logs');
if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory);
}

const isProduction = process.env.NODE_ENV === 'production';

const logger = createLogger({
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
      maxSize: '4m', // Rotate files when they reach 4MB
      maxFiles: '14d' // Keep logs for 14 days
    }),
    new transports.File({ filename: path.join(logDirectory, 'error.log'), level: 'error' }),
  ],
  exceptionHandlers: [
    new transports.File({ filename: path.join(logDirectory, 'exceptions.log') })
  ]
});

// In-memory store for categories
const categories = new Set();

// Helper to get all categories (to be used in API)
export function getCategories() {
  return Array.from(categories);
}

export function createCategoryLogger(category) {
  // Save the category when createCategoryLogger is called
  categories.add(category);
  return {
    info: (message, meta = {}) => logger.info(message, { ...meta, category }),
    error: (message, meta = {}) => logger.error(message, { ...meta, category }),
    warn: (message, meta = {}) => logger.warn(message, { ...meta, category }),
    debug: (message, meta = {}) => logger.debug(message, { ...meta, category })
  };
}


export default logger;
