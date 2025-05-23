// /ffmpeg/encoderConfig.mjs

/**
 * Encoder Configurations with Encoder-Specific Profiles
 * 
 * Each encoder configuration includes:
 * - codec: FFmpeg codec name.
 * - preset: Encoding preset for the encoder.
 * - format: Output container format.
 * - audio_codec: Audio codec to use.
 * - extension: File extension for the output.
 * - vf: Function returning base video filters (excluding scaling).
 * - hdr_vf: Alternative video filters for HDR content (excluding scaling).
 * - profiles: Transcode profiles (e.g., 'full', 'clip', 'preview') with:
 *    - encoderFlags: Encoder-specific FFmpeg flags.
 *    - additionalArgs: Additional FFmpeg arguments, possibly conditional on HDR.
 *    - scale (optional): Object specifying scaling parameters { width, height }.
 */

export const libx264 = {
  codec: 'libx264',
  preset: 'veryfast',
  format: 'mp4',
  audio_codec: 'aac',
  extension: '.mp4',
  /**
   * Base Video Filters for libx264
   * Excludes scaling to retain original dimensions by default.
   * Includes HDR handling if applicable; handles both 8-bit and 10-bit SDR input
   * @param {boolean} isHDR - Indicates if the video is HDR.
   * @param {string} inputPixFmt - Input pixel format.
   * @returns {string} - Comma-separated FFmpeg video filters.
   */
  vf: (isHDR, inputPixFmt) => {
    if (isHDR) {
      return 'zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0:peak=100,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2';
    }
    // Handle 10 bit SDR input
    // This will force scaling to occur within the zscale filter chain
    // and will ensure the output is 8 bit SDR
    else if (inputPixFmt && inputPixFmt.includes('10le')) {
      return 'zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=bt709:m=bt709:p=bt709:r=tv:w=1280:h=-2:dither=ordered,format=yuv420p,pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2';
    } else {
      return 'scale=1280:-2,format=yuv420p,pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2';
    }
  },
  /**
   * Alternative Video Filters for HDR content in libx264
   * Can be used if different HDR processing is required.
   * Currently, it's identical to the base `vf` but can be customized.
   * @param {boolean} isHDR
   * @param {string} inputPixFmt - Input pixel format.
   * @returns {string}
   */
  hdr_vf: (isHDR, inputPixFmt) => libx264.vf(isHDR, inputPixFmt),
  profiles: {
    full: {
      encoderFlags: {
        '-crf': '18',
        '-preset': 'slow',
        '-profile:v': 'high',
        '-level': '4.1',
      },
      /**
       * Additional FFmpeg Arguments for 'full' profile in libx264
       * High-quality settings with HDR support if applicable.
       * @param {boolean} isHDR
       * @returns {Array<string>}
       */
      additionalArgs: (isHDR) => [
        '-crf', '18',
        '-preset', 'slow',
        '-profile:v', 'high',
        '-level', '4.1',
        '-movflags', '+faststart',
        '-g', '48',
        '-keyint_min', '48',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        ...(isHDR
          ? [
              '-color_primaries', 'bt709',
              '-color_trc', 'bt709',
              '-colorspace', 'bt709',
            ]
          : []
        )
      ],
      // No scaling; retain original dimensions
    },
    clip: {
      encoderFlags: {
        '-crf': '18',
        '-preset': 'fast',
        '-b:v': '800K',
      },
      /**
       * Additional FFmpeg Arguments for 'clip' profile in libx264
       * Moderate quality settings suitable for clips.
       * @param {boolean} isHDR
       * @returns {Array<string>}
       */
      additionalArgs: (isHDR) => [
        '-crf', '18',
        '-preset', 'fast',
        '-b:v', '800K',
        '-g', '48',
        '-keyint_min', '48',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
      ],
      scale: { width: 1280, height: -2 }, // Example scaling for 'clip' profile
    },
    preview: {
      encoderFlags: {
        '-crf': '28',
        '-preset': 'ultrafast',
        '-b:v': '400K',
      },
      /**
       * Additional FFmpeg Arguments for 'preview' profile in libx264
       * Lower quality settings for previews.
       * @param {boolean} isHDR
       * @returns {Array<string>}
       */
      additionalArgs: (isHDR) => [
        '-crf', '28',
        '-preset', 'ultrafast',
        '-b:v', '400K',
        '-g', '48',
        '-keyint_min', '48',
        '-b:a', '96k',
        '-ar', '22050',
        '-ac', '2',
      ],
      // No scaling; retain original dimensions
    }
  }
};

