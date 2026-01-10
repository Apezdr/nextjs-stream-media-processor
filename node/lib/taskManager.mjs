import { createCategoryLogger } from './logger.mjs';

const logger = createCategoryLogger('taskManager');

// Task types with priority levels (lower number = higher priority)
export const TaskType = {
  API_REQUEST: 1,        // Highest priority - user-facing requests
  SYSTEM_MONITORING: 1.5, // System health monitoring - high priority
  MEDIA_SCAN: 2,         // General media scanning operations
  MOVIE_SCAN: 2.1,       // Movie scanning specifically 
  TV_SCAN: 2.2,          // TV show scanning specifically
  METADATA_HASH: 3,      // Metadata hash operations
  BLURHASH: 4,           // Blurhash operations
  DOWNLOAD: 5,           // TMDB downloads
  CACHE_CLEANUP: 6       // Lowest priority - cleanup operations
};

// Active task tracking
const activeTasks = new Map();
const taskQueues = new Map();
let taskIdCounter = 0;

// Track last 3 completions for each task type
const completionHistory = new Map();
const MAX_HISTORY_PER_TYPE = 3;

// Configure which task types can run concurrently
const concurrencyLimits = {
  [TaskType.API_REQUEST]: 5,        // Allow multiple API requests
  [TaskType.SYSTEM_MONITORING]: 1,  // Only one system monitoring task at a time
  [TaskType.MEDIA_SCAN]: 1,         // Only one general media scan at a time
  [TaskType.MOVIE_SCAN]: 1,         // Only one movie scan at a time
  [TaskType.TV_SCAN]: 1,            // Only one TV scan at a time
  [TaskType.METADATA_HASH]: 1,      // Only one metadata hash operation
  [TaskType.BLURHASH]: 1,           // Only one blurhash operation
  [TaskType.DOWNLOAD]: 2,           // Allow 2 download operations
  [TaskType.CACHE_CLEANUP]: 1       // Only one cleanup at a time
};

// Configure which tasks are mutually exclusive
const exclusiveGroups = [
  // These task types cannot run together
  [TaskType.MEDIA_SCAN, TaskType.METADATA_HASH, TaskType.BLURHASH],
  // Movie and TV scans can happen in parallel
  [TaskType.DOWNLOAD, TaskType.CACHE_CLEANUP]
];

/**
 * Check if a task can start based on running tasks and exclusivity rules
 * @param {number} taskType - The task type to check
 * @returns {boolean} - Whether the task can start
 */
function canTaskStart(taskType) {
  // Count current tasks of this type
  const currentCount = Array.from(activeTasks.values())
    .filter(task => task.type === taskType)
    .length;
  
  // Check concurrency limit
  if (currentCount >= concurrencyLimits[taskType]) {
    return false;
  }
  
  // Check exclusivity groups
  for (const group of exclusiveGroups) {
    if (group.includes(taskType)) {
      // If this task is in an exclusivity group, check if any other tasks
      // from the same group are running
      const hasExclusiveTaskRunning = Array.from(activeTasks.values())
        .some(task => task.type !== taskType && group.includes(task.type));
      
      if (hasExclusiveTaskRunning) {
        return false;
      }
    }
  }
  
  return true;
}

/**
 * Process queued tasks when a running task completes
 */
function processQueues() {
  // Sort task types by priority
  const sortedTypes = Object.values(TaskType).sort((a, b) => a - b);
  
  for (const type of sortedTypes) {
    const queue = taskQueues.get(type) || [];
    
    while (queue.length > 0 && canTaskStart(type)) {
      const task = queue.shift();
      try {
        const taskId = ++taskIdCounter;
        
        // Start the task
        activeTasks.set(taskId, {
          id: taskId,
          type: type,
          name: task.name,
          startTime: Date.now()
        });
        
        // Execute the task
        const startTime = Date.now();
        Promise.resolve(task.fn())
          .then(result => {
            const endTime = Date.now();
            const duration = endTime - startTime;
            
            logger.debug(`Task completed: ${task.name} (took ${duration}ms)`);
            activeTasks.delete(taskId);
            
            // Track completion in history
            addCompletionToHistory(type, task.name, duration, endTime);
            
            if (task.resolve) task.resolve(result);
            
            // Process queues again after task completes
            processQueues();
          })
          .catch(error => {
            logger.error(`Task failed: ${task.name}` + error);
            activeTasks.delete(taskId);
            if (task.reject) task.reject(error);
            
            // Process queues again after task fails
            processQueues();
          });
        
        break; // Only start one task per type per cycle
      } catch (error) {
        logger.error(`Error starting task ${task.name}:` + error);
        if (task.reject) task.reject(error);
      }
    }
  }
}

