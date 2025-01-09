import { exec } from "child_process";
import { createCategoryLogger } from "../lib/logger.mjs";
import { execAsync } from "../utils/utils.mjs";
const ffprobeBinary = '/usr/bin/ffprobe';

const logger = createCategoryLogger('ffprobe');

/**
 * Checks if the given video file is HDR.
 * @param {string} videoPath - Path to the video file.
 * @returns {Promise<boolean>} - Resolves to true if HDR, else false.
 */
export async function isVideoHDR(videoPath) {
    return new Promise((resolve, reject) => {
      const command = `${ffprobeBinary} -v error -select_streams v:0 -show_entries stream=color_space,color_transfer,color_primaries -of default=noprint_wrappers=1 "${videoPath}"`;
      exec(command, (error, stdout, stderr) => {
        if (error) {
          logger.error(`ffprobe error: ${stderr}`);
          return reject(error);
        }
  
        const output = stdout.toLowerCase();
        // Common HDR transfer characteristics
        const hdrTransferCharacteristics = ['smpte2084', 'arib-std-b67'];
        const transferCharacteristic = output.match(/color_transfer=([^\n]+)/);
        const isTransferHDR =
          transferCharacteristic &&
          hdrTransferCharacteristics.includes(transferCharacteristic[1]);
  
        resolve(Boolean(isTransferHDR));
      });
    });
}

/**
 * Gets the duration of the specified video file.
 * @param {string} videoPath - The path to the video file.
 * @returns {Promise<number>} - The duration of the video in seconds.
 */
export function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const ffprobeCommand = `${ffprobeBinary} -v error -select_streams v:0 -show_entries stream=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
    exec(ffprobeCommand, (error, stdout, stderr) => {
      if (error) {
        logger.error(`Error getting video duration: ${error.message}`);
        reject(error);
      } else {
        const duration = parseFloat(stdout.trim());
        if (!isNaN(duration)) {
          resolve(duration);
        } else {
          reject(new Error('Failed to parse video duration.'));
        }
      }
    });
  });
}

/**
 * Checks if the given media file has chapter information.
 * @param {string} mediaPath - The path to the media file.
 * @returns {Promise<Array<object>|null>} - Resolves to an array of chapter objects if the media file has chapter information, null otherwise.
 */
export async function chapterInfo(mediaPath) {
  return new Promise((resolve, reject) => {
    const ffprobeCommand = `${ffprobeBinary} -show_entries chapter=start_time,metadata -print_format json -v quiet '${mediaPath.replace(/'/g, "'\\''")}'`;

    exec(ffprobeCommand, (error, stdout, stderr) => {
      if (error) {
        logger.error(`Error checking chapter information for ${mediaPath}:`, error);
        reject(error);
        return;
      }

      try {
        const ffprobeOutput = JSON.parse(stdout);
        if (ffprobeOutput.chapters && ffprobeOutput.chapters.length > 0) {
          resolve(ffprobeOutput.chapters);
        } else {
          resolve(null);
        }
      } catch (err) {
        logger.error(`Error parsing ffprobe output for ${mediaPath}:`, err);
        reject(err);
      }
    });
  });
}

export async function getVideoCodec(videoPath) {
    const probeCmd = `ffprobe -v quiet -print_format json -show_streams "${videoPath.replace(/"/g, '\\"')}"`;
    try {
      const { stdout } = await execAsync(probeCmd);
      const metadata = JSON.parse(stdout);
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      return videoStream.codec_name.toLowerCase(); // e.g., 'h264'
    } catch (error) {
      logger.warn(`Failed to get video codec: ${error.message}`);
      return false; // Treat as no codec found
    }
}

/**
 * Retrieves the audio tracks from the specified video file.
 * @param {string} videoPath - The path to the video file.
 * @returns {Promise<Array<{ index: number, codec: string, channels: number }>} - A promise that resolves to an array of audio track objects, containing the index, codec, and number of channels for each audio track.
 */
export async function getAudioTracks(videoPath) {
  return new Promise((resolve, reject) => {
    const command = `ffprobe -v quiet -print_format json -show_streams "${videoPath}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        logger.error(`Error getting audio tracks: ${error.message}`);
        reject(error);
      } else {
        const output = JSON.parse(stdout);
        const videoStreams = output.streams.filter((stream) => stream.codec_type === "video");
        const audioStreams = output.streams.filter((stream) => stream.codec_type === "audio");

        const videoTrackCount = videoStreams.length;

        const audioTracks = audioStreams.map((stream) => ({
          index: stream.index - videoTrackCount,
          codec: stream.codec_name,
          channels: stream.channels,
        }));

        resolve(audioTracks);
      }
    });
  });
}