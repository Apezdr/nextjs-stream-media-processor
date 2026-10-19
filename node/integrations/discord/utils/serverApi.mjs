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
export async function getSystemStatus() {
  const client = new ServerApiClient();
  return await client.getSystemStatus();
}

export default ServerApiClient;