// hardwareAcceleration.js
const { exec } = require('child_process');
const os = require('os');

let cachedResult = null;

/**
 * Executes a shell command and returns the stdout as a string.
 * @param {string} cmd - The command to execute.
 * @returns {Promise<string>} - The stdout from the command.
 */
function executeCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Checks if a command exists in the system.
 * @param {string} cmd - The command to check.
 * @returns {Promise<boolean>} - True if the command exists, else false.
 */
async function commandExists(cmd) {
  try {
    await executeCommand(`which ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if ffmpeg supports any hardware-accelerated encoders.
 * @returns {Promise<{encoder: string, name: string}[]>} - List of supported hardware encoders.
 */
async function getSupportedHardwareEncoders() {
  try {
    const output = await executeCommand('ffmpeg -encoders');
    const hardwareEncoders = [
      // Unified VAAPI Encoder (if available)
      { encoder: 'vaapi', name: 'VAAPI (Unified)' },
      // Per-codec VAAPI Encoders
      { encoder: 'vp9_vaapi', name: 'VP9 (VAAPI)' },
      { encoder: 'h264_vaapi', name: 'H.264/AVC (VAAPI)' },
      { encoder: 'hevc_vaapi', name: 'H.265/HEVC (VAAPI)' },
      { encoder: 'av1_vaapi', name: 'AV1 (VAAPI)' },
      // NVIDIA Encoders
      { encoder: 'h264_nvenc', name: 'NVIDIA NVENC H.264' },
      { encoder: 'hevc_nvenc', name: 'NVIDIA NVENC HEVC' },
      // Intel QSV Encoders
      { encoder: 'vp9_qsv', name: 'VP9 (Quick Sync Video)' },
      { encoder: 'h264_qsv', name: 'H.264 (Quick Sync Video)' },
      { encoder: 'hevc_qsv', name: 'H.265/HEVC (Quick Sync Video)' },
      // AMD AMF Encoders
      { encoder: 'h264_amf', name: 'AMD AMF H.264' },
      { encoder: 'hevc_amf', name: 'AMD AMF HEVC' },
      // macOS VideoToolbox Encoders
      { encoder: 'h264_videotoolbox', name: 'Apple VideoToolbox H.264' },
      { encoder: 'hevc_videotoolbox', name: 'Apple VideoToolbox HEVC' },
      // Add more hardware encoders as needed
    ];

    // Filter encoders that are present in ffmpeg's output
    const availableEncoders = hardwareEncoders.filter(he => {
      // Use regex to ensure exact match
      const regex = new RegExp(`\\b${he.encoder}\\b`, 'i');
      return regex.test(output);
    });

    console.log('Available Hardware Encoders after filtering:', availableEncoders);

    return availableEncoders;
  } catch (error) {
    console.error('Error checking ffmpeg encoders:', error);
    return [];
  }
}

/**
 * Detects system GPU information.
 * @returns {Promise<{vendor: string, name: string}[]>} - List of GPUs in the system.
 */
async function getSystemGPUs() {
  const platform = os.platform();

  try {
    if (platform === 'win32') {
      // Windows: Use 'wmic' to get GPU info
      const output = await executeCommand('wmic path win32_VideoController get name,AdapterCompatibility /format:list');
      const gpuLines = output.split(/\r?\n/).filter(line => line.trim() !== '');
      const gpus = [];
      let gpu = {};

      gpuLines.forEach(line => {
        if (line.startsWith('Name=')) {
          gpu.name = line.split('=')[1].trim();
        }
        if (line.startsWith('AdapterCompatibility=')) {
          gpu.vendor = line.split('=')[1].trim();
          if (gpu.name && gpu.vendor) {
            gpus.push({ ...gpu });
            gpu = {};
          }
        }
      });

      console.log('Detected GPUs (Windows):', gpus);
      return gpus;
    } else if (platform === 'linux') {
      // Linux: Use 'lspci' to list GPUs
      const hasLspci = await commandExists('lspci');
      if (!hasLspci) {
        console.warn("'lspci' command not found. Skipping GPU detection on Linux.");
        return [];
      }

      const output = await executeCommand("lspci | grep -E 'VGA|3D|Display'");
      if (!output) {
        console.warn('No GPU devices found via lspci.');
        return [];
      }

      const gpus = output.split(/\r?\n/).map(line => {
        // Example line: "05:00.0 VGA compatible controller: Intel Corporation DG2 [Arc A380] (rev 05)"
        const parts = line.split(': ');
        if (parts.length >= 2) {
          const vendorInfo = parts[1].split(' ')[0];
          const name = parts[1].replace(/\(rev .*?\)/, '').trim();
          let vendor = 'Unknown';
          if (vendorInfo.includes('NVIDIA')) vendor = 'NVIDIA';
          else if (vendorInfo.includes('AMD') || vendorInfo.includes('ATI')) vendor = 'AMD';
          else if (vendorInfo.includes('Intel')) vendor = 'Intel';
          return { vendor, name };
        }
        return null;
      }).filter(gpu => gpu !== null);

      console.log('Detected GPUs (Linux):', gpus);
      return gpus;
    } else if (platform === 'darwin') {
      // macOS: Use 'system_profiler SPDisplaysDataType'
      const output = await executeCommand('system_profiler SPDisplaysDataType');
      const gpuLines = output.split(/\r?\n/).filter(line => line.trim().startsWith('Chipset Model:'));
      const gpus = gpuLines.map(line => {
        const name = line.split(':')[1].trim();
        let vendor = 'Unknown';
        if (name.includes('AMD') || name.includes('ATI')) vendor = 'AMD';
        else if (name.includes('NVIDIA')) vendor = 'NVIDIA';
        else if (name.includes('Intel')) vendor = 'Intel';
        return { vendor, name };
      });
      console.log('Detected GPUs (macOS):', gpus);
      return gpus;
    } else {
      console.warn('Unsupported platform for GPU detection:', platform);
      return [];
    }
  } catch (error) {
    console.error('Error detecting system GPUs:', error);
    return [];
  }
}

/**
 * Determines the best available hardware encoder based on ffmpeg support and system GPUs.
 * @returns {Promise<{encoder: string, name: string, deviceInfo: any} | null>} - Selected encoder and device info.
 */
async function determineBestEncoder() {
  const [availableEncoders, systemGPUs] = await Promise.all([
    getSupportedHardwareEncoders(),
    getSystemGPUs(),
  ]);

  console.log('Available Encoders:', availableEncoders);
  console.log('System GPUs:', systemGPUs);

  if (!Array.isArray(availableEncoders) || availableEncoders.length === 0) {
    console.warn('No hardware encoders available.');
    return null;
  }

  if (!Array.isArray(systemGPUs) || systemGPUs.length === 0) {
    console.warn('No GPUs detected.');
    return null;
  }

  // Define encoder priority (optional)
  const encoderPriority = [
    'vp9_vaapi',     // VAAPI VP9 encoder
    'vp9_qsv',       // Quick Sync VP9 encoder
    'vaapi',         // Unified VAAPI encoder
    'h264_vaapi',    // VAAPI H.264 encoder
    'h264_qsv',      // Quick Sync H.264 encoder
    'h264_nvenc',    // NVIDIA NVENC H.264
    'hevc_vaapi',    // VAAPI HEVC encoder
    'hevc_qsv',      // Quick Sync HEVC encoder
    'hevc_nvenc',    // NVIDIA NVENC HEVC
    'av1_vaapi',     // VAAPI AV1 encoder
    'h264_amf',      // AMD AMF H.264
    'hevc_amf',      // AMD AMF HEVC
    'h264_videotoolbox', // Apple VideoToolbox H.264
    'hevc_videotoolbox', // Apple VideoToolbox HEVC
    // Add more encoders as needed
  ];

  // Sort available encoders based on priority
  availableEncoders.sort((a, b) => {
    return encoderPriority.indexOf(a.encoder) - encoderPriority.indexOf(b.encoder);
  });

  console.log('Available Encoders after sorting:', availableEncoders);

  // Iterate through sorted encoders and match with GPUs
  for (const encoder of availableEncoders) {
    for (const gpu of systemGPUs) {
      const vendor = gpu.vendor.toLowerCase();
      if (
        (encoder.encoder.includes('vaapi') && vendor === 'intel') ||
        (encoder.encoder.includes('qsv') && vendor === 'intel') ||
        (encoder.encoder.includes('nvenc') && vendor === 'nvidia') ||
        (encoder.encoder.includes('amf') && vendor === 'amd') ||
        (encoder.encoder.includes('videotoolbox') && os.platform() === 'darwin')
      ) {
        console.log(`Selected Encoder: ${encoder.name} (${encoder.encoder}) for GPU: ${gpu.name}`);
        return { encoder, deviceInfo: gpu };
      }
    }
  }

  console.warn('No matching encoder found for detected GPUs.');
  return null;
}

/**
 * Retrieves hardware acceleration information, caching the result after the first check.
 * @returns {Promise<{encoder: string, name: string, deviceInfo: any} | null>} - Encoder info or null.
 */
async function getHardwareAccelerationInfo() {
  if (cachedResult !== null) {
    return cachedResult;
  }

  const bestEncoder = await determineBestEncoder();
  cachedResult = bestEncoder;
  if (bestEncoder) {
    console.log(`Selected hardware encoder: ${bestEncoder.encoder.name} (${bestEncoder.encoder.encoder})`);
  } else {
    console.log('No suitable hardware encoder found. Falling back to software encoding.');
  }
  return cachedResult;
}

module.exports = {
  getHardwareAccelerationInfo,
};
