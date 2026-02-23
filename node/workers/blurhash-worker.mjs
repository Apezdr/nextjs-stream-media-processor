import { encode, decode } from 'blurhash';
import { createCategoryLogger } from '../lib/logger.mjs';

const logger = createCategoryLogger('blurhash-worker');

/**
 * Blurhash worker thread function
 * Handles CPU-intensive encode/decode operations off the main thread
 * 
 * @param {Object} task - Task object
 * @param {string} task.operation - 'encode' or 'decode'
 * @param {ArrayBuffer} task.pixels - Pixel data (for encode)
 * @param {number} task.width - Image width
 * @param {number} task.height - Image height
 * @param {number} task.xComp - X components for encoding
 * @param {number} task.yComp - Y components for encoding
 * @param {string} task.hash - Blurhash string (for decode)
 * @returns {string|Uint8ClampedArray} Blurhash string or pixel array
 */
export default function blurhashWorker({ operation, pixels, width, height, xComp, yComp, hash }) {
  try {
    if (operation === 'encode') {
      if (!pixels || !width || !height || !xComp || !yComp) {
        throw new Error('Missing required parameters for encode operation');
      }
      
      // Convert ArrayBuffer to Uint8ClampedArray for blurhash
      const pixelArray = new Uint8ClampedArray(pixels);
      
      // Encode blurhash (CPU-intensive operation runs in worker thread)
      const blurhashString = encode(pixelArray, width, height, xComp, yComp);
      
      logger.debug(`Encoded blurhash for ${width}x${height} image: ${blurhashString.substring(0, 10)}...`);
      
      return blurhashString;
    }
    
    if (operation === 'decode') {
      if (!hash || !width || !height) {
        throw new Error('Missing required parameters for decode operation');
      }
      
      // Decode blurhash to pixel array (CPU-intensive operation runs in worker thread)
      const decodedPixels = decode(hash, width, height);
      
      logger.debug(`Decoded blurhash to ${width}x${height} pixels`);
      
      // Return as Uint8ClampedArray - Piscina will serialize as Uint8Array
      return decodedPixels;
    }
    
    throw new Error(`Unknown operation: ${operation}`);
    
  } catch (error) {
    logger.error(`Blurhash worker error: ${error.message}`);
    throw error; // Re-throw to be handled by pool
  }
}