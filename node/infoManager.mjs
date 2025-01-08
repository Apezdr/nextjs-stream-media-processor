import { promises as fs } from "fs";
import { promisify } from 'util';
import { fileExists } from "./utils.mjs";
import { createHash } from 'crypto';
import { exec as execCallback } from "child_process";
import { createCategoryLogger } from "./lib/logger.mjs";
const logger = createCategoryLogger('infoFileManager');
const exec = promisify(execCallback);

// Used to determine if regenerating info is necessary
const CURRENT_VERSION = 1.0005;

/**
 * Validates basic info object structure
 * @param {object} info - The info object to validate
 * @returns {boolean} - Whether the info object is valid
 */
function validateInfo(info) {
  return (
    typeof info.version === 'number' &&
    typeof info.length === 'number' &&
    typeof info.dimensions === 'string' &&
    (info.hdr === null || typeof info.hdr === 'string') &&
    typeof info.additionalMetadata === 'object'
  );
}

/**
 * Extracts HDR information using MediaInfo.
 * @param {string} episodePath - Path to the episode file.
 * @returns {Promise<string|null>} - Returns a string of HDR types separated by commas or null if not found.
 */
export async function extractHDRInfo(episodePath) {
  try {
    const { stdout } = await exec(`mediainfo --Output=JSON "${episodePath}"`);
    const data = JSON.parse(stdout);

    const videoTracks = data.media.track.filter(t => t["@type"] === "Video");
    if (!videoTracks || videoTracks.length === 0) {
      logger.warn(`No video tracks found in ${episodePath}.`);
      return null;
    }

    const detectedHDR = new Set();

    const includesIgnoreCase = (str, substr) =>
      str && str.toLowerCase().includes(substr.toLowerCase());

    for (const videoTrack of videoTracks) {
      // Check for various HDR formats through HDR_Format field
      if (videoTrack["HDR_Format"]) {
        if (includesIgnoreCase(videoTrack["HDR_Format"], "SMPTE ST 2094-40")) {
          detectedHDR.add("HDR10+");
          continue; // HDR10+ takes precedence
        } else if (includesIgnoreCase(videoTrack["HDR_Format"], "SMPTE ST 2094")) {
          detectedHDR.add("HDR10");
        } else if (includesIgnoreCase(videoTrack["HDR_Format"], "Dolby Vision")) {
          detectedHDR.add("Dolby Vision");
        }
      }

      // Get all relevant fields with correct names
      const transferCharacteristics = videoTrack["transfer_characteristics"] || "";
      const colorSpace = videoTrack["ColorSpace"] || "";
      const colourPrimaries = videoTrack["colour_primaries"] || "";
      const masteringDisplayColorPrimaries = videoTrack["MasteringDisplay_ColorPrimaries"] || "";
      const contentLightLevel = videoTrack["MaxCLL"] || "";

      // Detect HDR10 through PQ/SMPTE 2084 transfer characteristics
      if (
        (includesIgnoreCase(transferCharacteristics, "PQ") || 
         includesIgnoreCase(transferCharacteristics, "SMPTE 2084")) &&
        includesIgnoreCase(colourPrimaries, "BT.2020")
      ) {
        if (masteringDisplayColorPrimaries && contentLightLevel) {
          detectedHDR.add("HDR10");
        }
      }

      // Check for HLG
      if (includesIgnoreCase(transferCharacteristics, "HLG")) {
        detectedHDR.add("HLG");
      }

      // Detect potential HDR based on BT.2020 color space and primaries
      if (
        (includesIgnoreCase(colorSpace, "BT.2020") || 
         includesIgnoreCase(colorSpace, "bt2020")) &&
        (includesIgnoreCase(colourPrimaries, "BT.2020") || 
         includesIgnoreCase(colourPrimaries, "bt2020"))
      ) {
        // Only add if no other HDR type detected
        if (detectedHDR.size === 0) {
          detectedHDR.add("Potential HDR (BT.2020)");
        }
      }

      // Detect SDR based on BT.709
      if (
        (includesIgnoreCase(colorSpace, "BT.709") || 
         includesIgnoreCase(colorSpace, "bt709")) &&
        (includesIgnoreCase(transferCharacteristics, "BT.709") || 
         includesIgnoreCase(transferCharacteristics, "bt709"))
      ) {
        // Only add if no HDR type detected
        if (detectedHDR.size === 0) {
          detectedHDR.add("SDR (BT.709)");
        }
      }

      // Add debug logging
      logger.debug('Video Track Analysis:', {
        HDR_Format: videoTrack["HDR_Format"],
        transfer_characteristics: transferCharacteristics,
        ColorSpace: colorSpace,
        colour_primaries: colourPrimaries,
        MasteringDisplay_ColorPrimaries: masteringDisplayColorPrimaries,
        MaxCLL: contentLightLevel
      });
    }

    if (detectedHDR.size === 0) {
      return null;
    }

    return Array.from(detectedHDR).join(', ');
  } catch (error) {
    logger.error(`Error extracting HDR info with MediaInfo for ${episodePath}:`, error);
    return null;
  }
}

/**
 * Extracts additional metadata using ffprobe.
 * @param {string} episodePath - Path to the episode file.
 * @returns {Promise<object>} - Returns an object with additional metadata.
 */
