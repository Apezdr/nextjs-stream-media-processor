// ffmpeg/ffprobe.mjs
// This module provides functions to interact with ffprobe for video metadata extraction.
import { createCategoryLogger } from "../lib/logger.mjs";
import { execFileAsync } from "../utils/utils.mjs"; // Make sure this is correctly imported and promisifies execFile
import path from "path";

let ffprobeBinary = process.env.FFPROBE_BINARY;

if (!ffprobeBinary) {
  // Default to common locations
  ffprobeBinary = process.platform === "win32"
    ? path.join("C:", "ffmpeg", "bin", "ffprobe.exe")
    : path.join("/usr", "bin", "ffprobe");
} else {
  // Normalize path for current OS
  ffprobeBinary = path.normalize(ffprobeBinary);
}

const logger = createCategoryLogger('ffprobe');

/**
 * Checks if the given video file is HDR.
 * @param {string} videoPath - Path to the video file.
 * @returns {Promise<boolean>} - Resolves to true if HDR, else false.
 */
export async function isVideoHDR(videoPath) {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=color_space,color_transfer,color_primaries",
    "-of", "default=noprint_wrappers=1",
    videoPath // No quoting needed here!
  ];

  try {
    // Use execFileAsync
    const { stdout } = await execFileAsync(ffprobeBinary, args);

    const output = stdout.toLowerCase();
    // Common HDR transfer characteristics
    const hdrTransferCharacteristics = ['smpte2084', 'arib-std-b67'];
    const transferCharacteristic = output.match(/color_transfer=([^\r\n]+)/);
    const isTransferHDR =
      transferCharacteristic &&
      hdrTransferCharacteristics.includes(transferCharacteristic[1].trim());

    return Boolean(isTransferHDR);
  } catch (error) {
    logger.error(`ffprobe error for HDR check: ${error.message || error.stderr}`);
    throw error; // Re-throw to propagate the error
  }
}

/**
 * Gets the duration of the specified video file.
 * @param {string} videoPath - The path to the video file.
 * @returns {Promise<number>} - The duration of the video in seconds.
 */
export async function getVideoDuration(videoPath) {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    videoPath
  ];

  try {
    // Use execFileAsync
    const { stdout } = await execFileAsync(ffprobeBinary, args);
    const duration = parseFloat(stdout.trim());
    if (!isNaN(duration)) {
      return duration;
    } else {
      throw new Error('Failed to parse video duration.');
    }
  } catch (error) {
    logger.error(`Error getting video duration: ${error.message || error.stderr}`);
    throw error;
  }
}

/**
 * Estimates the keyframe (GOP) interval of a video in seconds by decoding only
 * the keyframes inside a short sample window. I/O and decode cost are bounded
 * by the window size, so this is cheap even on very large files.
 * @param {string} videoPath - The path to the video file.
 * @param {object} [options]
 * @param {number} [options.sampleAt=60] - Position in seconds to sample from.
 * @param {number} [options.windowSeconds=15] - Length of the sample window.
 * @returns {Promise<number|null>} - Estimated seconds between keyframes;
 *   Infinity when fewer than two keyframes appear in the window (GOP longer
 *   than the window); null if the probe itself failed.
 */
export async function estimateKeyframeInterval(videoPath, { sampleAt = 60, windowSeconds = 15 } = {}) {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-skip_frame", "nokey",
    "-show_entries", "frame=pts_time",
    "-of", "csv=p=0",
    "-read_intervals", `${sampleAt}%+${windowSeconds}`,
    videoPath
  ];

  try {
    const { stdout } = await execFileAsync(ffprobeBinary, args);
    // ffprobe can emit frames out of presentation order around a seek point
    const times = stdout
      .split(/\r?\n/)
      .map((line) => parseFloat(line))
      .filter((t) => !isNaN(t))
      .sort((a, b) => a - b);

    if (times.length < 2) {
      // A whole window with at most one keyframe: the GOP is longer than the
      // window. Distinct from null, which means the probe itself failed.
      return Number.POSITIVE_INFINITY;
    }

    const diffs = [];
    for (let i = 1; i < times.length; i++) {
      diffs.push(times[i] - times[i - 1]);
    }
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    return avg > 0 ? avg : null;
  } catch (error) {
    logger.warn(`Failed to estimate keyframe interval for ${videoPath}: ${error.message || error.stderr}`);
    return null;
  }
}

/**
 * Checks if the given media file has chapter information.
 * @param {string} mediaPath - The path to the media file.
 * @returns {Promise<Array<object>|null>} - Resolves to an array of chapter objects if the media file has chapter information, null otherwise.
 */
export async function chapterInfo(mediaPath) {
  // Define arguments as an array of strings
  const args = [
    "-show_entries",
    "chapter=start_time,metadata",
    "-print_format",
    "json",
    "-v",
    "quiet",
    mediaPath // No quotes needed here! execFileAsync handles this.
  ];

  try {
    // Use execFileAsync
    const { stdout } = await execFileAsync(ffprobeBinary, args);

    const ffprobeOutput = JSON.parse(stdout);
    if (ffprobeOutput.chapters && ffprobeOutput.chapters.length > 0) {
      return ffprobeOutput.chapters;
    } else {
      return null;
    }
  } catch (err) {
    logger.error(`Error checking chapter information for ${mediaPath}: ${err.message || err.stderr}`);
    throw err;
  }
}

export async function getVideoCodec(videoPath) {
    const args = [
        "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        videoPath
    ];
    try {
      // Use execFileAsync
      const { stdout } = await execFileAsync(ffprobeBinary, args);
      const metadata = JSON.parse(stdout);
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      return videoStream ? videoStream.codec_name.toLowerCase() : false;
    } catch (error) {
      logger.warn(`Failed to get video codec: ${error.message || error.stderr}`);
      return false; // Treat as no codec found
    }
}

/**
 * Retrieves the audio tracks from the specified video file.
 * @param {string} videoPath - The path to the video file.
 * @returns {Promise<Array<{ index: number, codec: string, channels: number }>} - A promise that resolves to an array of audio track objects, containing the index, codec, and number of channels for each audio track.
 */
export async function getAudioTracks(videoPath) {
  const args = [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    videoPath
  ];

  try {
    // Use execFileAsync
    const { stdout } = await execFileAsync(ffprobeBinary, args);
    const output = JSON.parse(stdout);
    // filter for audio streams
    const audioStreams = output.streams.filter((stream) => stream.codec_type === "audio");

    // Map to desired output format. Reverted `index` to original ffprobe index.
    const audioTracks = audioStreams.map((stream) => ({
      index: stream.index, // Use original ffprobe index for robustness
      codec: stream.codec_name,
      channels: stream.channels,
    }));

    return audioTracks;
  } catch (error) {
    logger.error(`Error getting audio tracks: ${error.message || error.stderr}`);
    throw error;
  }
}
