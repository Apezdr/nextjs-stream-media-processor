import axios from 'axios';
import { createCategoryLogger } from '../../../lib/logger.mjs';

const logger = createCategoryLogger('discordBot:serverApi');

/**
 * Utility class for making API calls to the backend server
 */
export class ServerApiClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl || process.env.SERVER_API_URL;
    this.apiKey = apiKey || process.env.SERVER_API_KEY;
    
    if (!this.baseUrl) {
      throw new Error('SERVER_API_URL is required');
    }
  }
  
  /**
   * Get current system status
   * @returns {Promise<object>} System status data
   */
  async getSystemStatus() {
    try {
      const response = await axios.get(`${this.baseUrl}/api/system-status`, {
        headers: this.getHeaders(),
        timeout: 10000
      });
      return response.data;
    } catch (error) {
      logger.error(`Failed to fetch system status: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Trigger a system status check
   * @param {string} forceStatus - Optional status to force
   * @param {string} message - Optional custom message
   * @returns {Promise<object>} Trigger result
   */
  async triggerStatusCheck(forceStatus = null, message = null) {
    try {
      const params = {};
      if (forceStatus) params.forceStatus = forceStatus;
      if (message) params.message = message;
      
      const response = await axios.post(
        `${this.baseUrl}/api/trigger-system-status`,
        {},
        {
          headers: this.getHeaders(),
          params,
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      logger.error(`Failed to trigger status check: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get current task manager status
   * @returns {Promise<object>} Task status data
   */
  async getTasks() {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tasks`, {
        headers: this.getHeaders(),
        timeout: 10000
      });
      return response.data;
    } catch (error) {
      logger.error(`Failed to fetch task status: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get request headers with authentication
   * @returns {object} Headers object
   */
  getHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (this.apiKey) {
      headers['X-Webhook-ID'] = this.apiKey;
    }
    
    return headers;
  }
}

// Helper function to get system status without instantiating the class
export async function getSystemStatus(bypassCache = false) {
  const client = new ServerApiClient();
  
  if (bypassCache) {
    try {
      // Use trigger endpoint to force a fresh check
      const result = await client.triggerStatusCheck();
      
      // The trigger endpoint returns: { success: true, message: '...', status: { ... } }
      // Extract the status object
      if (result && result.status) {
        return result.status;
      }
      
      // If structure is unexpected, fall back to regular endpoint
      logger.warn('Unexpected trigger response structure, falling back to regular endpoint');
      return await client.getSystemStatus();
    } catch (error) {
      logger.error(`Error bypassing cache: ${error.message}, falling back to regular endpoint`);
      return await client.getSystemStatus();
    }
  }
  
  return await client.getSystemStatus();
}

// Helper function to trigger status check
export async function triggerStatusCheck(forceStatus = null, message = null) {
  const client = new ServerApiClient();
  return await client.triggerStatusCheck(forceStatus, message);
}

export default ServerApiClient;