export const vp9_vaapi = {
  codec: 'vp9_vaapi',
  vaapi_device: '/dev/dri/renderD128',
  format: 'webm',
  audio_codec: 'libopus',
  extension: '.webm',
  /**
   * Base Video Filters for vp9_vaapi
   * Excludes scaling to retain original dimensions by default.
   * Includes HDR handling if applicable.
   * @param {boolean} isHDR
   * @param {string} inputPixFmt - Input pixel format.
   * @returns {string}
   */
  vf: (isHDR, inputPixFmt) => [
    ...(isHDR
      ? [
          'zscale=t=linear:npl=100,format=gbrp16le',
          'zscale=p=bt709',
          'tonemap=tonemap=hable:peak=100',
          'zscale=t=bt709:m=bt709:r=tv',
          'format=nv12,hwupload',
        ]
      : [
          'format=nv12,hwupload',
        ]
    )
  ].join(','),
  /**
   * Alternative Video Filters for HDR content in vp9_vaapi
   * Customized to retain HDR metadata effectively.
   * @param {boolean} isHDR
   * @param {string} inputPixFmt - Input pixel format.
   * @returns {string}
   */
  hdr_vf: (isHDR, inputPixFmt) => vp9_vaapi.vf(isHDR, inputPixFmt),
  profiles: {
    full: {
      twoPass: true,
      encoderFlags: {
        '-deadline': 'good',
        '-b:v': '8M',
      },
      /**
       * Additional FFmpeg Arguments for 'full' profile in vp9_vaapi
       * High-quality settings with HDR support if applicable.
       * @param {boolean} isHDR
       * @returns {Array<string>}
       */
      additionalArgs: (isHDR) => [
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
        ...(isHDR
          ? [
              '-color_primaries', 'bt709',
              '-profile:v', '2',
              '-color_trc', 'bt709',
              '-colorspace', 'bt709',
              // VP9-specific HDR metadata
              '-metadata:s:v:0', 'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,50)',
              '-metadata:s:v:0', 'max-cll=400,50',
            ]
          : []
        )
      ],
      // Define scaling within the profile if needed
      //scale: { width: 1280, height: -2 }, // Example scaling for 'full' profile
    },
    clip: {
      twoPass: true,
      encoderFlags: {
        '-deadline': 'good',
        '-b:v': '1900K',
      },
      /**
       * Additional FFmpeg Arguments for 'clip' profile in vp9_vaapi
       * Moderate quality settings suitable for clips.
       * @param {boolean} isHDR
       * @returns {Array<string>}
       */
      additionalArgs: (isHDR) => [
        '-deadline', 'good',
        //'-cpu-used', '4',
        '-row-mt', '1',
        '-tile-columns', '0',
        '-frame-parallel', '0',
        '-g', '240',
        '-keyint_min', '240',
        '-b:a', '96k',
        '-ac', '2',
        '-rc_mode', 'VBR',
        ...(isHDR
          ? [
              '-color_primaries', 'bt709',
              '-profile:v', '2',
              '-color_trc', 'bt709',
              '-colorspace', 'bt709',
              // VP9-specific HDR metadata
              '-metadata:s:v:0', 'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,50)',
              '-metadata:s:v:0', 'max-cll=400,50',
            ]
          : []
        )
      ],
      // Define scaling within the profile if needed
      scale: { width: 640, height: -2 }, // Example scaling for 'clip' profile
    },
    preview: {
      encoderFlags: {
        '-deadline': 'good',
        '-b:v': '600K',
      },
      /**
       * Additional FFmpeg Arguments for 'preview' profile in vp9_vaapi
       * Lower quality settings for previews.
       * @param {boolean} isHDR
       * @returns {Array<string>}
       */
      additionalArgs: (isHDR) => [
        '-deadline', 'good',
        '-cpu-used', '6',
        '-row-mt', '1',
        '-tile-columns', '0',
        '-frame-parallel', '0',
        '-g', '120',
        '-keyint_min', '120',
        '-b:a', '64k',
        '-ac', '2',
        '-rc_mode', 'VBR',
        ...(isHDR
          ? [
              '-color_primaries', 'bt709',
              '-color_trc', 'bt709',
              '-colorspace', 'bt709',
              // VP9-specific HDR metadata
              '-metadata:s:v:0', 'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,50)',
              '-metadata:s:v:0', 'max-cll=400,50',
            ]
          : []
        )
      ],
      // Define scaling within the profile if needed
      scale: { width: 320, height: -2 }, // Example scaling for 'preview' profile
    }
  }
};

