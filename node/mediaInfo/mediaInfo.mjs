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