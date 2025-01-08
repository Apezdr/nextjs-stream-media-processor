/**
 * Clears all entries from the process_queue table.
 * @param {object} db - The database instance.
 */
export async function resetProcessQueue(db) {
    await db.run(`DELETE FROM process_queue`);
}

/**
 * Removes all processes that are currently in-progress from the process_queue.
 * This is useful during initialization to clean up any processes that were interrupted by a restart.
 * @param {object} db - The database instance.
 */
export async function removeInProgressProcesses(db) {
  const result = await db.run(
    `DELETE FROM process_queue WHERE status = 'in-progress'`
  );
}

/**
 * Marks all in-progress processes as interrupted.
 * Useful for maintaining a history of what was interrupted during a restart.
 * @param {object} db - The database instance.
 */
export async function markInProgressAsInterrupted(db) {
  const result = await db.run(
    `
      UPDATE process_queue
      SET status = 'interrupted',
          message = 'Process was interrupted due to application restart.',
          last_updated = CURRENT_TIMESTAMP
      WHERE status = 'in-progress'
    `
  );
}

/**
 * Creates a new process queue entry or updates it if it already exists.
 * @param {object} db - The database instance.
 * @param {string} fileKey - Unique identifier for the process (e.g. "movie_myMovie", "tv_myShow_1_1", etc.).
 * @param {string} processType - "spritesheet" or "vtt" or any descriptive type you want.
 * @param {number} totalSteps - How many total steps in this process (e.g. 3 for spritesheet, 2 for VTT).
 * @param {number} currentStep - The step we are currently on (1-based index).
 * @param {string} status - e.g. "in-progress", "queued", "completed", "error".
 * @param {string} message - Optional message or description of the current step.
 */
export async function createOrUpdateProcessQueue(
  db,
  fileKey,
  processType,
  totalSteps,
  currentStep,
  status,
  message = ""
) {
  // Attempt an upsert
  const existing = await db.get(
    `SELECT * FROM process_queue WHERE file_key = ?`,
    [fileKey]
  );
  const last_updated = new Date().toISOString();
  if (!existing) {
    // Create new
    await db.run(
      `
          INSERT INTO process_queue (file_key, process_type, total_steps, current_step, status, message)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
      [fileKey, processType, totalSteps, currentStep, status, message]
    );
  } else {
    // Update existing
    await db.run(
      `
          UPDATE process_queue
          SET process_type = ?, total_steps = ?, current_step = ?, status = ?, message = ?, last_updated = ?
          WHERE file_key = ?
        `,
      [processType, totalSteps, currentStep, status, message, last_updated, fileKey]
    );
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
  const existing = await db.get(
    `SELECT * FROM process_queue WHERE file_key = ?`,
    [fileKey]
  );
  if (!existing) return; // or throw an error

  const newCurrentStep =
    currentStep !== null ? currentStep : existing.current_step;
  const newStatus = status || existing.status;
  const newMessage = message || existing.message;
  const last_updated = new Date().toISOString();

  await db.run(
    `
        UPDATE process_queue
        SET current_step = ?, status = ?, message = ?, last_updated = ?
        WHERE file_key = ?
      `,
    [newCurrentStep, newStatus, newMessage, last_updated, fileKey]
  );
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
  const existing = await db.get(
    `SELECT * FROM process_queue WHERE file_key = ?`,
    [fileKey]
  );
  if (!existing) return;

  const last_updated = new Date().toISOString();

  await db.run(
    `
        UPDATE process_queue
        SET current_step = total_steps,
            status = ?,
            message = ?,
            last_updated = ?
        WHERE file_key = ?
      `,
    [status, message, last_updated, fileKey]
  );
}

/**
 * Retrieve all active (non-completed) processes from the queue.
 * You might also want to filter by process_type if needed.
 */
export async function getActiveProcesses(db) {
  return db.all(
    `SELECT * FROM process_queue WHERE status NOT IN ('completed', 'error')`
  );
}

/**
 * Retrieve a single process by fileKey.
 */
export async function getProcessByFileKey(db, fileKey) {
  return db.get(`SELECT * FROM process_queue WHERE file_key = ?`, [fileKey]);
}

/**
 * Retrieve all processes from the process_queue.
 * @param {object} db - The database instance.
 * @returns {Promise<Array>} - Array of process objects.
 */
export async function getAllProcesses(db) {
    return db.all(`SELECT * FROM process_queue ORDER BY last_updated DESC`);
}

/**
 * Retrieve processes from the process_queue with optional filters.
 * @param {object} db - The database instance.
 * @param {object} filters - Filters to apply (e.g., { processType: 'spritesheet', status: 'in-progress' }).
 * @returns {Promise<Array>} - Array of filtered process objects.
 */
export async function getProcessesWithFilters(db, filters = {}) {
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
  
    return db.all(query, params);
}
