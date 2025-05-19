// lib/processRunner.mjs
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Spawn a command, log its stdout/stderr, and resolve/reject on exit.
 *
 * @param {Object} opts
 * @param {string} opts.scriptPath  – Full path to the script to run
 * @param {string[]} [opts.args]    – Any CLI args to pass
 * @param {string} opts.label       – A short label for your logger
 * @param {import('./lib/logger').Logger} opts.logger – Your category logger
 * @param {string} [opts.logFile]   – If provided and debug=true, redirect all output here
 * @param {boolean} [opts.debug]    – True to append to logFile instead of streaming to console
 * @param {NodeJS.ProcessEnv} [opts.env] – Environment variables
 */
export async function runPython({
  scriptPath,
  args = [],
  label,
  logger,
  logFile,
  debug = false,
  env = process.env,
}) {
  // choose python executable
  const python = env.PYTHON_EXECUTABLE ||
                 (process.platform === 'win32' ? 'python' : 'python3');

  // build spawn args
  const spawnArgs = [ scriptPath, ...args ];

  // if debug & logFile is writable, we'll redirect both stdout+stderr to it
  let outStream = 'pipe';
  if (debug && logFile) {
    try {
      await fs.access(logFile, fs.constants.W_OK);
      outStream = fs.openSync(logFile, 'a');
    } catch {
      logger.warn(`${label}: cannot write to ${logFile}, falling back to console`);
    }
  }

  const child = spawn(python, spawnArgs, {
    env,
    stdio: ['ignore', outStream, outStream]  // stdin, stdout, stderr
  });

  if (outStream === 'pipe') {
    child.stdout.on('data', d => logger.info(`[${label}] ${d.toString().trim()}`));
    child.stderr.on('data', d => logger.warn(`[${label}] ${d.toString().trim()}`));
  }

  return new Promise((resolve, reject) => {
    child.on('error', err => {
      logger.error(`${label}: failed to start – ${err.message}`);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        const msg = `${label}: killed by signal ${signal}`;
        logger.error(msg);
        reject(new Error(msg));
      } else if (code !== 0) {
        const msg = `${label}: exited with code ${code}`;
        logger.error(msg);
        reject(new Error(msg));
      } else {
        logger.info(`${label}: completed successfully`);
        resolve();
      }
    });
  });
}