/**
 * Enqueue a task to run when resources are available
 * @param {number} type - Task type from TaskType enum
 * @param {string} name - Descriptive name for the task
 * @param {Function} fn - Function to execute
 * @param {boolean} immediate - If true, run immediately if possible
 * @returns {Promise} - Resolves when the task completes
 */
export function enqueueTask(type, name, fn, immediate = false) {
  if (!taskQueues.has(type)) {
    taskQueues.set(type, []);
  }
  
  // Create a promise that will resolve when the task completes
  return new Promise((resolve, reject) => {
    const task = { name, fn, resolve, reject };
    
    // Check if we can run the task immediately
    if (immediate && canTaskStart(type)) {
      const taskId = ++taskIdCounter;
      
      // Start the task
      activeTasks.set(taskId, {
        id: taskId,
        type: type,
        name: name,
        startTime: Date.now()
      });
      
      // Execute the task
      const startTime = Date.now();
      Promise.resolve(fn())
        .then(result => {
          const endTime = Date.now();
          const duration = endTime - startTime;
          
          logger.debug(`Task completed: ${name} (took ${duration}ms)`);
          activeTasks.delete(taskId);
          
          // Track completion in history
          addCompletionToHistory(type, name, duration, endTime);
          
          resolve(result);
          
          // Process queues after task completes
          processQueues();
        })
        .catch(error => {
          logger.error(`Task failed: ${name}` + error);
          activeTasks.delete(taskId);
          reject(error);
          
          // Process queues after task fails
          processQueues();
        });
    } else {
      // Queue the task
      taskQueues.get(type).push(task);
      logger.debug(`Task queued: ${name}`);
      
      // Process queues in case this task can run now
      if (!immediate) {
        processQueues();
      }
    }
  });
}

/**
 * Add a task completion to the history
 * Maintains last 3 completions per task type
 * @param {number} type - Task type
 * @param {string} name - Task name
 * @param {number} durationMs - Duration in milliseconds
 * @param {number} completedAt - Completion timestamp
 */
function addCompletionToHistory(type, name, durationMs, completedAt) {
  if (!completionHistory.has(type)) {
    completionHistory.set(type, []);
  }
  
  const history = completionHistory.get(type);
  
  // Add new completion to the front
  history.unshift({
    name,
    durationMs,
    completedAt
  });
  
  // Keep only last 3
  if (history.length > MAX_HISTORY_PER_TYPE) {
    history.pop();
  }
}

/**
 * Get current status of active tasks and queues
 * @returns {Object} - Status information
 */
export function getTaskStatus() {
  return {
    activeTasks: Array.from(activeTasks.values()).map(task => ({
      id: task.id,
      type: task.type,
      name: task.name,
      runningForMs: Date.now() - task.startTime
    })),
    queueSizes: Object.values(TaskType).reduce((acc, type) => {
      acc[type] = (taskQueues.get(type) || []).length;
      return acc;
    }, {}),
    completionHistory: Object.values(TaskType).reduce((acc, type) => {
      const history = completionHistory.get(type);
      if (history && history.length > 0) {
        acc[type] = history.map(completion => ({
          name: completion.name,
          durationMs: completion.durationMs,
          completedAt: completion.completedAt,
          completedAgo: Date.now() - completion.completedAt
        }));
      }
      return acc;
    }, {})
  };
}

/**
 * Cancel all tasks of a specific type
 * @param {number} type - The task type to cancel
 * @returns {number} - Number of tasks canceled
 */
export function cancelTasksByType(type) {
  // Clear the queue for this type
  const queue = taskQueues.get(type) || [];
  const queueSize = queue.length;
  
  // Reject all queued tasks
  queue.forEach(task => {
    if (task.reject) {
      task.reject(new Error(`Task ${task.name} canceled`));
    }
  });
  
  // Clear the queue
  taskQueues.set(type, []);
  
  // Find running tasks of this type
  const runningTasks = Array.from(activeTasks.values())
    .filter(task => task.type === type);
  
  // Log that we can't cancel already running tasks
  if (runningTasks.length > 0) {
    logger.warn(`Cannot cancel ${runningTasks.length} already running tasks of type ${type}`);
  }
  
  return queueSize;
}
