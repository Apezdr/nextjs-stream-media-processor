import sharp from 'sharp';
import { createCategoryLogger } from '../lib/logger.mjs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const logger = createCategoryLogger('backdrop-focal');

const __dirname = dirname(fileURLToPath(import.meta.url));

const LUMA_THRESHOLD = 8;

// Models ship inside the @vladmandic/face-api package at /model/.
const MODELS_PATH = join(__dirname, '../node_modules/@vladmandic/face-api/model');

// -- Face-API lazy singleton --
let _faceApiPromise = null;

async function getFaceApi() {
  if (!_faceApiPromise) {
    _faceApiPromise = _initFaceApi();
  }
  return _faceApiPromise;
}

async function _initFaceApi() {
  // Attempt 1: native tfjs-node backend
  try {
    await import('@tensorflow/tfjs-node');
    const { default: faceapi } = await import('@vladmandic/face-api');
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_PATH);
    logger.debug('backdrop-focal: face-api ready (tfjs-node native backend)');
    return faceapi;
  } catch {
    // Fall through to WASM
  }

  // Attempt 2: WASM backend (no native compilation required)
  try {
    const tf = await import('@tensorflow/tfjs');
    await import('@tensorflow/tfjs-backend-wasm');
    await tf.setBackend('wasm');
    await tf.ready();
    const faceapiMod = await import('@vladmandic/face-api/dist/face-api.node-wasm.js');
    const faceapi = faceapiMod.default ?? faceapiMod;
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_PATH);
    logger.debug('backdrop-focal: face-api ready (WASM backend)');
    return faceapi;
  } catch (err) {
    logger.warn(`backdrop-focal: face detection disabled - ${err.message}`);
    return null;
  }
}

// -- Face centroid detection --

async function detectFaceCentroidX(input) {
  const faceapi = await getFaceApi();
  if (!faceapi) return null;

  try {
    const { data, info } = await sharp(input)
      .resize({ width: 640, withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const tf = await import('@tensorflow/tfjs');
    const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);

    try {
      const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 });
      const detections = await faceapi.detectAllFaces(tensor, options);
      if (!detections?.length) return null;

      let wX = 0, wTotal = 0;
      for (const det of detections) {
        const { x, width: bw, height: bh } = det.box;
        const area = bw * bh;
        wX += (x + bw / 2) * area;
        wTotal += area;
      }
      return (wX / wTotal) / info.width;
    } finally {
      tensor.dispose();
    }
  } catch (err) {
    logger.warn(`backdrop-focal: face detection error - ${err.message}`);
    return null;
  }
}

// -- Luma helpers --

async function columnLuma(input, region) {
  const extracted = await sharp(input).extract(region).toBuffer();
  const stats = await sharp(extracted).grayscale().stats();
  return stats.channels[0].mean;
}

function lumaToFocal(lumaLeft, lumaCenter, lumaRight) {
  const columns = [
    { side: 'left',   luma: lumaLeft   },
    { side: 'center', luma: lumaCenter },
    { side: 'right',  luma: lumaRight  },
  ];
  const [darkest, middle, brightest] = [...columns].sort((a, b) => a.luma - b.luma);

  if (brightest.luma - darkest.luma < LUMA_THRESHOLD) return 'center';
  if (lumaCenter > lumaLeft && lumaCenter > lumaRight) return 'center';

  if (
    middle.side === 'center' &&
    darkest.luma < middle.luma &&
    middle.luma < brightest.luma &&
    (brightest.luma - middle.luma) < (middle.luma - darkest.luma) * 0.6
  ) {
    return 'center';
  }

  const darkGap = middle.luma - darkest.luma;
  if (darkGap < LUMA_THRESHOLD) return brightest.side;

  const OPPOSITE = { left: 'right', right: 'left', center: 'center' };
  return OPPOSITE[darkest.side];
}

// -- Public API --

export async function detectBackdropFocal(input) {
  try {
    const { width, height } = await sharp(input).metadata();
    if (!width || !height) return 'center';

    const colW = Math.floor(width / 3);

    const [faceCentroidX, lumaLeft, lumaCenter, lumaRight] = await Promise.all([
      detectFaceCentroidX(input).catch(() => null),
      columnLuma(input, { left: 0,       top: 0, width: colW,             height }),
      columnLuma(input, { left: colW,     top: 0, width: colW,             height }),
      columnLuma(input, { left: colW * 2, top: 0, width: width - colW * 2, height }),
    ]);

    const lumaResult = lumaToFocal(lumaLeft, lumaCenter, lumaRight);

    // Face-based refinement using area-weighted centroid in [0, 1].
    // Thresholds (0.40 / 0.60 / 0.30 / 0.30) chosen against labelled fixtures;
    // face must clearly contradict or confirm luma before we promote a result.
    let result = lumaResult;
    if (faceCentroidX !== null) {
      if (lumaResult === 'center') {
        if (faceCentroidX > 0.60) result = 'center-right';
        else if (faceCentroidX < 0.30) result = 'center-left';
      } else if (lumaResult === 'left') {
        if (faceCentroidX >= 0.60) result = 'center-right';
        else if (faceCentroidX >  0.40) result = 'center';
      } else if (lumaResult === 'right') {
        if (faceCentroidX <= 0.40) result = 'center-left';
        else if (faceCentroidX <  0.60) result = 'center';
      }
    }

    const inputLabel = typeof input === 'string' ? input : '(buffer)';
    logger.info(`backdrop-focal: ${result} (luma=${lumaResult}, face=${faceCentroidX !== null ? faceCentroidX.toFixed(3) : 'none'}) for ${inputLabel}`);

    return result;

  } catch (err) {
    logger.warn(`Backdrop focal detection failed for input: ${err.message}`);
    return 'center';
  }
}