// /ffmpeg/encoderConfig.mjs

/**
 * Encoder Configuration Architecture
 * 
 * Features:
 * - Strategy pattern for video filters and profiles
 * - Factory pattern for encoder creation
 * - Builder pattern for FFmpeg command generation
 * - Comprehensive input validation and error handling
 * - Centralized configuration management
 * - Eliminated code duplication (DRY principle)
 * - Single responsibility principle throughout
 * - Easy extensibility for new encoders and profiles
 */

// ==================== CONFIGURATION CONSTANTS ====================

/**
 * Centralized configuration constants to eliminate magic values
 */
export const CONFIG = {
  // HDR Processing Constants
  HDR: {
    NITS_PEAK: 100,
    TONEMAP_ALGORITHM: 'hable',
    DESAT_VALUE: 0,
    LINEAR_NPL: 100,
  },

  // Color Space and Transfer Characteristics
  COLOR: {
    BT709: {
      primaries: 'bt709',
      transfer: 'bt709',
      space: 'bt709',
    },
    BT2020: {
      primaries: 'bt2020',
      transfer: 'smpte2084',
      space: 'bt2020nc',
    },
  },

  // HDR Metadata Templates
  HDR_METADATA: {
    MASTER_DISPLAY: 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,50)',
    MAX_CLL: '400,50',
  },

  // Standard Scaling Presets
  SCALING: {
    FULL_HD: { width: 1920, height: -2 },
    HD: { width: 1280, height: -2 },
    SD: { width: 640, height: -2 },
    PREVIEW: { width: 320, height: -2 },
  },

  // Audio Settings
  AUDIO: {
    HIGH_QUALITY: { bitrate: '128k', sampleRate: '44100', channels: '2' },
    STANDARD: { bitrate: '96k', sampleRate: '44100', channels: '2' },
    LOW_QUALITY: { bitrate: '64k', sampleRate: '22050', channels: '2' },
  },

  // Video Quality Presets
  QUALITY: {
    HIGH: { crf: '18', preset: 'slow' },
    MEDIUM: { crf: '23', preset: 'medium' },
    LOW: { crf: '28', preset: 'fast' },
    PREVIEW: { crf: '32', preset: 'ultrafast' },
  },

  // Hardware Acceleration
  VAAPI: {
    DEFAULT_DEVICE: '/dev/dri/renderD128',
  },
};

// ==================== ERROR HANDLING ====================

/**
 * Custom error classes for better error handling and debugging
 */
export class EncoderConfigError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'EncoderConfigError';
    this.context = context;
  }
}

export class ValidationError extends EncoderConfigError {
  constructor(field, value, expectedType, context = {}) {
    super(`Invalid ${field}: expected ${expectedType}, got ${typeof value}`, {
      field,
      value,
      expectedType,
      ...context,
    });
    this.name = 'ValidationError';
  }
}

// ==================== INPUT VALIDATION ====================

/**
 * Comprehensive input validation utility
 */
export class EncoderValidator {
  /**
   * Validates encoder configuration inputs
   * @param {boolean} isHDR - HDR flag
   * @param {string} inputPixFmt - Input pixel format
   * @param {string} profileName - Profile name
   * @param {Object} scalingParams - Scaling parameters
   */
  static validateInputs(isHDR, inputPixFmt, profileName, scalingParams = null) {
    // Validate HDR flag
    if (typeof isHDR !== 'boolean') {
      throw new ValidationError('isHDR', isHDR, 'boolean');
    }

    // Validate pixel format (allow null/undefined)
    if (inputPixFmt !== null && inputPixFmt !== undefined && typeof inputPixFmt !== 'string') {
      throw new ValidationError('inputPixFmt', inputPixFmt, 'string or null');
    }

    // Validate profile name
    if (profileName && typeof profileName !== 'string') {
      throw new ValidationError('profileName', profileName, 'string');
    }

    // Validate scaling parameters
    if (scalingParams !== null && scalingParams !== undefined) {
      if (typeof scalingParams !== 'object') {
        throw new ValidationError('scalingParams', scalingParams, 'object or null');
      }
      if (scalingParams.width !== undefined && typeof scalingParams.width !== 'number') {
        throw new ValidationError('scalingParams.width', scalingParams.width, 'number');
      }
      if (scalingParams.height !== undefined && typeof scalingParams.height !== 'number') {
        throw new ValidationError('scalingParams.height', scalingParams.height, 'number');
      }
    }
  }