export const hevc_vaapi = {
  codec: 'hevc_vaapi',
  vaapi_device: '/dev/dri/renderD128',
  format: 'mp4',
  audio_codec: 'copy',
  extension: '.mp4',
  /**
   * Base Video Filters for hevc_vaapi
   * Excludes scaling to retain original dimensions by default.
   * Includes HDR handling if applicable.
   * @param {boolean} isHDR
   * @param {string} inputPixFmt - Input pixel format.
   * @returns {string}
   */
  vf: (isHDR, inputPixFmt) => [
    ...(isHDR
      ? [
          'zscale=t=linear:npl=100,format=gbrp16le',
          'zscale=p=bt709',
          'tonemap=tonemap=hable:peak=100',
          'zscale=t=bt709:m=bt709:r=tv',
          'format=nv12,hwupload',
        ]
      : [
          'format=nv12,hwupload',
        ]
    )
  ].join(','),
  /**
   * Alternative Video Filters for HDR content in hevc_vaapi
   * Currently identical to base `vf`, but can be customized.
   * @param {boolean} isHDR
   * @param {string} inputPixFmt - Input pixel format.
   * @returns {string}
   */
  hdr_vf: (isHDR, inputPixFmt) => hevc_vaapi.vf(isHDR, inputPixFmt),
  profiles: {
    full: {
      encoderFlags: {
        '-b:v': '2000K',
        '-preset': 'slow',
      },
      /**
       * Additional FFmpeg Arguments for 'full' profile in hevc_vaapi
       * High bitrate settings.
       * @param {boolean} isHDR
       * @returns {Array<string>}
       */
      additionalArgs: (isHDR) => [
        '-b:v', '2000K',
        '-preset', 'slow',
        ...(isHDR
          ? [
              '-color_primaries', 'bt709',
              '-color_trc', 'bt709',
              '-colorspace', 'bt709',
              // HEVC-specific HDR metadata
              '-metadata:s:v:0', 'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,50)',
              '-metadata:s:v:0', 'max-cll=400,50',
            ]
          : []
        )
      ],
      // No scaling; retain original dimensions
    }
    // Add more profiles if needed
  }
};

