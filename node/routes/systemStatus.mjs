import express from 'express';
import si from 'systeminformation';
import { createCategoryLogger } from '../lib/logger.mjs';
import { createHash } from 'crypto';
import { scheduleJob } from 'node-schedule';
import { enqueueTask, TaskType, getTaskStatus } from '../lib/taskManager.mjs';
import { getAllValidWebhookIds, validateWebhookAuth } from '../middleware/webhookAuth.mjs';
import { NotificationManager } from '../integrations/index.mjs';

const router = express.Router();
const logger = createCategoryLogger('systemStatusRoutes');
const isDebugMode = process.env.DEBUG === 'TRUE';

// Initialize notification manager for multi-platform notifications
const notificationManager = new NotificationManager();

// Store previous disksIO measurements to calculate proper I/O rates
let lastDisksIOStats = null;
let lastDisksIOTime = 0;

// Cache system status results briefly to reduce load from multiple clients
// requesting status information simultaneously
const statusCache = {
  data: null,
  timestamp: 0,
  etag: '',
};

// Cache TTL in milliseconds (60 seconds for general requests)
const CACHE_TTL = 60 * 1000;

// Longer TTL for polling clients - they should respect this and avoid frequent requests
const CLIENT_CACHE_TTL = 120; // 2 minutes

// Feature flags for which resources to monitor (default all to true)
const MONITOR_CPU = (process.env.SYSTEM_STATUS_MONITOR_CPU || 'TRUE').toUpperCase() !== 'FALSE';
const MONITOR_MEMORY = (process.env.SYSTEM_STATUS_MONITOR_MEMORY || 'TRUE').toUpperCase() !== 'FALSE';
const MONITOR_DISK = (process.env.SYSTEM_STATUS_MONITOR_DISK || 'TRUE').toUpperCase() !== 'FALSE';

// Custom thresholds from environment variables (fall back to defaults if not specified)
const THRESHOLDS = {
  elevated: {
    cpu: parseInt(process.env.SYSTEM_STATUS_CPU_ELEVATED, 10) || 70,
    memory: parseInt(process.env.SYSTEM_STATUS_MEMORY_ELEVATED, 10) || 70,
    disk: parseInt(process.env.SYSTEM_STATUS_DISK_ELEVATED, 10) || 80
  },
  heavy: {
    cpu: parseInt(process.env.SYSTEM_STATUS_CPU_HEAVY, 10) || 85,
    memory: parseInt(process.env.SYSTEM_STATUS_MEMORY_HEAVY, 10) || 80,
    disk: parseInt(process.env.SYSTEM_STATUS_DISK_HEAVY, 10) || 90
  },
  critical: {
    cpu: parseInt(process.env.SYSTEM_STATUS_CPU_CRITICAL, 10) || 95,
    memory: parseInt(process.env.SYSTEM_STATUS_MEMORY_CRITICAL, 10) || 90,
    disk: parseInt(process.env.SYSTEM_STATUS_DISK_CRITICAL, 10) || 95
  }
};

// Minimum free disk space before triggering critical warning (default: 5GB)
const MIN_FREE_DISK_SPACE = parseInt(process.env.SYSTEM_STATUS_MIN_FREE_DISK_GB, 10) * 1024 * 1024 * 1024 || 5 * 1024 * 1024 * 1024;

if (isDebugMode) {
  logger.debug(`System status monitoring: CPU=${MONITOR_CPU}, Memory=${MONITOR_MEMORY}, Disk=${MONITOR_DISK}`);
  logger.debug(`System status thresholds: ${JSON.stringify(THRESHOLDS)}`);
  logger.debug(`Minimum free disk space: ${formatBytes(MIN_FREE_DISK_SPACE)}`);
}

// Track active system incidents
let currentIncident = null;

// Track the last time we sent a notification for each status level
// This prevents sending too many notifications in a short period
const lastNotificationTime = {
  elevated: 0,
  heavy: 0,
  critical: 0
};

// Minimum time between notifications (in milliseconds)
const NOTIFICATION_COOLDOWN = {
  elevated: 10 * 60 * 1000, // 10 minutes for elevated
  heavy: 5 * 60 * 1000,     // 5 minutes for heavy
  critical: 2 * 60 * 1000   // 2 minutes for critical
};


/**
 * Updates incident tracking based on current system status
 * @param {Object} systemStatus The current system status object
 */
