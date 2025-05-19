import { withRetry, initializeDatabase } from '../sqliteDatabase.mjs';
import { createCategoryLogger } from '../lib/logger.mjs';

const logger = createCategoryLogger('processTracking');

/**
 * Gets a connection to the process tracking database
 * @returns {Promise<Object>} - The database connection
 */
export async function getProcessTrackingDb() {
  return await initializeDatabase('processTracking');
}

/**
 * Clears all entries from the process_queue table.
 * @param {object} db - The database instance. If not provided, will get a new connection.
 */
export async function resetProcessQueue(db = null) {
    // Get a database connection if not provided
    if (!db) {
        db = await getProcessTrackingDb();
    }
    try {
        await withRetry(() => db.run(`DELETE FROM process_queue`));
        logger.debug('Process queue reset successfully');
    } catch (error) {
        logger.error(`Error resetting process queue: ${error.message}`);
        throw error;
    }
}

/**
 * Removes all processes that are currently in-progress from the process_queue.
 * This is useful during initialization to clean up any processes that were interrupted by a restart.
 * @param {object} db - The database instance. If not provided, will get a new connection.
 */
export async function removeInProgressProcesses(db = null) {
  // Get a database connection if not provided
  if (!db) {
    db = await getProcessTrackingDb();
  }
  try {
    const result = await withRetry(() => 
      db.run(`DELETE FROM process_queue WHERE status = 'in-progress'`)
    );
    logger.debug(`Removed ${result.changes} in-progress processes`);
    return result;
  } catch (error) {
    logger.error(`Error removing in-progress processes: ${error.message}`);
    throw error;
  }
}

/**
 * Marks all in-progress processes as interrupted.
 * Useful for maintaining a history of what was interrupted during a restart.
 * @param {object} db - The database instance. If not provided, will get a new connection.
 */
export async function markInProgressAsInterrupted(db = null) {
  // Get a database connection if not provided
  if (!db) {
    db = await getProcessTrackingDb();
  }
  try {
    const result = await withRetry(() => 
      db.run(
        `
          UPDATE process_queue
          SET status = 'interrupted',
              message = 'Process was interrupted due to application restart.',
              last_updated = CURRENT_TIMESTAMP
          WHERE status = 'in-progress'
        `
      )
    );
    logger.debug(`Marked ${result.changes} processes as interrupted`);
    return result;
  } catch (error) {
    logger.error(`Error marking processes as interrupted: ${error.message}`);
    throw error;
  }
}

/**
 * Creates a new process queue entry or updates it if it already exists.
 * @param {object} db - The database instance. If not provided, will get a new connection.
 * @param {string} fileKey - Unique identifier for the process (e.g. "movie_myMovie", "tv_myShow_1_1", etc.).
 * @param {string} processType - "spritesheet" or "vtt" or any descriptive type you want.
 * @param {number} totalSteps - How many total steps in this process (e.g. 3 for spritesheet, 2 for VTT).
 * @param {number} currentStep - The step we are currently on (1-based index).
 * @param {string} status - e.g. "in-progress", "queued", "completed", "error".
 * @param {string} message - Optional message or description of the current step.
 */
export async function createOrUpdateProcessQueue(
  db = null,
  fileKey,
  processType,
  totalSteps,
  currentStep,
  status,
  message = ""
) {
  // Get a database connection if not provided
  if (!db) {
    db = await getProcessTrackingDb();
  }
  try {
    // Attempt an upsert
    const existing = await withRetry(() => 
      db.get(`SELECT * FROM process_queue WHERE file_key = ?`, [fileKey])
    );
    
    const last_updated = new Date().toISOString();
    
    if (!existing) {
      // Create new
      logger.debug(`Creating new process queue entry for ${fileKey}`);
      await withRetry(() => 
        db.run(
          `
              INSERT INTO process_queue (file_key, process_type, total_steps, current_step, status, message)
              VALUES (?, ?, ?, ?, ?, ?)
            `,
          [fileKey, processType, totalSteps, currentStep, status, message]
        )
      );
    } else {
      // Update existing
      logger.debug(`Updating existing process queue entry for ${fileKey}`);
      await withRetry(() => 
        db.run(
          `
              UPDATE process_queue
              SET process_type = ?, total_steps = ?, current_step = ?, status = ?, message = ?, last_updated = ?
              WHERE file_key = ?
            `,
          [processType, totalSteps, currentStep, status, message, last_updated, fileKey]
        )
      );
    }
  } catch (error) {
    logger.error(`Error in createOrUpdateProcessQueue for ${fileKey}: ${error.message}`);
    throw error;
  }
}

/**
 * Update the current step, status, and/or message of an existing queue entry.
 */