export const hevc_nvenc = {
  codec: 'hevc_nvenc',
  preset: 'slow',
  format: 'mp4',
  audio_codec: 'copy',
  extension: '.mp4',
  /**
   * Base Video Filters for hevc_nvenc
   * Excludes scaling to retain original dimensions by default.
   * Includes HDR handling if applicable.
   * @param {boolean} isHDR
   * @param {string} inputPixFmt - Input pixel format.
   * @returns {string}
   */
  vf: (isHDR, inputPixFmt) => [
    ...(isHDR
      ? [
          'zscale=t=linear:npl=100,format=gbrp16le',
          'zscale=p=bt709',
          'tonemap=tonemap=hable:peak=100',
          'zscale=t=bt709:m=bt709:r=tv',
          'format=yuv420p',
        ]
      : [
          'format=yuv420p',
        ]
    ),
    'pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2', // Ensure dimensions are even
  ].join(','),
  /**
   * Alternative Video Filters for HDR content in hevc_nvenc
   * Can be used if different HDR processing is required.
   * Currently, it's identical to the base `vf` but can be customized.
   * @param {boolean} isHDR
   * @param {string} inputPixFmt - Input pixel format.
   * @returns {string}
   */
  hdr_vf: (isHDR, inputPixFmt) => hevc_nvenc.vf(isHDR, inputPixFmt),
  profiles: {
    full: {
      encoderFlags: {
        '-preset': 'slow',
        '-cq': '28',
      },
      /**
       * Additional FFmpeg Arguments for 'full' profile in hevc_nvenc
       * High-quality settings with HDR support if applicable.
       * @param {boolean} isHDR
       * @returns {Array<string>}
       */
      additionalArgs: (isHDR) => [
        '-preset', 'slow',
        '-cq', '28',
        '-rc', 'vbr_hq',
        '-g', '120',
        '-keyint_min', '120',
        ...(isHDR
          ? [
              '-color_primaries', 'bt709',
              '-color_trc', 'bt709',
              '-colorspace', 'bt709',
              // HEVC-specific HDR metadata
              '-metadata:s:v:0', 'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,50)',
              '-metadata:s:v:0', 'max-cll=400,50',
            ]
          : []
        )
      ],
      // No scaling; retain original dimensions
    },
    clip: {
      encoderFlags: {
        '-preset': 'medium',
        '-cq': '28',
        '-b:v': '800K',
      },
      /**
       * Additional FFmpeg Arguments for 'clip' profile in hevc_nvenc
       * Moderate quality settings suitable for clips.
       * @param {boolean} isHDR
       * @returns {Array<string>}
       */
      additionalArgs: (isHDR) => [
        '-preset', 'medium',
        '-cq', '28',
        '-rc', 'vbr',
        '-b:v', '800K',
        '-g', '48',
        '-keyint_min', '48',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        ...(isHDR
          ? [
              '-color_primaries', 'bt709',
              '-color_trc', 'bt709',
              '-colorspace', 'bt709',
              // HEVC-specific HDR metadata
              '-metadata:s:v:0', 'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,50)',
              '-metadata:s:v:0', 'max-cll=400,50',
            ]
          : []
        )
      ],
      scale: { width: 1280, height: -2 }, // Standard clip scaling
    },
    preview: {
      encoderFlags: {
        '-preset': 'fast',
        '-cq': '32',
        '-b:v': '400K',
      },
      /**
       * Additional FFmpeg Arguments for 'preview' profile in hevc_nvenc
       * Lower quality settings for previews.
       * @param {boolean} isHDR
       * @returns {Array<string>}
       */
      additionalArgs: (isHDR) => [
        '-preset', 'fast',
        '-cq', '32',
        '-rc', 'vbr',
        '-b:v', '400K',
        '-g', '48',
        '-keyint_min', '48',
        '-b:a', '96k',
        '-ar', '22050',
        '-ac', '2',
        ...(isHDR
          ? [
              '-color_primaries', 'bt709',
              '-color_trc', 'bt709',
              '-colorspace', 'bt709',
            ]
          : []
        )
      ],
      scale: { width: 640, height: -2 }, // Lower resolution for previews
    }
    // Add more profiles if needed
  }
};

// Export all encoders as default for easy import
export default { libx264, vp9_vaapi, hevc_vaapi, hevc_nvenc };
