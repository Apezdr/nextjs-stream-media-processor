import Piscina from "piscina";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import os from "os";
import { createCategoryLogger } from "./logger.mjs";
import { getMeter } from "./metrics.mjs";
import {
  withWorkerSpan,
  withPoolInitSpan,
  withPoolShutdownSpan,
  registerWorkerPoolMetrics,
} from "./workerTracer.mjs";

const logger = createCategoryLogger("blurhash-pool");
const __dirname = dirname(fileURLToPath(import.meta.url));

// Environment-driven configuration with sensible defaults
const POOL_CONFIG = {
  // Conservative sizing: leave headroom for Sharp's thread pool
  minThreads: Number(process.env.BLURHASH_MIN_THREADS) || 1,
  maxThreads:
    Number(process.env.BLURHASH_MAX_THREADS) ||
    Math.max(2, Math.min(4, os.cpus().length - 2)),

  // Idle timeout: clean up workers when not scanning (60 seconds)
  idleTimeout: Number(process.env.BLURHASH_IDLE_TIMEOUT) || 60000,

  // Task timeout: fail fast if worker hangs (30 seconds)
  taskTimeout: Number(process.env.BLURHASH_TASK_TIMEOUT) || 30000,

  // Piscina auto-manages queue size (threads^2 by default)
  // We'll use p-limit at the caller level for better control
};

logger.info(`Initializing blurhash worker pool with config:`, {
  minThreads: POOL_CONFIG.minThreads,
  maxThreads: POOL_CONFIG.maxThreads,
  idleTimeout: POOL_CONFIG.idleTimeout,
  cpus: os.cpus().length,
  workerPath: resolve(__dirname, "../workers/blurhash-worker.mjs"),
});

// Initialize Piscina pool with tracing
const poolPath = resolve(__dirname, "../workers/blurhash-worker.mjs");
const pool = withPoolInitSpan(
  {
    name: "blurhash",
    minThreads: POOL_CONFIG.minThreads,
    maxThreads: POOL_CONFIG.maxThreads,
    filename: poolPath,
  },
  () => {
    const newPool = new Piscina({
      filename: poolPath,
      ...POOL_CONFIG,
    });
    return newPool;
  },
);

// Track pool initialization promise for health checks
let poolReady = false;
pool.on("ready", () => {
  poolReady = true;
  logger.info("Blurhash worker pool is ready");
});

pool.on("worker created", () => {
  logger.debug("New blurhash worker created");
});

pool.on("worker destroyed", () => {
  logger.debug("Blurhash worker destroyed");
});

// Export metrics for monitoring
export const poolMetrics = {
  get ready() {
    return poolReady;
  },
  get queueSize() {
    return pool.queueSize;
  },
  get completed() {
    return pool.completed;
  },
  get waitTime() {
    return pool.waitTime;
  },
  get runTime() {
    return pool.runTime;
  },
  get utilization() {
    return pool.utilization;
  },
  get threads() {
    return {
      min: POOL_CONFIG.minThreads,
      max: POOL_CONFIG.maxThreads,
      active: pool.threads?.length || 0,
    };
  },
  get config() {
    return { ...POOL_CONFIG };
  },
};

// Register OpenTelemetry metrics
const meter = getMeter("blurhash-pool");
const workerQueueGauge = meter.createObservableGauge("worker.queue_depth", {
  description: "Worker queue depth",
  unit: "1",
});

// Add callback to observe queue metrics
workerQueueGauge.addCallback(registerWorkerPoolMetrics(pool, "blurhash"));

/**
 * Execute a blurhash operation in the worker pool
 * @param {Object} task - Task to execute
 * @param {Object} options - Piscina options
 * @returns {Promise} Result from worker
 */
export async function runBlurhashTask(task, options = {}) {
  return withWorkerSpan(
    {
      type: "blurhash",
      operation: task.operation || "encode",
      poolName: "blurhash-pool",
      queueSize: pool.queueSize,
      utilization: pool.utilization,
      taskId:
        task.id ||
        `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    },
    async () => {
      try {
        return await pool.run(task, options);
      } catch (error) {
        logger.error(`Blurhash pool task failed: ${error.message}`, {
          task: task.operation,
        });
        throw error;
      }
    },
  );
}

/**
 * Gracefully destroy the pool
 * Called during application shutdown
 */
export async function destroyPool() {
  if (pool) {
    return withPoolShutdownSpan(
      {
        name: "blurhash",
        activeThreads: pool.threads?.length || 0,
        completedTasks: pool.completed,
      },
      async () => {
        logger.info("Destroying blurhash worker pool...");
        await pool.destroy();
        poolReady = false;
        logger.info("Blurhash worker pool destroyed");
      },
    );
  }
}

// Export the pool for direct access if needed
export { pool };

// Handle unhandled pool errors
pool.on("error", (error) => {
  logger.error("Blurhash worker pool error:", error);
});

export default {
  pool,
  poolMetrics,
  runBlurhashTask,
  destroyPool,
};