  /**
   * Validates pixel format string
   * @param {string} pixFmt - Pixel format to validate
   * @returns {boolean} True if valid
   */
  static isValidPixelFormat(pixFmt) {
    if (!pixFmt || typeof pixFmt !== 'string') return false;
    
    const validFormats = [
      'yuv420p', 'yuv422p', 'yuv444p', 'yuv420p10le', 'yuv422p10le',
      'yuv444p10le', 'nv12', 'nv21', 'gbrp', 'gbrpf32le', 'gbrp16le'
    ];
    
    return validFormats.some(format => pixFmt.includes(format));
  }
}

// ==================== VIDEO FILTER STRATEGIES ====================

/**
 * Abstract base class for video filter strategies
 */
class VideoFilterStrategy {
  /**
   * Generate video filters for the given parameters
   * @param {boolean} isHDR - Whether input is HDR
   * @param {string} inputPixFmt - Input pixel format
   * @param {Object} scalingParams - Scaling parameters {width, height}
   * @returns {string} Comma-separated filter string
   */
  generateFilters(isHDR, inputPixFmt, scalingParams = null) {
    throw new EncoderConfigError('generateFilters must be implemented by subclasses');
  }

  /**
   * Get scaling filter string
   * @param {Object} scalingParams - {width, height}
   * @param {string} filterType - 'scale' or 'zscale'
   * @returns {string} Scaling filter string
   */
  _getScalingFilter(scalingParams, filterType = 'scale') {
    if (!scalingParams) return '';
    
    const { width, height } = scalingParams;
    if (filterType === 'zscale') {
      return `zscale=w=${width}:h=${height}`;
    }
    return `scale=${width}:${height}`;
  }

  /**
   * Get padding filter to ensure even dimensions
   * @returns {string} Padding filter string
   */
  _getPaddingFilter() {
    return 'pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2';
  }
}

/**
 * Software encoding filter strategy (libx264)
 */
class SoftwareFilterStrategy extends VideoFilterStrategy {
  generateFilters(isHDR, inputPixFmt, scalingParams = null) {
    EncoderValidator.validateInputs(isHDR, inputPixFmt, null, scalingParams);

    const filters = [];

    if (isHDR) {
      // HDR to SDR tone mapping pipeline
      filters.push(
        `zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=${CONFIG.HDR.LINEAR_NPL}`,
        'format=gbrpf32le',
        'zscale=p=bt709',
        `tonemap=tonemap=${CONFIG.HDR.TONEMAP_ALGORITHM}:desat=${CONFIG.HDR.DESAT_VALUE}:peak=${CONFIG.HDR.NITS_PEAK}`,
        'zscale=t=bt709:m=bt709:r=tv',
        'format=yuv420p'
      );
    } else if (inputPixFmt && inputPixFmt.includes('10le')) {
      // 10-bit SDR to 8-bit SDR conversion
      const scalingFilter = scalingParams 
        ? `zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=bt709:m=bt709:p=bt709:r=tv:w=${scalingParams.width}:h=${scalingParams.height}:dither=ordered`
        : 'zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=bt709:m=bt709:p=bt709:r=tv:dither=ordered';
      
      filters.push(scalingFilter, 'format=yuv420p');
    } else {
      // Standard processing
      if (scalingParams) {
        filters.push(this._getScalingFilter(scalingParams));
      }
      filters.push('format=yuv420p');
    }

    // Add padding to ensure even dimensions
    filters.push(this._getPaddingFilter());

    return filters.join(',');
  }
}

/**
 * VAAPI hardware encoding filter strategy
 */
class VaapiFilterStrategy extends VideoFilterStrategy {
  generateFilters(isHDR, inputPixFmt, scalingParams = null) {
    EncoderValidator.validateInputs(isHDR, inputPixFmt, null, scalingParams);

    const filters = [];

    if (isHDR) {
      // HDR tone mapping for VAAPI
      filters.push(
        `zscale=t=linear:npl=${CONFIG.HDR.LINEAR_NPL}`,
        'format=gbrp16le',
        'zscale=p=bt709',
        `tonemap=tonemap=${CONFIG.HDR.TONEMAP_ALGORITHM}:peak=${CONFIG.HDR.NITS_PEAK}`,
        'zscale=t=bt709:m=bt709:r=tv'
      );
    }

    // Add scaling if specified
    if (scalingParams) {
      filters.push(this._getScalingFilter(scalingParams, 'zscale'));
    }

    // VAAPI format conversion and upload
    filters.push('format=nv12', 'hwupload');

    return filters.join(',');
  }
}

/**
 * NVENC hardware encoding filter strategy
 */
