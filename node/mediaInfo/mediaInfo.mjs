import { createCategoryLogger } from "../lib/logger.mjs";
import { execAsync } from "../utils/utils.mjs";

const logger = createCategoryLogger('mediaInfo');

/**
 * Helper function to check if a string includes a substring, case-insensitive
 * @param {string} str - The string to check
 * @param {string} substr - The substring to look for
 * @returns {boolean} - Whether the string includes the substring
 */
const includesIgnoreCase = (str, substr) =>
  str && str.toLowerCase().includes(substr.toLowerCase());

/**
 * Extract stable header data using MediaInfo.
 * We'll use a subset of attributes from both the General and Video tracks
 * that are likely consistent across servers if they have the same exact file.
 *
 * @param {string} filePath - The path to the media file.
 * @returns {Promise<string>} A stable, reproducible string of header info.
 */
export async function getHeaderData(filePath) {
  try {
    const { stdout } = await execAsync(`mediainfo --Output=JSON "${filePath}"`);
    const data = JSON.parse(stdout);

    // Extract the General track
    const generalTrack = data.media.track.find(t => t["@type"] === "General");
    if (!generalTrack) {
      logger.warn(`No general track found in ${filePath}, cannot form stable header data.`);
      return '';
    }

    // Extract the first Video track
    const videoTracks = data.media.track.filter(t => t["@type"] === "Video");
    if (videoTracks.length === 0) {
      logger.warn(`No video tracks found in ${filePath}, cannot form stable header data.`);
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
    logger.error(`Error extracting header data with MediaInfo for ${filePath}: ${error.message}`);
    return '';
  }
}

/**
 * MediaInfo lists an MP4's embedded cover art as an extra Video track: one JPEG
 * or PNG frame. It describes no part of the picture.
 */
const STILL_IMAGE_FORMATS = new Set(["JPEG", "PNG", "BMP", "GIF", "TIFF", "WebP"]);

const parseBitDepth = (track) => track["BitDepth"] ? parseInt(track["BitDepth"]) : null;

const transferOf = (track) =>
  track["transfer_characteristics"] || track["TransferCharacteristics"] || "";

/**
 * Derives the mediaQuality object from a file's MediaInfo Video tracks.
 *
 * HDR labels are collected across every picture track, since a Dolby Vision
 * enhancement layer can carry its own signalling. bitDepth, colorSpace and
 * transferCharacteristics describe the main picture, so they come from the
 * first picture track only. They used to come from the last track, which let
 * an MP4's cover-art JPEG blank the transfer and report the file as 8-bit.
 *
 * @param {object[]} videoTracks - MediaInfo tracks with @type "Video"; at least one.
 * @returns {object} mediaQuality
 */
export function analyzeVideoTracks(videoTracks) {
  const pictureTracks = videoTracks.filter(t => !STILL_IMAGE_FORMATS.has(t["Format"]));
  // A file whose only video track uses an image codec (Motion JPEG) is still video.
  const tracks = pictureTracks.length > 0 ? pictureTracks : videoTracks;

  const detectedHDR = new Set();

  for (const videoTrack of tracks) {
    const bitDepth = parseBitDepth(videoTrack);
    const encodingSettings = videoTrack["Encoded_Library_Settings"] || "";
    const transferCharacteristics = transferOf(videoTrack);
    const colorSpace = videoTrack["ColorSpace"] || "";
    const colourPrimaries = videoTrack["colour_primaries"] || videoTrack["ColorPrimaries"] || "";
    const masteringDisplayColorPrimaries = videoTrack["MasteringDisplay_ColorPrimaries"] || "";
    const contentLightLevel = videoTrack["MaxCLL"] || "";

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

    // Check for Dolby Vision through other fields
    if (
      videoTrack["Format_Profile"]?.includes("Dolby Vision") ||
      videoTrack["Format_Commercial"]?.includes("Dolby Vision") ||
      videoTrack["CodecID"]?.startsWith("dva")
    ) {
      detectedHDR.add("Dolby Vision");
    }

    // PQ over BT.2020 is HDR10. Mastering-display data and MaxCLL are optional
    // static metadata that many UHD remuxes omit, so they don't gate the label.
    // Dolby Vision profile 5 reports the same PQ and BT.2020, but its base layer
    // is IPTPQc2 rather than HDR10, so a player without Dolby Vision can't show it.
    if (
      (includesIgnoreCase(transferCharacteristics, "PQ") ||
       includesIgnoreCase(transferCharacteristics, "SMPTE 2084")) &&
      includesIgnoreCase(colourPrimaries, "BT.2020") &&
      !includesIgnoreCase(videoTrack["HDR_Format_Profile"], "dvhe.05")
    ) {
      detectedHDR.add("HDR10");
    }

    // Check for HLG
    if (includesIgnoreCase(transferCharacteristics, "HLG")) {
      detectedHDR.add("HLG");
    }

    // Explicitly detect 10-bit SDR
    if (
      bitDepth === 10 &&
      (includesIgnoreCase(colorSpace, "BT.709") || includesIgnoreCase(colourPrimaries, "BT.709")) &&
      (includesIgnoreCase(transferCharacteristics, "BT.709") || transferCharacteristics === "2") &&
      detectedHDR.size === 0 &&
      !encodingSettings.includes("no-hdr")
    ) {
      detectedHDR.add("10-bit SDR (BT.709)");
    }

    // Standard 8-bit SDR detection
    if (
      (bitDepth === 8 || bitDepth === null) &&
      (includesIgnoreCase(colorSpace, "BT.709") || includesIgnoreCase(colourPrimaries, "BT.709")) &&
      detectedHDR.size === 0
    ) {
      detectedHDR.add("8-bit SDR (BT.709)");
    }

    // Check if HDR is explicitly disabled in encoding settings
    if (encodingSettings.includes("no-hdr") && detectedHDR.size === 0) {
      if (bitDepth === 10) {
        detectedHDR.add("10-bit SDR (BT.709)");
      } else {
        detectedHDR.add("8-bit SDR (BT.709)");
      }
    }

    // Add debug logging
    logger.debug('Video Track Analysis:', {
      HDR_Format: videoTrack["HDR_Format"],
      transfer_characteristics: transferCharacteristics,
      ColorSpace: colorSpace,
      colour_primaries: colourPrimaries,
      BitDepth: bitDepth,
      MasteringDisplay_ColorPrimaries: masteringDisplayColorPrimaries,
      MaxCLL: contentLightLevel,
      EncodingSettings: encodingSettings ? "Present" : "Not present"
    });
  }

  const primary = tracks[0];
  const bitDepth = parseBitDepth(primary);

  const formatString = detectedHDR.size > 0 ? Array.from(detectedHDR).join(', ') : null;
  const isHDR = detectedHDR.size > 0 &&
               !Array.from(detectedHDR).some(format =>
                  format.includes("SDR") || format.includes("8-bit") || format.includes("10-bit SDR"));

  return {
    format: formatString,
    bitDepth: bitDepth,
    colorSpace: primary["ColorSpace"] || "",
    transferCharacteristics: transferOf(primary),
    isHDR: isHDR,
    viewingExperience: {
      enhancedColor: bitDepth === 10 || isHDR,
      highDynamicRange: isHDR,
      dolbyVision: detectedHDR.has("Dolby Vision"),
      hdr10Plus: detectedHDR.has("HDR10+"),
      standardHDR: detectedHDR.has("HDR10") || detectedHDR.has("HLG")
    }
  };
}

/**
 * Extracts media quality information using MediaInfo.
 * @param {string} filePath - Path to the media file.
 * @returns {Promise<object|null>} - Returns an object with format and quality information or null if not found.
 */
export async function extractMediaQuality(filePath) {
  try {
    const { stdout } = await execAsync(`mediainfo --Output=JSON "${filePath}"`);
    const data = JSON.parse(stdout);

    const videoTracks = data.media.track.filter(t => t["@type"] === "Video");
    if (!videoTracks || videoTracks.length === 0) {
      logger.warn(`No video tracks found in ${filePath}.`);
      return null;
    }

    return analyzeVideoTracks(videoTracks);
  } catch (error) {
    logger.error(`Error extracting media quality info with MediaInfo for ${filePath}:` + error);
    return null;
  }
}

/**
 * Extracts HDR information using MediaInfo.
 * @param {string} filePath - Path to the media file.
 * @returns {Promise<string|null>} - Returns a string of HDR types separated by commas or null if not found.
 */
export async function extractHDRInfo(filePath) {
  try {
    const mediaQuality = await extractMediaQuality(filePath);
    
    if (!mediaQuality || !mediaQuality.format) {
      return null;
    }
    
    // If it's not HDR but it's 10-bit SDR, return that
    if (!mediaQuality.isHDR && mediaQuality.format && mediaQuality.format.includes("10-bit SDR")) {
      return mediaQuality.format;
    }
    
    // If it's not HDR and not 10-bit SDR, return null
    if (!mediaQuality.isHDR) {
      return null;
    }
    
    return mediaQuality.format;
  } catch (error) {
    logger.error(`Error in extractHDRInfo for ${filePath}:` + error);
    return null;
  }
}

/**
 * Derive HDR string from an already-computed mediaQuality object (no subprocess).
 * @param {object|null} mediaQuality - Result from extractMediaQuality or getMediaInfoCombined
 * @returns {string|null}
 */
export function deriveHDRFromQuality(mediaQuality) {
  if (!mediaQuality || !mediaQuality.format) return null;
  if (!mediaQuality.isHDR && mediaQuality.format.includes("10-bit SDR")) return mediaQuality.format;
  if (!mediaQuality.isHDR) return null;
  return mediaQuality.format;
}

/**
 * Combined extraction: runs mediainfo once and returns headerData + mediaQuality + hdr.
 * Replaces separate calls to getHeaderData(), extractMediaQuality(), and extractHDRInfo()
 * reducing 3 mediainfo subprocess invocations to 1.
 *
 * @param {string} filePath - The path to the media file.
 * @returns {Promise<{headerData: string, mediaQuality: object|null, hdr: string|null}>}
 */
export async function getMediaInfoCombined(filePath) {
  try {
    const { stdout } = await execAsync(`mediainfo --Output=JSON "${filePath}"`);
    const data = JSON.parse(stdout);

    // --- Header data extraction (from getHeaderData logic) ---
    let headerData = '';
    const generalTrack = data.media.track.find(t => t["@type"] === "General");
    const videoTracks = data.media.track.filter(t => t["@type"] === "Video");

    if (generalTrack && videoTracks.length > 0) {
      const video = videoTracks[0];
      const generalFields = [
        generalTrack.FileSize,
        generalTrack.Duration,
        generalTrack.OverallBitRate,
        generalTrack.FrameCount
      ];
      const videoFields = [
        video.Format, video.CodecID, video.Width, video.Height,
        video.FrameRate, video.BitDepth, video.ColorSpace,
        video.ChromaSubsampling, video.ScanType, video.StreamSize,
        video.Format_Profile, video.Format_Level, video.FrameCount,
        video.Encoded_Library_Settings
      ];
      headerData = [...generalFields, ...videoFields].filter(Boolean).join('|');
    }

    // --- Media quality extraction ---
    const mediaQuality = videoTracks.length > 0 ? analyzeVideoTracks(videoTracks) : null;

    const hdr = deriveHDRFromQuality(mediaQuality);

    return { headerData, mediaQuality, hdr };
  } catch (error) {
    logger.error(`Error in getMediaInfoCombined for ${filePath}: ${error.message}`);
    return { headerData: '', mediaQuality: null, hdr: null };
  }
}
