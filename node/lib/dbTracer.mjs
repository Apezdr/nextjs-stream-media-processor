/**
 * OpenTelemetry tracing for database operations
 *
 * This module provides specialized tracing functions for database operations,
 * particularly for SQLite and MongoDB operations.
 */

import { getTracer, withSpan } from './tracer.mjs';
import { getMeter, createHistogram, createCounter } from './metrics.mjs';

// Create database-specific tracer and metrics
const tracer = getTracer('database');
const meter = getMeter('database');

// Metrics for database operations
const dbQueryDuration = createHistogram(meter, 'db.query.duration', {
  description: 'Database query duration',
  unit: 'ms'
});

const dbQueryCounter = createCounter(meter, 'db.query.count', {
  description: 'Database query count',
  unit: '1'
});

const dbTransactionCounter = createCounter(meter, 'db.transaction.count', {
  description: 'Database transaction count',
  unit: '1'
});

const dbErrorCounter = createCounter(meter, 'db.query.errors', {
  description: 'Database query error count',
  unit: '1'
});

/**
 * Sanitize SQL queries for telemetry by removing sensitive data
 * 
 * @param {string} sql SQL query to sanitize
 * @returns {string} Sanitized SQL query
 */
function sanitizeSql(sql) {
  if (!sql) return 'unknown';
  
  // Replace literal values with placeholders
  return sql
    .replace(/('.*?')/g, "'?'") // Replace string literals
    .replace(/(\d+)/g, "?") // Replace number literals
    .trim();
}

/**
 * Determine database operation type from SQL query
 * 
 * @param {string} sql SQL query
 * @returns {string} Operation type: SELECT, INSERT, UPDATE, DELETE, etc.
 */
function getOperationType(sql) {
  if (!sql) return 'unknown';
  
  const upperSql = sql.trim().toUpperCase();
  
  if (upperSql.startsWith('SELECT')) return 'SELECT';
  if (upperSql.startsWith('INSERT')) return 'INSERT';
  if (upperSql.startsWith('UPDATE')) return 'UPDATE';
  if (upperSql.startsWith('DELETE')) return 'DELETE';
  if (upperSql.startsWith('CREATE')) return 'CREATE';
  if (upperSql.startsWith('ALTER')) return 'ALTER';
  if (upperSql.startsWith('DROP')) return 'DROP';
  if (upperSql.startsWith('BEGIN')) return 'BEGIN';
  if (upperSql.startsWith('COMMIT')) return 'COMMIT';
  if (upperSql.startsWith('ROLLBACK')) return 'ROLLBACK';
  
  return 'other';
}

/**
 * Create a span for database query execution
 * 
 * @param {Object} options Query options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withDbQuerySpan(options, fn) {
  const operationType = options.operation || getOperationType(options.sql);
  const attributes = {
    'db.system': options.system || 'sqlite',
    'db.name': options.dbName || 'main',
    'db.operation': operationType,
    'db.statement': options.sql ? sanitizeSql(options.sql) : 'unknown'
  };
  
  // Add additional attributes if available
  if (options.table) attributes['db.sql.table'] = options.table;
  
  const startTime = Date.now();
  
  try {
    // Execute database operation
    const result = await withSpan(tracer, `db.${options.system || 'sqlite'}.${operationType.toLowerCase()}`, async () => {
      return await fn();
    }, attributes);
    
    // Record success metrics
    const duration = Date.now() - startTime;
    dbQueryDuration.record(duration, {
      'db.system': options.system || 'sqlite',
      'db.operation': operationType
    });
    
    dbQueryCounter.add(1, {
      'db.system': options.system || 'sqlite',
      'db.operation': operationType
    });
    
    // Add result info to span if available
    if (Array.isArray(result)) {
      attributes['db.rows_affected'] = result.length;
    } else if (result && typeof result === 'object') {
      if ('changes' in result) attributes['db.rows_affected'] = result.changes;
      if ('rowCount' in result) attributes['db.rows_affected'] = result.rowCount;
      if ('lastID' in result) attributes['db.last_id'] = result.lastID;
    }
    
    return result;
  } catch (error) {
    // Record error metrics
    dbErrorCounter.add(1, {
      'db.system': options.system || 'sqlite',
      'db.operation': operationType,
      'error.type': error.name || 'Error'
    });
    
    throw error;
  }
}

/**
 * Create a span for database transaction execution
 * 
 * @param {Object} options Transaction options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withDbTransactionSpan(options, fn) {
  const attributes = {
    'db.system': options.system || 'sqlite',
    'db.name': options.dbName || 'main',
    'db.operation': 'TRANSACTION',
    'db.transaction.type': options.type || 'read-write'
  };
  
  dbTransactionCounter.add(1, {
    'db.system': options.system || 'sqlite',
    'db.transaction.type': options.type || 'read-write'
  });
  
  return withSpan(tracer, `db.${options.system || 'sqlite'}.transaction`, fn, attributes);
}

/**
 * Create a span for database connection
 * 
 * @param {Object} options Connection options
 * @param {Function} fn Function to execute within the span
 * @returns {Promise<any>} Result of the function execution
 */
export async function withDbConnectionSpan(options, fn) {
  const attributes = {
    'db.system': options.system || 'sqlite',
    'db.name': options.dbName || 'main',
    'db.operation': 'CONNECT',
    'db.connection.path': options.path || 'memory'
  };
  
  return withSpan(tracer, `db.${options.system || 'sqlite'}.connect`, fn, attributes);
}