class NvencFilterStrategy extends VideoFilterStrategy {
  generateFilters(isHDR, inputPixFmt, scalingParams = null) {
    EncoderValidator.validateInputs(isHDR, inputPixFmt, null, scalingParams);

    const filters = [];

    if (isHDR) {
      // HDR tone mapping for NVENC
      filters.push(
        `zscale=t=linear:npl=${CONFIG.HDR.LINEAR_NPL}`,
        'format=gbrp16le',
        'zscale=p=bt709',
        `tonemap=tonemap=${CONFIG.HDR.TONEMAP_ALGORITHM}:peak=${CONFIG.HDR.NITS_PEAK}`,
        'zscale=t=bt709:m=bt709:r=tv'
      );
    }

    // Add scaling if specified
    if (scalingParams) {
      filters.push(this._getScalingFilter(scalingParams, 'zscale'));
    }

    // NVENC format and padding
    filters.push('format=yuv420p', this._getPaddingFilter());

    return filters.join(',');
  }
}

// ==================== PROFILE STRATEGIES ====================

/**
 * Abstract base class for profile strategies
 */
class ProfileStrategy {
  /**
   * Generate FFmpeg arguments for the profile
   * @param {boolean} isHDR - Whether input is HDR
   * @param {string} profileName - Profile name
   * @returns {Array<string>} FFmpeg arguments array
   */
  generateArgs(isHDR, profileName) {
    throw new EncoderConfigError('generateArgs must be implemented by subclasses');
  }

  /**
   * Get HDR-specific metadata arguments
   * @param {string} codecType - Codec type (h264, hevc, vp9)
   * @returns {Array<string>} HDR metadata arguments
   */
  _getHDRMetadata(codecType) {
    const baseArgs = [
      '-color_primaries', CONFIG.COLOR.BT709.primaries,
      '-color_trc', CONFIG.COLOR.BT709.transfer,
      '-colorspace', CONFIG.COLOR.BT709.space,
    ];

    if (codecType === 'hevc' || codecType === 'vp9') {
      baseArgs.push(
        '-metadata:s:v:0', `master-display=${CONFIG.HDR_METADATA.MASTER_DISPLAY}`,
        '-metadata:s:v:0', `max-cll=${CONFIG.HDR_METADATA.MAX_CLL}`
      );
    }

    if (codecType === 'vp9') {
      baseArgs.push('-profile:v', '2');
    }

    return baseArgs;
  }

  /**
   * Get audio settings for profile
   * @param {string} quality - 'high', 'standard', or 'low'
   * @returns {Array<string>} Audio arguments
   */
  _getAudioArgs(quality = 'standard') {
    const audioConfig = CONFIG.AUDIO[quality.toUpperCase()] || CONFIG.AUDIO.STANDARD;
    return [
      '-b:a', audioConfig.bitrate,
      '-ar', audioConfig.sampleRate,
      '-ac', audioConfig.channels,
    ];
  }
}

/**
 * H.264 Profile Strategy
 */
class H264ProfileStrategy extends ProfileStrategy {
  generateArgs(isHDR, profileName) {
    const profiles = {
      full: () => [
        '-crf', '18',
        '-preset', 'slow',
        '-profile:v', 'high',
        '-level', '4.1',
        '-movflags', '+faststart',
        '-g', '48',
        '-keyint_min', '48',
        ...this._getAudioArgs('high'),
        ...(isHDR ? this._getHDRMetadata('h264') : []),
      ],
      clip: () => [
        '-crf', '18',
        '-preset', 'fast',
        '-b:v', '800K',
        '-g', '48',
        '-keyint_min', '48',
        ...this._getAudioArgs('high'),
      ],
      preview: () => [
        '-crf', '28',
        '-preset', 'ultrafast',
        '-b:v', '400K',
        '-g', '48',
        '-keyint_min', '48',
        ...this._getAudioArgs('low'),
      ],
    };

    const profileFunc = profiles[profileName];
    if (!profileFunc) {
      throw new EncoderConfigError(`Unknown H.264 profile: ${profileName}`);
    }

    return profileFunc();
  }
}

/**
 * VP9 Profile Strategy
 */