export async function updateProcessQueue(
  db,
  fileKey,
  currentStep = null,
  status = null,
  message = null
) {
  try {
    const existing = await withRetry(() => 
      db.get(`SELECT * FROM process_queue WHERE file_key = ?`, [fileKey])
    );
    
    if (!existing) {
      logger.warn(`Attempted to update non-existent process: ${fileKey}`);
      return; // or throw an error
    }

    const newCurrentStep = currentStep !== null ? currentStep : existing.current_step;
    const newStatus = status || existing.status;
    const newMessage = message || existing.message;
    const last_updated = new Date().toISOString();

    logger.debug(`Updating process ${fileKey} to step ${newCurrentStep}, status: ${newStatus}`);
    
    await withRetry(() => 
      db.run(
        `
            UPDATE process_queue
            SET current_step = ?, status = ?, message = ?, last_updated = ?
            WHERE file_key = ?
          `,
        [newCurrentStep, newStatus, newMessage, last_updated, fileKey]
      )
    );
  } catch (error) {
    logger.error(`Error updating process ${fileKey}: ${error.message}`);
    // Don't throw here to prevent process failures if tracking fails
    // Just log the error and continue
  }
}
/**
 * Mark a process as completed (or errored out).
 */
export async function finalizeProcessQueue(
  db,
  fileKey,
  status = "completed",
  message = ""
) {
  try {
    const existing = await withRetry(() => 
      db.get(`SELECT * FROM process_queue WHERE file_key = ?`, [fileKey])
    );
    
    if (!existing) {
      logger.warn(`Attempted to finalize non-existent process: ${fileKey}`);
      return;
    }

    const last_updated = new Date().toISOString();

    logger.debug(`Finalizing process ${fileKey} with status: ${status}`);
    
    await withRetry(() => 
      db.run(
        `
            UPDATE process_queue
            SET current_step = total_steps,
                status = ?,
                message = ?,
                last_updated = ?
            WHERE file_key = ?
          `,
        [status, message, last_updated, fileKey]
      )
    );
  } catch (error) {
    logger.error(`Error finalizing process ${fileKey}: ${error.message}`);
    // Don't throw here to prevent process failures if tracking fails
  }
}

/**
 * Retrieve all active (non-completed) processes from the queue.
 * You might also want to filter by process_type if needed.
 */
export async function getActiveProcesses(db) {
  try {
    return await withRetry(() => 
      db.all(`SELECT * FROM process_queue WHERE status NOT IN ('completed', 'error')`)
    );
  } catch (error) {
    logger.error(`Error retrieving active processes: ${error.message}`);
    return []; // Return empty array instead of throwing
  }
}

/**
 * Retrieve a single process by fileKey.
 */
export async function getProcessByFileKey(db, fileKey) {
  try {
    return await withRetry(() => 
      db.get(`SELECT * FROM process_queue WHERE file_key = ?`, [fileKey])
    );
  } catch (error) {
    logger.error(`Error retrieving process ${fileKey}: ${error.message}`);
    return null; // Return null instead of throwing
  }
}

/**
 * Retrieve all processes from the process_queue.
 * @param {object} db - The database instance. If not provided, will get a new connection.
 * @returns {Promise<Array>} - Array of process objects.
 */
export async function getAllProcesses(db = null) {
  if (!db) {
    db = await getProcessTrackingDb();
  }
  try {
    return await withRetry(() => 
      db.all(`SELECT * FROM process_queue ORDER BY last_updated DESC`)
    );
  } catch (error) {
    logger.error(`Error retrieving all processes: ${error.message}`);
    return []; // Return empty array instead of throwing
  }
}

/**
 * Retrieve processes from the process_queue with optional filters.
 * @param {object} db - The database instance. If not provided, will get a new connection.
 * @param {object} filters - Filters to apply (e.g., { processType: 'spritesheet', status: 'in-progress' }).
 * @returns {Promise<Array>} - Array of filtered process objects.
 */
export async function getProcessesWithFilters(db = null, filters = {}) {
  // Get a database connection if not provided
  if (!db) {
    db = await getProcessTrackingDb();
  }
  try {
    const { processType, status } = filters;
    let query = `SELECT * FROM process_queue`;
    const conditions = [];
    const params = [];
    
    if (processType) {
      conditions.push(`process_type = ?`);
      params.push(processType);
    }
    
    if (status) {
      conditions.push(`status = ?`);
      params.push(status);
    }
    
    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(' AND ');
    }
    
    query += ` ORDER BY last_updated DESC`;
    
    return await withRetry(() => db.all(query, params));
  } catch (error) {
    logger.error(`Error retrieving filtered processes: ${error.message}`);
    return []; // Return empty array instead of throwing
  }
}