async function extractAdditionalMetadata(episodePath) {
  try {
    const { stdout } = await exec(
      `ffprobe -v error -show_entries format=duration,size:stream=codec_name,codec_type,channels,sample_rate,bit_rate,avg_frame_rate,display_aspect_ratio -of json "${episodePath}"`
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
 * Extract stable header data using MediaInfo.
 * We'll use a subset of attributes from both the General and Video tracks
 * that are likely consistent across servers if they have the same exact file.
 *
 * @param {string} episodePath - The path to the media file.
 * @returns {Promise<string>} A stable, reproducible string of header info.
 */
export async function getHeaderData(episodePath) {
  try {
    const { stdout } = await exec(`mediainfo --Output=JSON "${episodePath}"`);
    const data = JSON.parse(stdout);

    // Extract the General track
    const generalTrack = data.media.track.find(t => t["@type"] === "General");
    if (!generalTrack) {
      logger.warn(`No general track found in ${episodePath}, cannot form stable header data.`);
      return '';
    }

    // Extract the first Video track
    const videoTracks = data.media.track.filter(t => t["@type"] === "Video");
    if (videoTracks.length === 0) {
      logger.warn(`No video tracks found in ${episodePath}, cannot form stable header data.`);
      return '';
    }
    const video = videoTracks[0];

    // Attributes from General track
    // Using these fields to improve uniqueness and reliability:
    // FileSize, Duration, OverallBitRate, FrameCount
    const generalFields = [
      generalTrack.FileSize,
      generalTrack.Duration,
      generalTrack.OverallBitRate,
      generalTrack.FrameCount
    ];

    // Attributes from Video track
    // In addition to the previous fields (Format, CodecID, Width, Height, FrameRate, BitDepth, ColorSpace, ChromaSubsampling, ScanType, StreamSize)
    // we include Format_Profile, Format_Level, FrameCount, and Encoded_Library_Settings if available.
    const videoFields = [
      video.Format,
      video.CodecID,
      video.Width,
      video.Height,
      video.FrameRate,
      video.BitDepth,
      video.ColorSpace,
      video.ChromaSubsampling,
      video.ScanType,
      video.StreamSize,
      video.Format_Profile,
      video.Format_Level,
      video.FrameCount,
      video.Encoded_Library_Settings
    ];

    // Combine all fields
    const stableFields = [...generalFields, ...videoFields]
      .filter(Boolean) // Remove undefined or null values
      .join('|');

    return stableFields;
  } catch (error) {
    logger.error(`Error extracting header data with MediaInfo for ${episodePath}: ${error.message}`);
    return '';
  }
}

/**
 * Generates the info using ffprobe and writes it to the .info file in JSON format.
 * @param {string} episodePath - Path to the episode file.
 * @param {string} infoFile - Path to the .info file.
 * @returns {Promise<{length: number, dimensions: string, hdr: string|null, additionalMetadata: object}>}
 */
async function generateInfo(episodePath, infoFile) {
  try {
    // Extract basic metadata
    const { stdout: durationStdout } = await exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${episodePath}"`
    );
    const { stdout: dimensionsStdout } = await exec(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${episodePath}"`
    );
    const fileLength = Math.floor(parseFloat(durationStdout.trim()) * 1000); // Convert to milliseconds
    const fileDimensions = dimensionsStdout.trim().replace(/x+$/, ''); // Remove any trailing x characters
    // Generate MD4 hash from headers
    const headerData = await getHeaderData(episodePath);
    const headerHash = createHash('sha256').update(headerData).digest('hex');

    // Extract HDR and additional metadata
    const hdr = await extractHDRInfo(episodePath);
    const additionalMetadata = await extractAdditionalMetadata(episodePath);

    const info = {
      version: CURRENT_VERSION,
      uuid: headerHash,
      length: fileLength,
      dimensions: fileDimensions,
      hdr: hdr, // Enhanced HDR information
      additionalMetadata: additionalMetadata // Additional metadata
    };

    // Write the info to the .info file
    await fs.writeFile(infoFile, JSON.stringify(info, null, 2));
    logger.info(`Generated info for ${episodePath}`);

    return info;
  } catch (error) {
    logger.error(`Error generating info for ${episodePath}:`, error);
    throw error; // Rethrow to handle upstream if necessary
  }
}

/*
 * Reads the .info file and returns an object.
 * If the file does not exist or is invalid, it generates the info using ffprobe.
 * @param {string} episodePath - Path to the episode file.
 * @returns {Promise<{length: number, dimensions: string, hdr: string|null, additionalMetadata: object}>}
 */
export async function getInfo(episodePath) {
  const infoFile = `${episodePath}.info`;
  let info = {};

  if (await fileExists(infoFile)) {
    try {
      const fileInfo = await fs.readFile(infoFile, 'utf-8');
      info = JSON.parse(fileInfo);
      
      // Regenerate if version is old or missing, or if basic validation fails
      if (!info.version || info.version < CURRENT_VERSION || !validateInfo(info)) {
        logger.info(`Regenerating ${infoFile} due to version update or invalid format`);
        info = await generateInfo(episodePath, infoFile);
      }
    } catch (error) {
      logger.warn(`Regenerating ${infoFile} due to error:`, error);
      info = await generateInfo(episodePath, infoFile);
    }
  } else {
    info = await generateInfo(episodePath, infoFile);
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
    logger.error(`Error writing info to ${infoFile}:`, error);
    throw error;
  }
}