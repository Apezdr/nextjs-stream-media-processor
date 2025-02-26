import { promises as fs } from "fs";
import { promisify } from 'util';
import { fileExists } from "./utils/utils.mjs";
import { createHash } from 'crypto';
import { exec as execCallback } from "child_process";
import { createCategoryLogger } from "./lib/logger.mjs";
import { extractHDRInfo, extractMediaQuality, getHeaderData } from "./mediaInfo/mediaInfo.mjs";
const logger = createCategoryLogger('infoFileManager');
const exec = promisify(execCallback);

// Used to determine if regenerating info is necessary
const CURRENT_VERSION = 1.0007; // Incremented for mediaQuality field

/**
 * Validates basic info object structure
 * @param {object} info - The info object to validate
 * @returns {boolean} - Whether the info object is valid
 */
function validateInfo(info) {
  const hasBasicFields = (
    typeof info.version === 'number' &&
    typeof info.length === 'number' &&
    typeof info.dimensions === 'string' &&
    (info.hdr === null || typeof info.hdr === 'string') &&
    typeof info.additionalMetadata === 'object'
  );

  // Check for mediaQuality field in newer versions
  if (info.version >= 1.0006) {
    return hasBasicFields && (
      info.mediaQuality === null || 
      (typeof info.mediaQuality === 'object' && 
       typeof info.mediaQuality.isHDR === 'boolean')
    );
  }

  return hasBasicFields;
}

/**
 * Extracts additional metadata using ffprobe.
 * @param {string} filePath - Path to the media file.
 * @returns {Promise<object>} - Returns an object with additional metadata.
 */
async function extractAdditionalMetadata(filePath) {
  try {
    const { stdout } = await exec(
      `ffprobe -v error -show_entries format=duration,size:stream=codec_name,codec_type,channels,sample_rate,bit_rate,avg_frame_rate,display_aspect_ratio -of json "${filePath}"`
    );
    const metadata = JSON.parse(stdout);

    const format = metadata.format;
    const streams = metadata.streams;

    // Extract audio stream details
    const audioStreams = streams.filter(stream => stream.codec_type === 'audio');
    const videoStreams = streams.filter(stream => stream.codec_type === 'video');

    const audioDetails = audioStreams.map(stream => ({
      codec: stream.codec_name,
      channels: stream.channels,
      sample_rate: stream.sample_rate,
      bitrate: stream.bit_rate ? parseInt(stream.bit_rate) : null
    }));

    // Extract video stream details
    const videoDetails = videoStreams.map(stream => ({
      codec: stream.codec_name,
      frame_rate: stream.avg_frame_rate,
      bitrate: stream.bit_rate ? parseInt(stream.bit_rate) : null,
      aspect_ratio: stream.display_aspect_ratio
    }));

    return {
      duration: format.duration ? Math.floor(parseFloat(format.duration) * 1000) : null, // in ms
      size: format.size ? parseInt(format.size) / 1024 : null, // in KB
      audio: audioDetails,
      video: videoDetails
    };
  } catch (error) {
    logger.error(`Error extracting additional metadata for ${episodePath}:`, error);
    return {};
  }
}

/**
 * Generates the info using ffprobe and writes it to the .info file in JSON format.
 * @param {string} filePath - Path to the media file.
 * @param {string} infoFile - Path to the .info file.
 * @returns {Promise<{length: number, dimensions: string, hdr: string|null, mediaQuality: object|null, additionalMetadata: object}>}
 */
async function generateInfo(filePath, infoFile) {
  try {
    // Extract basic metadata
    const { stdout: durationStdout } = await exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    const { stdout: dimensionsStdout } = await exec(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${filePath}"`
    );
    const fileLength = Math.floor(parseFloat(durationStdout.trim()) * 1000); // Convert to milliseconds
    const fileDimensions = dimensionsStdout.trim().replace(/x+$/, ''); // Remove any trailing x characters
    // Generate MD4 hash from headers
    const headerData = await getHeaderData(filePath);
    const headerHash = createHash('sha256').update(headerData).digest('hex');

    // Extract media quality, HDR and additional metadata
    const mediaQuality = await extractMediaQuality(filePath);
    const hdr = await extractHDRInfo(filePath);
    const additionalMetadata = await extractAdditionalMetadata(filePath);

    const info = {
      version: CURRENT_VERSION,
      uuid: headerHash,
      length: fileLength,
      dimensions: fileDimensions,
      hdr: hdr, // For backward compatibility
      mediaQuality: mediaQuality, // New structured media quality information
      additionalMetadata: additionalMetadata // Additional metadata
    };

    // Write the info to the .info file
    await fs.writeFile(infoFile, JSON.stringify(info, null, 2));
    logger.info(`Generated info for ${filePath}`);

    return info;
  } catch (error) {
    logger.error(`Error generating info for ${filePath}: ${error.message}`);
    throw error; // Rethrow to handle upstream if necessary
  }
}

/*
 * Reads the .info file and returns an object.
 * If the file does not exist or is invalid, it generates the info using ffprobe.
 * @param {string} filePath - Path to the media file.
 * @returns {Promise<{length: number, dimensions: string, hdr: string|null, mediaQuality: object|null, additionalMetadata: object}>}
 */
export async function getInfo(filePath) {
  const infoFile = `${filePath}.info`;
  let info = {};

  if (await fileExists(infoFile)) {
    try {
      const fileInfo = await fs.readFile(infoFile, 'utf-8');
      info = JSON.parse(fileInfo);
      
      // Regenerate if version is old or missing, or if basic validation fails
      if (!info.version || info.version < CURRENT_VERSION || !validateInfo(info)) {
        logger.info(`Regenerating ${infoFile} due to version update or invalid format`);
        info = await generateInfo(filePath, infoFile);
      }
    } catch (error) {
      logger.warn(`Regenerating ${infoFile} due to error:`, error);
      info = await generateInfo(filePath, infoFile);
    }
  } else {
    info = await generateInfo(filePath, infoFile);
  }

  return info;
}

/**
 * Writes the info object to the .info file in JSON format.
 * @param {string} episodePath - Path to the episode file.
 * @param {object} info - Info object containing length, dimensions, hdr, and additionalMetadata.
 * @returns {Promise<void>}
 */
export async function writeInfo(episodePath, info) {
  const infoFile = `${episodePath}.info`;
  try {
    await fs.writeFile(infoFile, JSON.stringify(info, null, 2));
    logger.info(`Updated info for ${episodePath}`);
  } catch (error) {
    logger.error(`Error writing info to ${infoFile}: ${error.message}`);
    throw error;
  }
}
