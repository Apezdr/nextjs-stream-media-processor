// encoderConfigs.js

const encoderConfigs = {
  vp9_vaapi: {
    codec: 'vp9_vaapi',
    vaapi_device: '/dev/dri/renderD128',
    // Base VF config for SDR content
    vf: 'scale=1280:-2,format=nv12,hwupload',
    // Updated HDR video filter chain to match the new manual command
    hdr_vf: 'scale=1280:-2,zscale=t=linear:npl=100,format=gbrp16le,zscale=p=bt709,tonemap=tonemap=hable:peak=100,zscale=t=bt709:m=bt709:r=tv,format=nv12,hwupload',
    format: 'webm',
    audio_codec: 'libopus',
    extension: '.webm',
    // additional_args is now a function to handle HDR-specific arguments
    additional_args: (isHDR) => [
      // Quality settings
      '-quality', 'realtime',
      '-cpu-used', '4',
      // Memory optimization
      '-row-mt', '1',
      '-tile-columns', '0',
      '-frame-parallel', '0',
      // GOP structure
      '-g', '120',
      '-keyint_min', '120',
      // Audio settings
      '-b:a', '96k',
      '-ac', '2',
      // Conditional bitrate based on HDR status
      ...(isHDR ? ['-b:v', '1400K'] : ['-b:v', '1200K']),
      // Rate Control Mode
      '-rc_mode', 'VBR',
      // Additional color settings for HDR
      ...(isHDR ? [
        '-color_primaries', 'bt709',
        '-color_trc', 'bt709',
        '-colorspace', 'bt709'
      ] : [])
    ]
  },
  hevc_vaapi: {
    codec: 'hevc_vaapi',
    preset: 'slow',
    bitrate: '2000K',
    vaapi_device: '/dev/dri/renderD128',
    vf: 'format=nv12,hwupload',
    format: 'mp4',
    audio_codec: 'copy',
    extension: '.mp4',
    // additional_args is optional; define as needed or omit
    additional_args: [
      // Example additional arguments for hevc_vaapi
      '-b:v', '2000K',
      '-preset', 'slow'
      // Add more as needed
    ]
  },
  hevc_nvenc: {
    codec: 'hevc_nvenc',
    preset: 'slow', 
    format: 'mp4',
    audio_codec: 'copy',
    extension: '.mp4',
    // You may need to specify the GPU device if you have multiple
    // gpu: '0', 
    additional_args: (isHDR) => [ 
      '-vf', 'scale=1280:-2', // Downscale to 720p
      '-preset', 'slow', 
      '-rc', 'vbr_hq',       // Rate control mode for better quality
      '-cq', '28',           // Constant quality (higher value = more compression)
      '-g', '120',           // GOP size
      '-keyint_min', '120',   // Minimum keyframe interval
      // Add more arguments as needed
      ...(isHDR
        ? [
            '-color_primaries', 'bt709',
            '-color_trc', 'bt709',
            '-colorspace', 'bt709',
          ]
        : [])
    ]
  },
  libx264: {
    codec: 'libx264',
    preset: 'medium',
    crf: '23',
    format: 'mp4',
    audio_codec: 'aac',
    extension: '.mp4',
    vf: (isHDR) => [
      // First step: downscale to width 1280 while preserving aspect ratio
      'scale=1280:-1',
      // HDR or SDR filters:
      ...(isHDR
        ? [
            'zscale=t=linear:npl=100,format=gbrp16le', // Linearize HDR input to 16-bit GBR planar
            'zscale=p=bt709',                          // Convert to SDR Rec.709
            'tonemap=tonemap=hable:peak=100',          // Hable tonemapping for HDR->SDR
            'zscale=t=bt709:m=bt709:r=tv',             // Rec.709 limited range
            'format=yuv420p',                          // Convert to YUV420p for encoding
          ]
        : [
            'zscale=t=linear:npl=100,format=gbrp', // Linearize SDR input
            'zscale=p=bt709',                      // Ensure Rec.709 colorspace
            'format=yuv420p',                      // Convert to YUV420p for encoding
          ]
      ),
      // Ensure even dimensions after scaling
      'pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2',
    ].join(','),
    additional_args: (isHDR) => [
      '-preset', 'veryfast',
      '-crf', '20',
      '-profile:v', 'high',
      '-level', '4.1',
      '-movflags', '+faststart',
      //'-maxrate', '4M',
      //'-bufsize', '8M',
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
        : [])
    ]
  }
};

export const hevc_nvenc = encoderConfigs.hevc_nvenc;
export const vp9_vaapi = encoderConfigs.vp9_vaapi;
export const hevc_vaapi = encoderConfigs.hevc_vaapi;
export const libx264 = encoderConfigs.libx264;

//export default encoderConfigs;