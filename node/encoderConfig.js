// encoderConfigs.js

const encoderConfigs = {
  vp9_vaapi: {
    codec: 'vp9_vaapi',
    vaapi_device: '/dev/dri/renderD128',
    // Base VF config for SDR content
    vf: 'scale=1920:-2,format=nv12,hwupload',
    // Updated HDR video filter chain to match the new manual command
    hdr_vf: 'scale=1920:-2,zscale=t=linear:npl=100,format=gbrp16le,zscale=p=bt709,tonemap=tonemap=hable:peak=100,zscale=t=bt709:m=bt709:r=tv,format=nv12,hwupload',
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
  libx264: {
    codec: 'libx264',
    preset: 'medium',
    crf: '23',
    format: 'mp4',
    audio_codec: 'aac',
    extension: '.mp4',
    vf: (isHDR) => [
      // Base video filters for SDR or HDR
      isHDR
        ? [
            'zscale=t=linear:npl=100,format=gbrp16le', // Linearize HDR input to 16-bit GBR planar format
            'zscale=p=bt709', // Convert to SDR Rec.709
            'tonemap=tonemap=hable:peak=100', // Apply Hable tonemapping for HDR->SDR conversion
            'zscale=t=bt709:m=bt709:r=tv', // Convert to Rec.709 limited range
            'format=yuv420p', // Convert to 8-bit YUV planar for encoding
          ]
        : [
            'zscale=t=linear:npl=100,format=gbrp', // Linearize SDR input
            'zscale=p=bt709', // Ensure Rec.709 colorspace
            'format=yuv420p', // Convert to 8-bit YUV planar for encoding
          ],
      'pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2', // Ensure dimensions are even
    ].flat().join(','), // Join the filter chain into a single string
    additional_args: (isHDR) => [
      '-profile:v', 'high',
      '-level', '4.1',
      '-movflags', '+faststart',
      '-maxrate', '4M',
      '-bufsize', '8M',
      '-g', '48',
      '-keyint_min', '48',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      // Conditional arguments for HDR
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

module.exports = encoderConfigs;