function updateIncidentStatus(systemStatus) {
  const now = new Date();
  
  // If we have a heavy or critical status, create or update incident
  if (systemStatus.status === 'heavy' || systemStatus.status === 'critical') {
    if (!currentIncident) {
      // Create new incident
      currentIncident = {
        id: `incident-${Date.now()}`,
        startTime: now.toISOString(),
        status: systemStatus.status,
        latestUpdate: now.toISOString(),
        message: systemStatus.message,
        updates: [{
          time: now.toISOString(),
          status: systemStatus.status,
          message: systemStatus.message
        }]
      };
      logger.info(`New system incident created: ${currentIncident.id} - ${systemStatus.status}`);
    } else {
      // Update existing incident
      currentIncident.status = systemStatus.status;
      currentIncident.latestUpdate = now.toISOString();
      
      // Add new update to the array, limiting the size to prevent memory issues
      currentIncident.updates.push({
        time: now.toISOString(),
        status: systemStatus.status,
        message: systemStatus.message
      });
      
      // Keep only the most recent 20 updates to prevent memory bloat
      // We keep the first (original) update and the most recent ones
      const MAX_UPDATES = 20;
      if (currentIncident.updates.length > MAX_UPDATES) {
        const firstUpdate = currentIncident.updates[0]; // Keep the original incident start
        const recentUpdates = currentIncident.updates.slice(-1 * (MAX_UPDATES - 1)); // Keep recent updates
        currentIncident.updates = [firstUpdate, ...recentUpdates];
        
        if (isDebugMode) {
          logger.debug(`Trimmed incident updates array to ${currentIncident.updates.length} entries to prevent memory bloat`);
        }
      }
      
      logger.info(`Incident ${currentIncident.id} updated to ${systemStatus.status}`);
    }
  } 
  // If status returns to normal, resolve the incident if one exists
  else if (systemStatus.status === 'normal' && currentIncident) {
    currentIncident.status = 'resolved';
    currentIncident.resolvedTime = now.toISOString();
    
    // Add the resolution update
    currentIncident.updates.push({
      time: now.toISOString(),
      status: 'resolved',
      message: 'System has returned to normal operation.'
    });
    
    // Check if we need to trim the updates array here too
    const MAX_UPDATES = 20;
    if (currentIncident.updates.length > MAX_UPDATES) {
      const firstUpdate = currentIncident.updates[0]; // Keep the original incident start
      const resolutionUpdate = currentIncident.updates[currentIncident.updates.length - 1]; // Keep the resolution
      const middleUpdates = currentIncident.updates.slice(-1 * (MAX_UPDATES - 2), -1); // Keep some recent pre-resolution updates
      currentIncident.updates = [firstUpdate, ...middleUpdates, resolutionUpdate];
      
      if (isDebugMode) {
        logger.debug(`Trimmed incident updates array to ${currentIncident.updates.length} entries on resolution`);
      }
    }
    
    logger.info(`Incident ${currentIncident.id} resolved`);
    
    // Keep the resolved incident visible for a period, then clear it
    setTimeout(() => {
      currentIncident = null;
      logger.debug('Cleared resolved incident from memory');
    }, 30 * 60 * 1000); // 30 minutes
  }
}

/**
 * Check if the system is under heavy load and provide metrics
 * @route GET /api/system-status
 * @security X-Webhook-ID
 */