class VP9ProfileStrategy extends ProfileStrategy {
  generateArgs(isHDR, profileName) {
    const profiles = {
      full: () => [
        '-deadline', 'good',
        '-cpu-used', '2',
        '-row-mt', '1',
        '-tile-columns', '0',
        '-frame-parallel', '0',
        '-g', '240',
        '-keyint_min', '240',
        '-b:a', '104k',
        '-ac', '2',
        '-rc_mode', 'VBR',
        ...(isHDR ? this._getHDRMetadata('vp9') : []),
      ],
      clip: () => [
        '-deadline', 'good',
        '-row-mt', '1',
        '-tile-columns', '0',
        '-frame-parallel', '0',
        '-g', '240',
        '-keyint_min', '240',
        '-b:v', '1900K',
        '-b:a', '96k',
        '-ac', '2',
        '-rc_mode', 'VBR',
        ...(isHDR ? this._getHDRMetadata('vp9') : []),
      ],
      preview: () => [
        '-deadline', 'good',
        '-cpu-used', '6',
        '-row-mt', '1',
        '-tile-columns', '0',
        '-frame-parallel', '0',
        '-g', '120',
        '-keyint_min', '120',
        '-b:v', '600K',
        '-b:a', '64k',
        '-ac', '2',
        '-rc_mode', 'VBR',
        ...(isHDR ? this._getHDRMetadata('vp9') : []),
      ],
    };

    const profileFunc = profiles[profileName];
    if (!profileFunc) {
      throw new EncoderConfigError(`Unknown VP9 profile: ${profileName}`);
    }

    return profileFunc();
  }
}

/**
 * HEVC Profile Strategy
 */
class HEVCProfileStrategy extends ProfileStrategy {
  generateArgs(isHDR, profileName) {
    const profiles = {
      full: () => [
        '-preset', 'slow',
        '-cq', '28',
        '-rc', 'vbr_hq',
        '-g', '120',
        '-keyint_min', '120',
        ...(isHDR ? this._getHDRMetadata('hevc') : []),
      ],
      clip: () => [
        '-preset', 'medium',
        '-cq', '28',
        '-rc', 'vbr',
        '-b:v', '800K',
        '-g', '48',
        '-keyint_min', '48',
        ...this._getAudioArgs('high'),
        ...(isHDR ? this._getHDRMetadata('hevc') : []),
      ],
      preview: () => [
        '-preset', 'fast',
        '-cq', '32',
        '-rc', 'vbr',
        '-b:v', '400K',
        '-g', '48',
        '-keyint_min', '48',
        ...this._getAudioArgs('low'),
        ...(isHDR ? this._getHDRMetadata('hevc') : []),
      ],
    };

    const profileFunc = profiles[profileName];
    if (!profileFunc) {
      throw new EncoderConfigError(`Unknown HEVC profile: ${profileName}`);
    }

    return profileFunc();
  }
}

// ==================== ENCODER CLASS ====================

/**
 * Main Encoder class that encapsulates all encoding logic
 */
class Encoder {
  constructor(config, filterStrategy, profileStrategy) {
    this.config = config;
    this.filterStrategy = filterStrategy;
    this.profileStrategy = profileStrategy;
    this._validateConfig();
  }

  /**
   * Validates the encoder configuration
   * @private
   */
  _validateConfig() {
    const required = ['codec', 'format', 'audio_codec', 'extension'];
    for (const field of required) {
      if (!this.config[field]) {
        throw new EncoderConfigError(`Missing required config field: ${field}`);
      }
    }
  }

  /**
   * Generate video filters
   * @param {boolean} isHDR - Whether input is HDR
   * @param {string} inputPixFmt - Input pixel format
   * @param {Object} scalingParams - Scaling parameters
   * @returns {string} Filter string
   */
  generateVideoFilters(isHDR = false, inputPixFmt = null, scalingParams = null) {
    try {
      return this.filterStrategy.generateFilters(isHDR, inputPixFmt, scalingParams);
    } catch (error) {
      throw new EncoderConfigError(`Failed to generate video filters: ${error.message}`, {
        encoder: this.config.codec,
        isHDR,
        inputPixFmt,
        scalingParams,
      });
    }
  }

  /**
   * Generate profile arguments
   * @param {string} profileName - Profile name
   * @param {boolean} isHDR - Whether input is HDR
   * @returns {Array<string>} FFmpeg arguments
   */
  generateProfileArgs(profileName, isHDR = false) {
    try {
      return this.profileStrategy.generateArgs(isHDR, profileName);
    } catch (error) {
      throw new EncoderConfigError(`Failed to generate profile args: ${error.message}`, {
        encoder: this.config.codec,
        profileName,
        isHDR,
      });
    }
  }

  /**
   * Get scaling parameters for a profile
   * @param {string} profileName - Profile name
   * @returns {Object|null} Scaling parameters
   */
  getScalingForProfile(profileName) {
    const scalingMap = {
      clip: CONFIG.SCALING.HD,
      preview: CONFIG.SCALING.SD,
    };
    return scalingMap[profileName] || null;
  }

