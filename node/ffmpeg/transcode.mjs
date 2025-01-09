// /ffmpeg/transcode.mjs

import { existsSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { tmpdir } from 'os';
import { libx264, vp9_vaapi, hevc_vaapi, hevc_nvenc } from './encoderConfig.mjs';
import { isVideoHDR } from './ffprobe.mjs';
import { createCategoryLogger } from '../lib/logger.mjs';
import { executeFFmpeg } from './ffmpeg.mjs';
import { fileInfo, stringArrayContainsArg } from '../utils/utils.mjs';

const logger = createCategoryLogger('transcode');

/**
 * Merges encoder settings with transcode profiles and user overrides.
 * @param {Object} encoderConfig - Selected encoder configuration.
 * @param {Object} profile - Selected transcode profile.
 * @param {Object} userOverrides - User-specified overrides.
 * @param {boolean} includeAudio - Whether to include audio flags.
 * @returns {Array} - Final FFmpeg arguments array (excluding input/output).
 */
function mergeTranscodeSettings(encoderConfig, profile, userOverrides, includeAudio = true) {
  let baseArgs = [];
  if (typeof encoderConfig.additionalArgs === 'function') {
    baseArgs = encoderConfig.additionalArgs(false); // isHDR handled separately
  } else if (Array.isArray(encoderConfig.additionalArgs)) {
    baseArgs = [...encoderConfig.additionalArgs];
  }

  // Merge in profile.encoderFlags
  for (const [flag, value] of Object.entries(profile.encoderFlags || {})) {
    const index = baseArgs.findIndex(arg => arg === flag);
    if (index !== -1 && baseArgs.length > index + 1) {
      baseArgs[index + 1] = value;
    } else {
      baseArgs.push(flag, value);
    }
  }

  // Merge in userOverrides
  for (const [flag, value] of Object.entries(userOverrides)) {
    const index = baseArgs.findIndex(arg => arg === flag);
    if (index !== -1 && baseArgs.length > index + 1) {
      baseArgs[index + 1] = value;
      logger.info(`Overriding flag ${flag} with value ${value}`);
    } else {
      baseArgs.push(flag, value);
      logger.info(`Adding new flag ${flag} with value ${value}`);
    }
  }

  // Conditionally include audio flags
  if (!includeAudio) {
    // Remove audio codec and channel count if present
    baseArgs = baseArgs.filter(arg => arg !== '-c:a' && arg !== '-ac');
  }

  return baseArgs;
}

/**
 * Builds single-pass FFmpeg arguments (excluding input/output).
 * @param {Object} codecConfig - Encoder configuration.
 * @param {Array} mergedArgs - Merged FFmpeg arguments.
 * @param {number} channelCount - Number of audio channels.
 * @param {string} containerExtension - Output container extension.
 * @param {boolean} includeAudio - Whether to include audio flags.
 * @returns {Array} - Array of FFmpeg arguments.
 */
function buildSinglePassArgs(
  codecConfig,
  mergedArgs,
  channelCount,
  containerExtension,
  includeAudio = true
) {
  const ffmpegArgs = [];

  // Video codec
  ffmpegArgs.push('-c:v', codecConfig.codec);

  // Audio codec
  if (includeAudio) {
    ffmpegArgs.push('-c:a', codecConfig.audio_codec || 'aac');
  }

  // Common options
  ffmpegArgs.push(
    '-fps_mode', 'cfr',
    '-avoid_negative_ts', 'make_zero',
    '-max_muxing_queue_size', '9999'
  );

  // Container-specific flags
  if (containerExtension === '.mp4') {
    ffmpegArgs.push('-movflags', '+faststart');
  } else if (containerExtension === '.webm') {
    ffmpegArgs.push('-frag_duration', '1000000'); // 1 second in microseconds
  }

  // Audio channel count
  if (includeAudio && !stringArrayContainsArg(mergedArgs, '-ac')) {
    ffmpegArgs.push('-ac', channelCount.toString());
  }

  // Merge in additional arguments
  ffmpegArgs.push(...mergedArgs);

  return ffmpegArgs;
}

/**
 * Runs a two-pass encoding flow.
 * @param {Object} params - Parameters for two-pass encoding.
 * @param {string} params.inputPath - Input video path.
 * @param {string} params.outputPath - Final output path.
 * @param {Object} params.codecConfig - Encoder configuration.
 * @param {Array} params.mergedArgs - Merged FFmpeg arguments.
 * @param {number} params.channelCount - Number of audio channels.
 * @param {number} params.audioTrackIndex - Audio track index.
 * @param {string} params.videoFilter - Video filter string.
 * @param {string} params.containerExtension - Output container extension.
 * @returns {Promise<void>}
 */
async function runTwoPassTranscode({
  inputPath,
  outputPath,
  codecConfig,
  mergedArgs,
  channelCount,
  audioTrackIndex,
  videoFilter,
  containerExtension,
}) {
  const passLogFile = join(tmpdir(), `ffmpeg2pass-${Date.now()}`);

  /**
   * Builds pass-specific arguments.
   * @param {number} passNum - Pass number (1 or 2).
   * @returns {Array} - FFmpeg arguments for the pass.
   */
  function buildPassArgs(passNum) {
    const passArgs = [];
    passArgs.push('-pass', passNum.toString());
    passArgs.push('-passlogfile', passLogFile);

    if (passNum === 1) {
      // Pass 1: Exclude audio and output to null
      passArgs.push('-an');
      passArgs.push('-f', 'null');
    }
    return passArgs;
  }

  // -----------------
  // PASS 1
  // -----------------
  {
    const ffmpegArgs = ['-y'];

    // VAAPI device
    if (codecConfig.vaapi_device) {
      ffmpegArgs.push('-vaapi_device', codecConfig.vaapi_device);
    }

    // Input
    ffmpegArgs.push('-i', inputPath);

    // Map video only
    ffmpegArgs.push('-map', '0:v:0');

    // Video filter
    if (videoFilter && !stringArrayContainsArg(mergedArgs, '-vf')) {
      ffmpegArgs.push('-vf', videoFilter);
    }

    // Build single-pass args without audio
    const pass1Args = buildSinglePassArgs(
      codecConfig,
      mergedArgs,
      channelCount,
      containerExtension,
      false // exclude audio
    );
    ffmpegArgs.push(...pass1Args);

    // Pass-specific args
    ffmpegArgs.push(...buildPassArgs(1));

    // Output to null
    ffmpegArgs.push('/dev/null');

    logger.info(`Executing two-pass PASS 1: ffmpeg ${ffmpegArgs.join(' ')}`);
    await executeFFmpeg(ffmpegArgs);
  }

  // -----------------
  // PASS 2
  // -----------------
  {
    const ffmpegArgs = ['-y'];

    // VAAPI device
    if (codecConfig.vaapi_device) {
      ffmpegArgs.push('-vaapi_device', codecConfig.vaapi_device);
    }

    // Input
    ffmpegArgs.push('-i', inputPath);

    // Map video and audio
    ffmpegArgs.push('-map', '0:v:0', '-map', `0:a:${audioTrackIndex}?`);

    // Video filter
    if (videoFilter && !stringArrayContainsArg(mergedArgs, '-vf')) {
      ffmpegArgs.push('-vf', videoFilter);
    }

    // Build single-pass args with audio
    const pass2Args = buildSinglePassArgs(
      codecConfig,
      mergedArgs,
      channelCount,
      containerExtension,
      true // include audio
    );
    ffmpegArgs.push(...pass2Args);

    // Pass-specific args
    ffmpegArgs.push(...buildPassArgs(2));


    ffmpegArgs.push(outputPath);

    logger.info(`Executing two-pass PASS 2: ffmpeg ${ffmpegArgs.join(' ')}`);
    await executeFFmpeg(ffmpegArgs);
  }

  // -----------------
  // Cleanup Pass Logs
  // -----------------
  try {
    if (existsSync(`${passLogFile}-0.log`)) {
      unlinkSync(`${passLogFile}-0.log`);
    }
    if (existsSync(`${passLogFile}-0.log.mbtree`)) {
      unlinkSync(`${passLogFile}-0.log.mbtree`);
    }
    logger.info(`Cleaned up two-pass log files at: ${passLogFile}`);
  } catch (cleanupError) {
    logger.warn(`Error cleaning pass log: ${cleanupError.message}`);
  }
}

/**
 * Generates a full FFmpeg transcode operation with the specified parameters.
 *
 * @param {string} inputPath - Path to the input video file.
 * @param {number} audioTrackIndex - Index of the audio track to use.
 * @param {number} channelCount - Number of audio channels.
 * @param {string} outputPath - Path to save the transcoded video.
 * @param {string} targetCodec - Target video codec (e.g., 'vp9_vaapi', 'libx264').
 * @param {string} profileName - Name of the transcode profile (e.g., 'full', 'clip').
 * @param {Object} userOverrides - Object containing user-specified overrides.
 * @returns {Promise<void>} - Resolves when transcoding is complete.
 */
export async function generateFullTranscode(
  inputPath,
  audioTrackIndex,
  channelCount,
  outputPath,
  targetCodec,
  profileName = 'full',
  userOverrides = {}
) {
  try {
    // 1) Select encoder config based on targetCodec
    let selectedEncoderConfig = libx264; // Default to libx264
    if (targetCodec === 'vp9_vaapi') {
      selectedEncoderConfig = vp9_vaapi;
    } else if (targetCodec === 'hevc_vaapi') {
      selectedEncoderConfig = hevc_vaapi;
    } else if (targetCodec === 'hevc_nvenc') {
      selectedEncoderConfig = hevc_nvenc;
    } else if (targetCodec === 'libx264') {
      selectedEncoderConfig = libx264;
    } else {
      logger.warn(`Unsupported codec "${targetCodec}". Falling back to libx264.`);
      selectedEncoderConfig = libx264;
    }

    // 2) Detect HDR
    const isHDR = await isVideoHDR(inputPath);
    logger.info(`HDR Detection: ${isHDR ? 'HDR' : 'SDR'}`);

    // 3) Select transcode profile
    const encoderProfiles = selectedEncoderConfig.profiles;
    if (!encoderProfiles || !encoderProfiles[profileName]) {
      throw new Error(`Profile "${profileName}" not found for encoder "${targetCodec}".`);
    }
    const profile = encoderProfiles[profileName];
    logger.info(`Selected Transcode Profile: ${profileName}`);

    // 4) Merge encoder settings with profile and user overrides
    // Note: includeAudio is true by default
    const mergedArgs = mergeTranscodeSettings(selectedEncoderConfig, profile, userOverrides, true);

    // 5) Handle video filter scaling
    let videoFilter = isHDR && selectedEncoderConfig.hdr_vf
      ? selectedEncoderConfig.hdr_vf(isHDR)
      : selectedEncoderConfig.vf(isHDR);
    if (profile.scale) {
      const { width, height } = profile.scale;
      if (videoFilter) {
        const scaleRegex = /scale=\d+:-?\d+/;
        if (scaleRegex.test(videoFilter)) {
          videoFilter = videoFilter.replace(scaleRegex, `scale=${width}:${height}`);
        } else {
          videoFilter = `scale=${width}:${height},${videoFilter}`;
        }
        logger.info(`Applied Scale Override: ${videoFilter}`);
      } else {
        videoFilter = `scale=${width}:${height}`;
        logger.info(`Set Scale Filter: ${videoFilter}`);
      }
    }

    // 6) Check if two-pass is requested
    const doTwoPass = !!profile.twoPass; // if "twoPass: true" on the profile
    const containerExtension = extname(outputPath).toLowerCase();

    if (doTwoPass) {
      logger.info(`Two-pass encoding requested for profile: ${profileName}. Running pass 1 & pass 2...`);
      await runTwoPassTranscode({
        inputPath,
        outputPath,
        codecConfig: selectedEncoderConfig,
        mergedArgs,
        channelCount,
        audioTrackIndex,
        videoFilter,
        containerExtension
      });
    } else {
      // Single-pass
      const ffmpegArgs = ['-y'];

      // Add VAAPI device if applicable
      if (selectedEncoderConfig.vaapi_device) {
        ffmpegArgs.push('-vaapi_device', selectedEncoderConfig.vaapi_device);
      }

      // Input file
      ffmpegArgs.push('-i', inputPath);

      // Map video and audio tracks
      ffmpegArgs.push('-map', '0:v:0', '-map', `0:a:${audioTrackIndex}?`);

      // Add video filter if applicable
      if (videoFilter && !stringArrayContainsArg(mergedArgs, '-vf')) {
        ffmpegArgs.push('-vf', videoFilter);
      }

      // Build single-pass arguments
      const singlePassArgs = buildSinglePassArgs(
        selectedEncoderConfig,
        mergedArgs,
        channelCount,
        containerExtension,
        true // includeAudio
      );
      ffmpegArgs.push(...singlePassArgs);

      // Output file
      ffmpegArgs.push(outputPath);

      // Log and execute
      logger.info(`Executing SINGLE PASS FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);
      await executeFFmpeg(ffmpegArgs);

      // Verify the output file
      const stats = await fileInfo(outputPath);
      if (stats.size === 0) {
        throw new Error('Generated file is empty');
      }
      logger.info(`Successfully transcoded video (single-pass) to: ${outputPath}`);
    }
  } catch (error) {
    logger.error(`Error during transcoding: ${error.message}`);
    throw error;
  }
}

/**
 * Generates a video clip and caches it using FFmpeg,
 * now supporting two-pass encoding if it is set on the profile.
 *
 * @param {string} videoPath - Path to the input video.
 * @param {number} start - Start time in seconds.
 * @param {number} end - End time in seconds.
 * @param {string} cachedClipPath - Full path to save the cached clip (with extension).
 * @param {Object} selectedEncoderConfig - Configuration for the selected encoder.
 * @param {boolean} isHDR - Flag indicating whether the video is HDR.
 * @param {string} profileName - Name of the transcode profile (e.g., 'clip').
 * @param {Object} userOverrides - User-specified overrides (optional).
 * @returns {Promise<void>}
 */
export async function generateAndCacheClip(
  videoPath,
  start,
  end,
  cachedClipPath,
  selectedEncoderConfig,
  isHDR,
  profileName = 'clip',
  userOverrides = {}
) {
  const tempDir = tmpdir();
  const tempPrefix = join(tempDir, `ffmpeg-${Date.now()}`);
  const rawVideoFile = `${tempPrefix}-raw.mkv`;

  try {
    // Step 1: Extract the segment
    const extractArgs = [
      '-y',
      '-ss', start.toString(),
      '-t', (end - start).toString(),
      '-i', videoPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c', 'copy',
      '-f', 'matroska',
      rawVideoFile
    ];
    logger.info(`Executing FFmpeg extract command: ffmpeg ${extractArgs.join(' ')}`);
    await executeFFmpeg(extractArgs);

    // Step 2: Select profile for the encoder
    if (!selectedEncoderConfig.profiles || !selectedEncoderConfig.profiles[profileName]) {
      throw new Error(`Profile "${profileName}" not found for encoder "${selectedEncoderConfig.codec}".`);
    }
    const profile = selectedEncoderConfig.profiles[profileName];
    logger.info(`Selected Transcode Profile for Clip: ${profileName}`);

    // Step 3: Merge encoder settings with profile and user overrides
    // Determine if two-pass is required
    const doTwoPass = !!profile.twoPass;
    // Include audio flags based on two-pass
    const includeAudio = !doTwoPass; // For two-pass, audio is included in Pass 2
    const mergedArgs = mergeTranscodeSettings(selectedEncoderConfig, profile, userOverrides, includeAudio);

    // Step 4: Handle video filter scaling
    let videoFilter = isHDR && selectedEncoderConfig.hdr_vf
      ? selectedEncoderConfig.hdr_vf(isHDR)
      : selectedEncoderConfig.vf(isHDR);
    if (profile.scale) {
      const { width, height } = profile.scale;
      if (videoFilter) {
        const scaleRegex = /scale=\d+:-?\d+/;
        if (scaleRegex.test(videoFilter)) {
          videoFilter = videoFilter.replace(scaleRegex, `scale=${width}:${height}`);
        } else {
          videoFilter = `scale=${width}:${height},${videoFilter}`;
        }
        logger.info(`Applied Scale Override for Clip: ${videoFilter}`);
      } else {
        videoFilter = `scale=${width}:${height}`;
        logger.info(`Set Scale Filter for Clip: ${videoFilter}`);
      }
    }

    // Step 5: Check if two-pass is requested
    const containerExtension = extname(cachedClipPath).toLowerCase();

    if (doTwoPass) {
      logger.info(`Two-pass clip encoding requested for profile: ${profileName}. Running pass 1 & pass 2...`);
      await runTwoPassTranscode({
        inputPath: rawVideoFile,
        outputPath: cachedClipPath,
        codecConfig: selectedEncoderConfig,
        mergedArgs,
        channelCount: 2, // Assuming stereo audio for clips
        audioTrackIndex: 0, // Since we extracted with '-map 0:a:0?'
        videoFilter,
        containerExtension,
      });
    } else {
      // Single-pass encode for clip
      const ffmpegArgs = ['-y'];

      // Add VAAPI device if applicable
      if (selectedEncoderConfig.vaapi_device) {
        ffmpegArgs.push('-vaapi_device', selectedEncoderConfig.vaapi_device);
      }

      // Input raw video segment
      ffmpegArgs.push('-i', rawVideoFile);

      // Map video and audio tracks
      ffmpegArgs.push('-map', '0:v:0', '-map', '0:a:0?');

      // Add video filter if applicable
      if (videoFilter && !stringArrayContainsArg(mergedArgs, '-vf')) {
        ffmpegArgs.push('-vf', videoFilter);
      }

      // Build single-pass arguments
      const singlePassArgs = buildSinglePassArgs(
        selectedEncoderConfig,
        mergedArgs,
        2, // channelCount for clips
        containerExtension,
        true // includeAudio
      );
      ffmpegArgs.push(...singlePassArgs);

      // Output file
      ffmpegArgs.push(cachedClipPath);

      // Log and execute
      logger.info(`Executing SINGLE PASS clip encode: ffmpeg ${ffmpegArgs.join(' ')}`);
      await executeFFmpeg(ffmpegArgs);

      // Verify the output file
      const stats = await fileInfo(cachedClipPath);
      if (stats.size === 0) {
        throw new Error('Generated clip file is empty');
      }
      logger.info(`Successfully generated clip (single-pass) at: ${cachedClipPath}`);
    }

    // Final verification (optional)
    const finalStats = await fileInfo(cachedClipPath);
    if (finalStats.size === 0) {
      throw new Error('Generated clip file is empty (post-check).');
    }

  } catch (error) {
    logger.error(`Error during clip generation: ${error.message}`);
    // Cleanup temporary files
    [rawVideoFile, cachedClipPath].forEach((file) => {
      if (existsSync(file)) {
        unlinkSync(file);
        logger.info(`Deleted temporary file: ${file}`);
      }
    });
    throw error;
  } finally {
    // Ensure temporary raw video file is deleted
    if (existsSync(rawVideoFile)) {
      unlinkSync(rawVideoFile);
      logger.info(`Cleaned up temporary file: ${rawVideoFile}`);
    }
  }
}