router.get('/system-status', async (req, res) => {
  try {
    // Get ALL valid webhook IDs from environment variables
    const validWebhookIds = getAllValidWebhookIds();

    // Verify webhook authentication against any valid ID
    if (!validWebhookIds.includes(req.headers['x-webhook-id'])) {
      logger.warn('Unauthorized system status request attempted');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check for If-None-Match header for conditional requests
    const requestEtag = req.headers['if-none-match'];
    
    // Use cached response if it's fresh and ETag matches
    if (
      statusCache.data &&
      Date.now() - statusCache.timestamp < CACHE_TTL &&
      requestEtag === statusCache.etag
    ) {
      // Return 304 Not Modified if ETag matches
      return res.status(304).end();
    }

    // Use cached response if it's fresh (but client doesn't have it yet)
    if (statusCache.data && Date.now() - statusCache.timestamp < CACHE_TTL) {
      res.set('ETag', statusCache.etag);
      res.set('Cache-Control', 'public, max-age=15'); // 15 seconds
      
      // Add incident information if there is an active incident
      const responseWithIncident = {
        ...statusCache.data,
        incident: currentIncident
      };
      
      return res.json(responseWithIncident);
    }

    // Cache is stale or doesn't exist - refresh it using shared function
    await refreshSystemStatus();
    
    // Retrieve the freshly updated cache
    const responseWithIncident = {
      ...statusCache.data,
      incident: currentIncident
    };
    
    // Set more aggressive cache headers to reduce load
    res.set('ETag', statusCache.etag);
    res.set('Cache-Control', `public, max-age=${CLIENT_CACHE_TTL}`); // 2 minutes client-side cache
    res.set('Expires', new Date(Date.now() + CLIENT_CACHE_TTL * 1000).toUTCString());
    
    // Include rate limit advice in headers
    res.set('X-RateLimit-Limit', '30'); // 30 requests per 10 minutes
    res.set('X-RateLimit-Remaining', '29'); // Just an example value
    res.set('X-RateLimit-Reset', Math.floor((Date.now() + 600000) / 1000)); // 10 minutes from now
    
    res.json(responseWithIncident);
  } catch (error) {
    logger.error(`Error retrieving system status: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Send system status notifications to all configured platforms (frontends, Discord, etc.)
 * Uses the NotificationManager to handle multi-platform notifications
 * @param {string} status System status level
 * @param {string} message Detailed status message
 * @param {object} statusData Complete status information
 */
async function checkAndSendNotification(status, message, statusData) {
  try {
    const results = await notificationManager.sendNotifications(
      status,
      message,
      statusData,
      currentIncident,
      process.env.FILE_SERVER_NODE_URL || 'unknown',
      lastNotificationTime,
      NOTIFICATION_COOLDOWN
    );
    
    if (results.sent > 0) {
      logger.info(`Notifications sent: ${results.sent} successful, ${results.failed} failed, ${results.skipped} skipped`);
    } else if (results.skipped > 0) {
      if (isDebugMode) {
        logger.debug(`All notifications skipped (cooldown period active)`);
      }
    }
    
    return results;
  } catch (error) {
    logger.error(`Error in notification system: ${error.message}`);
    throw error;
  }
}

/**
 * Manual endpoint to trigger system status check and notifications
 * @route POST /api/trigger-system-status
 * @security X-Webhook-ID
 */
router.post('/trigger-system-status', async (req, res) => {
  try {
    // Get ALL valid webhook IDs from environment variables
    const validWebhookIds = getAllValidWebhookIds();

    // Verify webhook authentication against any valid ID
    if (!validWebhookIds.includes(req.headers['x-webhook-id'])) {
      logger.warn('Unauthorized system status trigger attempted');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Collect system metrics to get current status
    const [cpu, mem, currentLoad, fsSize, disksIO] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.currentLoad(),
      si.fsSize(),
      getDiskIOMetrics() // Add disk I/O metrics to the trigger endpoint
    ]);
    
    // Basic calculations
    const memUsagePercent = (mem.used / mem.total) * 100;
    const diskUsagePercent = fsSize.length > 0 ?
      fsSize.reduce((sum, drive) => sum + (drive.used / drive.size) * 100, 0) / fsSize.length : 0;
    const cpuUsagePercent = currentLoad.currentLoad;
    
    // Calculate total and free disk space
    const totalDiskSpace = fsSize.reduce((sum, drive) => sum + drive.size, 0);
    const freeDiskSpace = fsSize.reduce((sum, drive) => sum + drive.available, 0);
    
    // Prepare enhanced status response
    const systemStatus = {
      status: req.query.forceStatus || 'normal',
      message: req.query.message || 'System is operating normally.',
      metrics: {
        cpu: { 
          usage: cpuUsagePercent.toFixed(1),
          cores: cpu.cores 
        },
        memory: { 
          usage: memUsagePercent.toFixed(1),
          total: formatBytes(mem.total),
          free: formatBytes(mem.free),
          used: formatBytes(mem.used)
        },
        disk: {
          usage: diskUsagePercent.toFixed(1),
          total: formatBytes(totalDiskSpace),
          free: formatBytes(freeDiskSpace),
          io: disksIO ? {
            read_sec: formatBytes(disksIO.rIO_sec || 0),
            write_sec: formatBytes(disksIO.wIO_sec || 0),
            total_sec: formatBytes(disksIO.tIO_sec || 0),
            read_wait_percent: disksIO.rWaitPercent ? disksIO.rWaitPercent.toFixed(1) : '0.0',
            write_wait_percent: disksIO.wWaitPercent ? disksIO.wWaitPercent.toFixed(1) : '0.0',
            total_wait_percent: disksIO.tWaitPercent ? disksIO.tWaitPercent.toFixed(1) : '0.0'
          } : null,
          drives: fsSize.map(drive => ({
            mount: drive.mount,
            size: formatBytes(drive.size),
            available: formatBytes(drive.available),
            use: drive.use.toFixed(1) + '%'
          }))
        }
      },
      timestamp: new Date().toISOString()
    };
    
    // Reset notification cooldowns to force notification
    Object.keys(lastNotificationTime).forEach(key => {
      lastNotificationTime[key] = 0;
    });
    
    // Force a notification regardless of status (for testing)
    await checkAndSendNotification(
      req.query.forceStatus || systemStatus.status, 
      systemStatus.message, 
      systemStatus
    );
    
    res.json({
      success: true,
      message: 'System status checked and notification sent',
      status: systemStatus
    });
  } catch (error) {
    logger.error(`Error triggering system status check: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Gets disk I/O metrics with correct rate calculations
 * @returns {Promise<object>} Disk I/O statistics with proper rate calculations
 */
async function getDiskIOMetrics() {
  if (isDebugMode) {
    logger.debug("Getting disk I/O metrics with forced double measurement");
  }
  
  // Always take a first measurement and then a second one after a delay
  // This is required because the library calculates rates between two calls
  
  // First measurement
  await si.disksIO();
  
  // Delay to allow for rate calculations (1 second)
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Second measurement (this one will have rates)
  const stats = await si.disksIO();
  
  if (isDebugMode) {
    logger.debug(`Disk I/O stats: read_sec=${stats.rIO_sec || 0}, write_sec=${stats.wIO_sec || 0}`);
  }
  
  // If stats are still null/undefined, return default values
  if (!stats || typeof stats.rIO_sec === 'undefined') {
    return {
      rIO_sec: 0,
      wIO_sec: 0,
      tIO_sec: 0,
      rWaitPercent: 0,
      wWaitPercent: 0,
      tWaitPercent: 0
    };
  }
  
  return stats;
}

/**
 * Format bytes to a human-readable string
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string with units
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Shared function to refresh system status metrics and update cache
 * Used by both the API endpoint and the scheduled background job
 * @returns {Promise<object>} The complete system status object
 */
async function refreshSystemStatus() {
  // Collect system metrics in parallel for efficiency
  const [cpu, mem, currentLoad, fsSize, disksIO, processes] = await Promise.all([
    si.cpu(),
    si.mem(),
    si.currentLoad(),
    si.fsSize(),
    getDiskIOMetrics(),
    si.processes()
  ]);

  // Get Linux-specific load averages if available
  const loadAverage = process.platform === 'linux' ?
    (await si.currentLoad()).avgLoad :
    [0, 0, 0];

  // Calculate memory usage percentage
  const memUsagePercent = (mem.used / mem.total) * 100;

  // Calculate overall disk usage percentage (average across all drives)
  const diskUsagePercent = fsSize.length > 0 ?
    fsSize.reduce((sum, drive) => sum + (drive.used / drive.size) * 100, 0) / fsSize.length :
    0;

  // Calculate CPU utilization (average across all cores)
  const cpuUsagePercent = currentLoad.currentLoad;

  // Determine system status based on thresholds
  let status = 'normal';
  let message = 'System is operating normally.';

  // Determine status based on the highest resource usage (only for enabled monitors)
  const criticalConditions = [
    MONITOR_CPU && cpuUsagePercent >= THRESHOLDS.critical.cpu,
    MONITOR_MEMORY && memUsagePercent >= THRESHOLDS.critical.memory,
    MONITOR_DISK && diskUsagePercent >= THRESHOLDS.critical.disk
  ].filter(Boolean);
  
  const heavyConditions = [
    MONITOR_CPU && cpuUsagePercent >= THRESHOLDS.heavy.cpu,
    MONITOR_MEMORY && memUsagePercent >= THRESHOLDS.heavy.memory,
    MONITOR_DISK && diskUsagePercent >= THRESHOLDS.heavy.disk
  ].filter(Boolean);
  
  const elevatedConditions = [
    MONITOR_CPU && cpuUsagePercent >= THRESHOLDS.elevated.cpu,
    MONITOR_MEMORY && memUsagePercent >= THRESHOLDS.elevated.memory,
    MONITOR_DISK && diskUsagePercent >= THRESHOLDS.elevated.disk
  ].filter(Boolean);
  
  if (criticalConditions.length > 0) {
    status = 'critical';
    message = 'System resources are critically constrained. User experience will be degraded.';
  } else if (heavyConditions.length > 0) {
    status = 'heavy';
    message = 'System is under heavy load. User experience may be affected.';
  } else if (elevatedConditions.length > 0) {
    status = 'elevated';
    message = 'System is under moderate load but operating normally.';
  }

  // Add detail to the message for debugging
  let detailedMessage = message;
  if (status !== 'normal') {
    const highestUtilization = [
      { name: 'CPU', value: cpuUsagePercent },
      { name: 'Memory', value: memUsagePercent },
      { name: 'Disk', value: diskUsagePercent }
    ].sort((a, b) => b.value - a.value)[0];
    
    detailedMessage += ` The ${highestUtilization.name} utilization is at ${highestUtilization.value.toFixed(1)}%.`;
  }

  // Calculate total and free disk space
  const totalDiskSpace = fsSize.reduce((sum, drive) => sum + drive.size, 0);
  const freeDiskSpace = fsSize.reduce((sum, drive) => sum + drive.available, 0);
  
  // Check for critically low absolute free space (if disk monitoring is enabled)
  const criticallyLowSpace = MONITOR_DISK && freeDiskSpace < MIN_FREE_DISK_SPACE;
  if (criticallyLowSpace && status !== 'critical') {
    status = 'critical';
    detailedMessage = `Critical disk space issue. Only ${formatBytes(freeDiskSpace)} available across all drives.`;
  }
  
  // Find the most constrained drive
  const worstDrive = fsSize.length > 0 ?
    [...fsSize].sort((a, b) => b.use - a.use)[0] : null;
  
  // Add drive-specific details to message if space is an issue
  if (status !== 'normal' && diskUsagePercent >= THRESHOLDS.elevated.disk && worstDrive) {
    if (!detailedMessage.includes('disk')) {
      detailedMessage += ` Drive ${worstDrive.mount} is at ${worstDrive.use.toFixed(1)}% capacity with ${formatBytes(worstDrive.available)} free.`;
    }
  }
  
  // Prepare system status object
  const systemStatus = {
    status,
    message: detailedMessage,
    metrics: {
      cpu: {
        usage: cpuUsagePercent.toFixed(1),
        cores: cpu.cores,
        model: cpu.manufacturer + ' ' + cpu.brand
      },
      memory: {
        usage: memUsagePercent.toFixed(1),
        total: formatBytes(mem.total),
        free: formatBytes(mem.free),
        used: formatBytes(mem.used)
      },
      disk: {
        usage: diskUsagePercent.toFixed(1),
        total: formatBytes(totalDiskSpace),
        free: formatBytes(freeDiskSpace),
        io: disksIO ? {
          read_sec: formatBytes(disksIO.rIO_sec || 0),
          write_sec: formatBytes(disksIO.wIO_sec || 0),
          total_sec: formatBytes(disksIO.tIO_sec || 0),
          read_wait_percent: disksIO.rWaitPercent ? disksIO.rWaitPercent.toFixed(1) : '0.0',
          write_wait_percent: disksIO.wWaitPercent ? disksIO.wWaitPercent.toFixed(1) : '0.0',
          total_wait_percent: disksIO.tWaitPercent ? disksIO.tWaitPercent.toFixed(1) : '0.0'
        } : null,
        drives: fsSize.map(drive => ({
          fs: drive.fs,
          type: drive.type,
          mount: drive.mount,
          size: formatBytes(drive.size),
          used: formatBytes(drive.used),
          available: formatBytes(drive.available),
          use: drive.use.toFixed(1) + '%'
        }))
      },
      processes: {
        total: processes.all,
        running: processes.running
      },
      loadAverage
    },
    timestamp: new Date().toISOString()
  };
  
  // Update incident tracking
  updateIncidentStatus(systemStatus);
  
  // Calculate ETag for the response
  const responseWithIncident = {
    ...systemStatus,
    incident: currentIncident
  };
  
  const etag = createHash('md5')
    .update(JSON.stringify(responseWithIncident))
    .digest('hex');
  
  // Update the cache
  statusCache.data = systemStatus;
  statusCache.timestamp = Date.now();
  statusCache.etag = etag;
  
  // Log system status for monitoring
  if (status !== 'normal') {
    logger.info(`System status: ${status} - ${detailedMessage}`);
    
    // Check if we need to send a push notification
    const isCriticalChange = status === 'critical' || status === 'heavy';
    if (isCriticalChange) {
      // Don't await to prevent blocking
      checkAndSendNotification(status, detailedMessage, systemStatus)
        .catch(error => {
          logger.error(`Error sending notification: ${error.message}`);
        });
    }
  } else if (isDebugMode) {
    logger.debug(`System status: ${status}`);
  }
  
  return systemStatus;
}

// Schedule periodic system status checks - runs every 60 seconds (CACHE_TTL)
// This ensures the cache is always fresh and we detect system issues proactively
scheduleJob(`*/${CACHE_TTL / 1000} * * * * *`, () => {
  enqueueTask(TaskType.SYSTEM_MONITORING, 'Scheduled System Health Check', async () => {
    try {
      if (isDebugMode) {
        logger.debug('Running scheduled system health check (refreshing cache)...');
      }
      
      // Use the shared refresh function to update cache and handle all logic
      const systemStatus = await refreshSystemStatus();
      
      return `Scheduled system health check completed: ${systemStatus.status}`;
    } catch (error) {
      logger.error(`Error in scheduled system health check: ${error.message}`);
      return `Error in scheduled system health check: ${error.message}`;
    }
  }).catch(error => {
    logger.error(`Failed to enqueue system health check task: ${error.message}`);
  });
});

/**
 * Get current task manager status
 * @route GET /api/tasks
 * @security X-Webhook-ID
 */
router.get('/tasks', async (req, res) => {
  try {
    // Get ALL valid webhook IDs from environment variables
    const validWebhookIds = getAllValidWebhookIds();

    // Verify webhook authentication against any valid ID
    if (!validWebhookIds.includes(req.headers['x-webhook-id'])) {
      logger.warn('Unauthorized tasks request attempted');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get task status from task manager
    const taskStatus = getTaskStatus();
    
    // Convert task type numbers to readable names
    const taskTypeNames = {
      [TaskType.API_REQUEST]: 'API Request',
      [TaskType.SYSTEM_MONITORING]: 'System Monitoring',
      [TaskType.MEDIA_SCAN]: 'Media Scan',
      [TaskType.MOVIE_SCAN]: 'Movie Scan',
      [TaskType.TV_SCAN]: 'TV Show Scan',
      [TaskType.METADATA_HASH]: 'Metadata Hash',
      [TaskType.BLURHASH]: 'Blurhash',
      [TaskType.DOWNLOAD]: 'TMDB Download',
      [TaskType.CACHE_CLEANUP]: 'Cache Cleanup'
    };
    
    // Format active tasks with readable type names
    const formattedActiveTasks = taskStatus.activeTasks.map(task => ({
      id: task.id,
      type: taskTypeNames[task.type] || `Unknown (${task.type})`,
      typeValue: task.type,
      name: task.name,
      runningForMs: task.runningForMs,
      runningForSeconds: Math.floor(task.runningForMs / 1000)
    }));
    
    // Format queue sizes with readable type names
    const formattedQueues = {};
    Object.entries(taskStatus.queueSizes).forEach(([type, size]) => {
      const typeName = taskTypeNames[type] || `Unknown (${type})`;
      formattedQueues[typeName] = {
        size,
        type: parseFloat(type)
      };
    });
    
    // Format completion history with readable type names
    const formattedHistory = {};
    Object.entries(taskStatus.completionHistory || {}).forEach(([type, history]) => {
      const typeName = taskTypeNames[type] || `Unknown (${type})`;
      formattedHistory[typeName] = history.map(completion => ({
        name: completion.name,
        durationMs: completion.durationMs,
        durationSeconds: Math.floor(completion.durationMs / 1000),
        completedAt: completion.completedAt,
        completedAgo: completion.completedAgo
      }));
    });
    
    res.json({
      success: true,
      activeTasks: formattedActiveTasks,
      queueSizes: formattedQueues,
      completionHistory: formattedHistory,
      summary: {
        totalActiveTasks: formattedActiveTasks.length,
        totalQueued: Object.values(taskStatus.queueSizes).reduce((sum, count) => sum + count, 0)
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Error retrieving task status: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