  /**
   * Get available profiles for this encoder
   * @returns {Array<string>} Profile names
   */
  getAvailableProfiles() {
    // This could be made configurable per encoder type
    return ['full', 'clip', 'preview'];
  }

  /**
   * Get encoder configuration
   * @returns {Object} Configuration object
   */
  getConfig() {
    return { ...this.config };
  }
}

// ==================== ENCODER FACTORY ====================

/**
 * Factory for creating encoder instances
 */
class EncoderFactory {
  /**
   * Create an encoder instance
   * @param {string} encoderType - Encoder type (libx264, vp9_vaapi, etc.)
   * @param {Object} options - Additional options
   * @returns {Encoder} Encoder instance
   */
  static createEncoder(encoderType, options = {}) {
    const configurations = {
      libx264: {
        config: {
          codec: 'libx264',
          preset: 'veryfast',
          format: 'mp4',
          audio_codec: 'aac',
          extension: '.mp4',
        },
        filterStrategy: new SoftwareFilterStrategy(),
        profileStrategy: new H264ProfileStrategy(),
      },
      vp9_vaapi: {
        config: {
          codec: 'vp9_vaapi',
          vaapi_device: CONFIG.VAAPI.DEFAULT_DEVICE,
          format: 'webm',
          audio_codec: 'libopus',
          extension: '.webm',
        },
        filterStrategy: new VaapiFilterStrategy(),
        profileStrategy: new VP9ProfileStrategy(),
      },
      hevc_vaapi: {
        config: {
          codec: 'hevc_vaapi',
          vaapi_device: CONFIG.VAAPI.DEFAULT_DEVICE,
          format: 'mp4',
          audio_codec: 'copy',
          extension: '.mp4',
        },
        filterStrategy: new VaapiFilterStrategy(),
        profileStrategy: new HEVCProfileStrategy(),
      },
      hevc_nvenc: {
        config: {
          codec: 'hevc_nvenc',
          preset: 'slow',
          format: 'mp4',
          audio_codec: 'copy',
          extension: '.mp4',
        },
        filterStrategy: new NvencFilterStrategy(),
        profileStrategy: new HEVCProfileStrategy(),
      },
    };

    const encoderDef = configurations[encoderType];
    if (!encoderDef) {
      throw new EncoderConfigError(`Unknown encoder type: ${encoderType}`);
    }

    // Merge options into config
    const finalConfig = { ...encoderDef.config, ...options };

    return new Encoder(
      finalConfig,
      encoderDef.filterStrategy,
      encoderDef.profileStrategy
    );
  }

  /**
   * Get available encoder types
   * @returns {Array<string>} Available encoder types
   */
  static getAvailableEncoders() {
    return ['libx264', 'vp9_vaapi', 'hevc_vaapi', 'hevc_nvenc'];
  }
}

// ==================== BACKWARD COMPATIBILITY LAYER ====================

/**
 * Creates backward-compatible encoder objects
 */
function createLegacyEncoder(encoderType) {
  const encoder = EncoderFactory.createEncoder(encoderType);
  const config = encoder.getConfig();

  return {
    ...config,
    vf: (isHDR, inputPixFmt) => {
      const scaling = encoder.getScalingForProfile('clip');
      return encoder.generateVideoFilters(isHDR, inputPixFmt, scaling);
    },
    hdr_vf: (isHDR, inputPixFmt) => {
      const scaling = encoder.getScalingForProfile('clip');
      return encoder.generateVideoFilters(isHDR, inputPixFmt, scaling);
    },
    profiles: {
      full: {
        encoderFlags: {}, // Legacy compatibility
        additionalArgs: (isHDR) => encoder.generateProfileArgs('full', isHDR),
      },
      clip: {
        encoderFlags: {}, // Legacy compatibility
        additionalArgs: (isHDR) => encoder.generateProfileArgs('clip', isHDR),
        scale: encoder.getScalingForProfile('clip'),
      },
      preview: {
        encoderFlags: {}, // Legacy compatibility
        additionalArgs: (isHDR) => encoder.generateProfileArgs('preview', isHDR),
        scale: encoder.getScalingForProfile('preview'),
      },
    },
  };
}

// Export legacy encoder objects for backward compatibility
export const libx264 = createLegacyEncoder('libx264');
export const vp9_vaapi = createLegacyEncoder('vp9_vaapi');
export const hevc_vaapi = createLegacyEncoder('hevc_vaapi');
export const hevc_nvenc = createLegacyEncoder('hevc_nvenc');

// Export new factory and classes for modern usage
export { Encoder, EncoderFactory };

// Export all encoders as default for easy import
export default { libx264, vp9_vaapi, hevc_vaapi, hevc_nvenc };
