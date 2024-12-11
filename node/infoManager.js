const fs = require("fs").promises;
const util = require('util');
const { fileExists } = require("./utils");
const crypto = require('crypto');
const exec = util.promisify(require("child_process").exec);
const execAsync = util.promisify(exec);

// Used to determine if regenerating info is necessary
const CURRENT_VERSION = 1.0002;

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
async function extractHDRInfo(episodePath) {
  try {
    // Execute MediaInfo with JSON output
    const { stdout } = await exec(`mediainfo --Output=JSON "${episodePath}"`);
    const data = JSON.parse(stdout);

    // Find all Video tracks
    const videoTracks = data.media.track.filter(t => t["@type"] === "Video");
    if (!videoTracks || videoTracks.length === 0) {
      console.warn(`No video tracks found in ${episodePath}.`);
      return null;
    }

    const detectedHDR = new Set(); // Use Set to avoid duplicates

    // Function to perform case-insensitive substring check
    const includesIgnoreCase = (str, substr) =>
      str && str.toLowerCase().includes(substr.toLowerCase());

    // Iterate through each Video track to detect HDR formats
    for (const videoTrack of videoTracks) {
      // Check for HDR10+
      if (
        videoTrack["HDR_Format_Compatibility"] &&
        includesIgnoreCase(videoTrack["HDR_Format_Compatibility"], "HDR10+")
      ) {
        detectedHDR.add("HDR10+");
        continue; // HDR10+ takes precedence; no need to check further
      }

      // Check for HDR10
      if (
        videoTrack["HDR_Format_Compatibility"] &&
        includesIgnoreCase(videoTrack["HDR_Format_Compatibility"], "HDR10")
      ) {
        detectedHDR.add("HDR10");
      }

      // Check for Dolby Vision
      if (
        videoTrack["HDR_Format_Compatibility"] &&
        includesIgnoreCase(videoTrack["HDR_Format_Compatibility"], "Dolby Vision")
      ) {
        detectedHDR.add("Dolby Vision");
      }

      // Check for HLG (Hybrid Log-Gamma)
      if (
        videoTrack["HDR_Format_Compatibility"] &&
        includesIgnoreCase(videoTrack["HDR_Format_Compatibility"], "HLG")
      ) {
        detectedHDR.add("HLG");
      }

      // Additional checks based on transfer characteristics and color space
      const transferCharacteristics = videoTrack["transfer_characteristics"] || "";
      const colorSpace = videoTrack["ColorSpace"] || "";
      const colorPrimaries = videoTrack["ColorPrimaries"] || "";
      const masteringDisplayColorPrimaries = videoTrack["MasteringDisplay_ColorPrimaries"] || "";
      const contentLightLevel = videoTrack["MaxCLL"] || "";

      // Detect HDR10 based on transfer characteristics and color space if not already detected
      if (
        includesIgnoreCase(transferCharacteristics, "smpte2084") &&
        includesIgnoreCase(colorSpace, "bt2020")
      ) {
        if (masteringDisplayColorPrimaries && contentLightLevel) {
          detectedHDR.add("HDR10");
        }
      }

      // Detect potential HDR based on BT.2020 color space and primaries
      if (
        includesIgnoreCase(colorSpace, "bt2020") &&
        includesIgnoreCase(colorPrimaries, "bt2020")
      ) {
        detectedHDR.add("Potential HDR (BT.2020)");
      }

      // Detect SDR based on BT.709 color space and transfer characteristics
      if (
        includesIgnoreCase(colorSpace, "bt.709") &&
        includesIgnoreCase(transferCharacteristics, "bt.709")
      ) {
        detectedHDR.add("SDR (BT.709)");
      }
    }

    if (detectedHDR.size === 0) {
      return null; // No HDR detected
    }

    // Convert the Set to an Array and join into a single string
    return Array.from(detectedHDR).join(', ');
  } catch (error) {
    console.error(`Error extracting HDR info with MediaInfo for ${episodePath}:`, error);
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
    console.error(`Error extracting additional metadata for ${episodePath}:`, error);
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
async function getHeaderData(episodePath) {
  try {
    const { stdout } = await execAsync(`mediainfo --Output=JSON "${episodePath}"`);
    const data = JSON.parse(stdout);

    // Extract the General track
    const generalTrack = data.media.track.find(t => t["@type"] === "General");
    if (!generalTrack) {
      console.warn(`No general track found in ${episodePath}, cannot form stable header data.`);
      return '';
    }

    // Extract the first Video track
    const videoTracks = data.media.track.filter(t => t["@type"] === "Video");
    if (videoTracks.length === 0) {
      console.warn(`No video tracks found in ${episodePath}, cannot form stable header data.`);
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
    console.error(`Error extracting header data with MediaInfo for ${episodePath}:`, error);
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
    const fileDimensions = dimensionsStdout.trim();

    // Generate MD4 hash from headers
    const headerData = await getHeaderData(episodePath);
    const headerHash = crypto.createHash('sha256').update(headerData).digest('hex');

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
    console.log(`Generated info for ${episodePath}`);

    return info;
  } catch (error) {
    console.error(`Error generating info for ${episodePath}:`, error);
    throw error; // Rethrow to handle upstream if necessary
  }
}

/*
 * Reads the .info file and returns an object.
 * If the file does not exist or is invalid, it generates the info using ffprobe.
 * @param {string} episodePath - Path to the episode file.
 * @returns {Promise<{length: number, dimensions: string, hdr: string|null, additionalMetadata: object}>}
 */
async function getInfo(episodePath) {
  const infoFile = `${episodePath}.info`;
  let info = {};

  if (await fileExists(infoFile)) {
    try {
      const fileInfo = await fs.readFile(infoFile, 'utf-8');
      info = JSON.parse(fileInfo);
      
      // Regenerate if version is old or missing, or if basic validation fails
      if (!info.version || info.version < CURRENT_VERSION || !validateInfo(info)) {
        console.log(`Regenerating ${infoFile} due to version update or invalid format`);
        info = await generateInfo(episodePath, infoFile);
      }
    } catch (error) {
      console.warn(`Regenerating ${infoFile} due to error:`, error);
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
async function writeInfo(episodePath, info) {
  const infoFile = `${episodePath}.info`;
  try {
    await fs.writeFile(infoFile, JSON.stringify(info, null, 2));
    console.log(`Updated info for ${episodePath}`);
  } catch (error) {
    console.error(`Error writing info to ${infoFile}:`, error);
    throw error;
  }
}

module.exports = {
  getHeaderData,
  extractHDRInfo,
  getInfo,
  writeInfo,
  fileExists
};
