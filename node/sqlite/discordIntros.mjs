import { createCategoryLogger } from '../lib/logger.mjs';
import { withRetry } from '../sqliteDatabase.mjs';

const logger = createCategoryLogger('discordIntros');

/**
 * Initialize the discord_intros table in the database
 * @param {Object} db - SQLite database connection
 */
export async function initializeDiscordIntrosTable(db) {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS discord_intros (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT UNIQUE NOT NULL,
        username TEXT,
        sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
        bot_version TEXT,
        notes TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_discord_intros_user_id ON discord_intros(user_id);
      CREATE INDEX IF NOT EXISTS idx_discord_intros_sent_at ON discord_intros(sent_at);
    `);
    
    logger.info('Discord intros table initialized');
  } catch (error) {
    logger.error(`Error initializing Discord intros table: ${error.message}`);
    throw error;
  }
}

/**
 * Check if a user has already received an introduction message
 * @param {Object} db - SQLite database connection
 * @param {string} userId - Discord user ID
 * @returns {Promise<boolean>} - True if intro was already sent
 */
export async function hasReceivedIntro(db, userId) {
  try {
    const record = await withRetry(() =>
      db.get('SELECT * FROM discord_intros WHERE user_id = ?', [userId])
    );
    
    return !!record;
  } catch (error) {
    logger.error(`Error checking intro status for user ${userId}: ${error.message}`);
    return false;
  }
}

/**
 * Record that a user has received an introduction message
 * @param {Object} db - SQLite database connection
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username (optional)
 * @param {string} botVersion - Bot version (optional)
 * @returns {Promise<void>}
 */
export async function recordIntroSent(db, userId, username = null, botVersion = null) {
  try {
    await withRetry(() =>
      db.run(
        `INSERT OR REPLACE INTO discord_intros (user_id, username, sent_at, bot_version)
         VALUES (?, ?, ?, ?)`,
        [userId, username, new Date().toISOString(), botVersion]
      )
    );
    
    logger.info(`Recorded introduction sent to user ${userId}${username ? ` (${username})` : ''}`);
  } catch (error) {
    logger.error(`Error recording intro for user ${userId}: ${error.message}`);
    throw error;
  }
}

/**
 * Get all users who have received introductions
 * @param {Object} db - SQLite database connection
 * @returns {Promise<Array>} - Array of user records
 */
export async function getAllIntroRecipients(db) {
  try {
    return await withRetry(() =>
      db.all('SELECT * FROM discord_intros ORDER BY sent_at DESC')
    );
  } catch (error) {
    logger.error(`Error getting intro recipients: ${error.message}`);
    return [];
  }
}

/**
 * Remove a user's intro record (for re-sending intro)
 * @param {Object} db - SQLite database connection
 * @param {string} userId - Discord user ID
 * @returns {Promise<number>} - Number of records deleted
 */
export async function removeIntroRecord(db, userId) {
  try {
    const result = await withRetry(() =>
      db.run('DELETE FROM discord_intros WHERE user_id = ?', [userId])
    );
    
    const deletedCount = result.changes || 0;
    if (deletedCount > 0) {
      logger.info(`Removed intro record for user ${userId}`);
    }
    
    return deletedCount;
  } catch (error) {
    logger.error(`Error removing intro record for user ${userId}: ${error.message}`);
    return 0;
  }
}

/**
 * Clear all intro records (admin function)
 * @param {Object} db - SQLite database connection
 * @returns {Promise<number>} - Number of records deleted
 */
export async function clearAllIntroRecords(db) {
  try {
    const result = await withRetry(() =>
      db.run('DELETE FROM discord_intros')
    );
    
    const deletedCount = result.changes || 0;
    logger.info(`Cleared ${deletedCount} intro records`);
    
    return deletedCount;
  } catch (error) {
    logger.error(`Error clearing intro records: ${error.message}`);
    return 0;
  }
}

/**
 * Get intro statistics
 * @param {Object} db - SQLite database connection
 * @returns {Promise<Object>} - Statistics about intro messages
 */
export async function getIntroStats(db) {
  try {
    const [total, recent] = await Promise.all([
      withRetry(() => db.get('SELECT COUNT(*) as count FROM discord_intros')),
      withRetry(() => db.get(`
        SELECT COUNT(*) as count 
        FROM discord_intros 
        WHERE sent_at > datetime('now', '-7 days')
      `))
    ]);
    
    const oldest = await withRetry(() => db.get(`
      SELECT user_id, username, sent_at 
      FROM discord_intros 
      ORDER BY sent_at ASC 
      LIMIT 1
    `));
    
    const newest = await withRetry(() => db.get(`
      SELECT user_id, username, sent_at 
      FROM discord_intros 
      ORDER BY sent_at DESC 
      LIMIT 1
    `));
    
    return {
      total: total.count,
      lastSevenDays: recent.count,
      oldestIntro: oldest,
      newestIntro: newest
    };
  } catch (error) {
    logger.error(`Error getting intro stats: ${error.message}`);
    return {
      total: 0,
      lastSevenDays: 0,
      oldestIntro: null,
      newestIntro: null
    };
  }
}