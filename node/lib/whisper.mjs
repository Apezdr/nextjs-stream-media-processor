import { spawn } from 'child_process';
import { promises as fs, createWriteStream } from 'fs';
import { dirname, join } from 'path';
import { pipeline } from 'stream/promises';
import { createCategoryLogger } from './logger.mjs';

const logger = createCategoryLogger('whisper');

const WHISPER_BIN = process.env.WHISPER_BIN || '/usr/local/bin/whisper-cli';
const WHISPER_MODELS_DIR = process.env.WHISPER_MODELS_DIR || '/usr/src/app/whisper-models';

/**
 * Resolve the on-disk path for a given whisper.cpp model name.
 * Accepts names like "base.en", "small.en", "medium.en".
 */
export function getModelPath(modelName) {
  return join(WHISPER_MODELS_DIR, `ggml-${modelName}.bin`);
}

export function getBinaryPath() {
  return WHISPER_BIN;
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns { binaryPresent, modelPresent, modelSizeBytes } for health reporting.
 */
export async function inspect(modelName) {
  const modelPath = getModelPath(modelName);
  const [binaryPresent, modelStat] = await Promise.all([
    fileExists(WHISPER_BIN),
    fs.stat(modelPath).catch(() => null)
  ]);

  return {
    binary: WHISPER_BIN,
    binaryPresent,
    model: modelName,
    modelPath,
    modelPresent: !!modelStat,
    modelSizeBytes: modelStat ? modelStat.size : 0
  };
}

/**
 * Download a whisper.cpp model from Hugging Face if it isn't already on disk.
 * Atomic: downloads to a .tmp file and renames on success.
 */
export async function ensureModel(modelName) {
  const modelPath = getModelPath(modelName);
  if (await fileExists(modelPath)) return modelPath;

  await fs.mkdir(dirname(modelPath), { recursive: true });

  const tmpPath = `${modelPath}.tmp`;
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelName}.bin`;

  logger.info(`Downloading whisper model "${modelName}" from ${url}`);

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed: HTTP ${response.status} for ${url}`);
  }

  try {
    await pipeline(response.body, createWriteStream(tmpPath));
    await fs.rename(tmpPath, modelPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }

  const stat = await fs.stat(modelPath);
  logger.info(`Whisper model "${modelName}" downloaded (${stat.size} bytes)`);
  return modelPath;
}

// whisper-cli logs each completed segment as `[hh:mm:ss.xxx --> hh:mm:ss.xxx] text`.
// We use the second timestamp (segment end) divided by total duration as progress.
const SEGMENT_PATTERN = /-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/g;

export function parseLatestSegmentEndSec(buffer) {
  let match;
  let last = null;
  while ((match = SEGMENT_PATTERN.exec(buffer)) !== null) {
    last = match;
  }
  if (!last) return null;
  const [, h, m, s, ms] = last;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/**
 * Run whisper-cli on a 16 kHz mono PCM WAV file and produce an SRT file.
 *
 * @param {Object} opts
 * @param {string} opts.wavPath        - Input WAV file (16 kHz mono PCM)
 * @param {string} opts.outputBase     - Output base path (whisper-cli appends .srt)
 * @param {string} opts.modelName      - e.g. "base.en"
 * @param {string} [opts.language]     - ISO 639-1 code, default "en"
 * @param {number} [opts.threads]      - CPU thread count, default 4
 * @param {number} [opts.audioDurationSec] - Total audio length, used to compute progress
 * @param {(pct: number) => void} [opts.onProgress] - Called with [0..1] as segments complete
 * @returns {Promise<string>} Path to the produced SRT file
 */
export async function transcribe({
  wavPath,
  outputBase,
  modelName,
  language = 'en',
  threads = 4,
  audioDurationSec,
  onProgress
}) {
  const modelPath = await ensureModel(modelName);

  const args = [
    '-m', modelPath,
    '-f', wavPath,
    '-l', language,
    '-t', String(threads),
    '-osrt',
    '-of', outputBase
  ];

  logger.debug(`Running whisper-cli: ${WHISPER_BIN} ${args.join(' ')}`);

  await new Promise((resolve, reject) => {
    const child = spawn(WHISPER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let progressBuffer = '';
    let lastReportedPct = -1;

    const handleChunk = chunk => {
      const text = chunk.toString();
      stderr += text;
      progressBuffer += text;
      // Cap buffer size — only the most recent chunk matters for parsing
      if (progressBuffer.length > 4096) {
        progressBuffer = progressBuffer.slice(-2048);
      }
      logger.debug(`[whisper-cli] ${text.trim()}`);

      if (onProgress && audioDurationSec && audioDurationSec > 0) {
        const endSec = parseLatestSegmentEndSec(progressBuffer);
        if (endSec !== null) {
          const pct = Math.min(1, endSec / audioDurationSec);
          // Only report when it moves at least 1% to avoid log/state thrash
          if (pct - lastReportedPct >= 0.01) {
            lastReportedPct = pct;
            try { onProgress(pct); } catch { /* ignore */ }
          }
        }
      }
    };

    // whisper-cli writes everything to stdout by default; some builds also emit to stderr.
    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('error', err => reject(new Error(`whisper-cli failed to start: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (signal) return reject(new Error(`whisper-cli killed by signal ${signal}`));
      if (code !== 0) return reject(new Error(`whisper-cli exited with code ${code}: ${stderr.slice(-500)}`));
      if (onProgress) try { onProgress(1); } catch { /* ignore */ }
      resolve();
    });
  });

  const srtPath = `${outputBase}.srt`;
  if (!(await fileExists(srtPath))) {
    throw new Error(`whisper-cli completed but no SRT file at ${srtPath}`);
  }
  return srtPath;
}
