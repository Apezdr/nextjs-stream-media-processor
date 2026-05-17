import { createCategoryLogger } from "./lib/logger.mjs";
import { mongoClient } from "./lib/mongo.mjs";

const logger = createCategoryLogger("mongoDB");

export async function getClient() {
  return mongoClient;
}

// Helper to get commonly used databases
export async function getMediaDb() {
  const client = await getClient();
  return client.db("Media");
}

export async function getCacheDb() {
  const client = await getClient();
  return client.db("Cache");
}

export async function getUsersDb() {
  const client = await getClient();
  return client.db("Users");
}

export async function getAppConfigDb() {
  const client = await getClient();
  return client.db("app_config");
}


/**
 * Ensures that an index exists on the specified collection.
 * If the index does not exist, it creates the index with the provided specifications and options.
 *
 * @param {Collection} collection - The MongoDB collection.
 * @param {Object} indexSpec - The specification of the index fields.
 * @param {Object} indexOptions - The options for the index (e.g., name, expireAfterSeconds).
 */
async function ensureIndex(collection, indexSpec, indexOptions) {
  const indexes = await collection.indexes();
  const indexExists = indexes.some((index) => {
    // Compare index keys
    return JSON.stringify(index.key) === JSON.stringify(indexSpec);
  });

  if (!indexExists) {
    await collection.createIndex(indexSpec, indexOptions);
    logger.info(
      `Created index: ${indexOptions.name} on collection: ${collection.collectionName}`
    );
  } else {
    logger.info(
      `Index: ${indexOptions.name} already exists on collection: ${collection.collectionName}`
    );
  }
}

export async function initializeMongoDatabase() {
  const client = await getClient();
  try {
    const mediaDb = client.db("Media");
    const cacheDB = client.db("Cache");

    // Ensure collections in Media database
    const collections = await mediaDb.listCollections().toArray();
    const collectionNames = collections.map((col) => col.name);

    if (!collectionNames.includes("Movies")) {
      await mediaDb.createCollection("Movies");
      logger.info("Created collection: Movies");
    }

    if (!collectionNames.includes("TV")) {
      await mediaDb.createCollection("TV");
      logger.info("Created collection: TV");
    }

    // Ensure collections in PlaybackStatus database
    const mediaCollection = await mediaDb.listCollections().toArray();
    const mediaCollectionNames = mediaCollection.map((col) => col.name);

    if (!mediaCollectionNames.includes("PlaybackStatus")) {
      await mediaDb.createCollection("PlaybackStatus");
      logger.info("Created collection: PlaybackStatus");
    }

    // Ensure collections in Cache database
    const cacheCollections = await cacheDB.listCollections().toArray();
    const cacheCollectionNames = cacheCollections.map((col) => col.name);
    if (!cacheCollectionNames.includes("cacheEntries")) {
      await cacheDB.createCollection("cacheEntries");
      logger.info("Created collection: cacheEntries");
    }

    logger.info("Database and collections have been initialized successfully.");
  } catch (error) {
    logger.error(
      "An error occurred while initializing the database and collections:" +
        error
    );
    process.exit(1); // Exit with error
  }
}

/**
 * Initializes the indexes for all relevant collections.
 * Ensures that each index exists, creating it if necessary.
 */
export async function initializeIndexes() {
  const client = await getClient();
  try {
    const mediaDb = client.db("Media");
    const cacheDB = client.db("Cache");

    // Ensure indexes on Media.Movies collection
    const moviesCollection = mediaDb.collection("Movies");
    await ensureIndex(
      moviesCollection,
      { videoURL: 1 },
      { name: "video_lookup" }
    );

    await ensureIndex(
      moviesCollection,
      { mediaLastModified: -1 },
      { name: "mediaLastModified" }
    );

    // title lookup
    await ensureIndex(moviesCollection, { title: 1 }, { name: "title_lookup" });

    // release date lookup
    await ensureIndex(
      moviesCollection,
      { "metadata.release_date": -1 },
      { name: "release_date" }
    );

    // genres id lookup
    await ensureIndex(
      moviesCollection,
      {
        "metadata.genres.id": 1,
        title: 1,
      },
      { name: "genres_id_lookup" }
    );
    
    // Ensure indexes on Media.TV collection
    const tvCollection = mediaDb.collection("TV");
    await ensureIndex(
      tvCollection,
      { "seasons.episodes.videoURL": 1 },
      { name: "episode_lookup" }
    );
    // Keep the title index as it might be useful for other queries
    await ensureIndex(tvCollection, { title: -1 }, { name: "title_index" });

    // Track the last modified date of the episodes
    await ensureIndex(
      tvCollection,
      { "seasons.episodes.mediaLastModified": -1 },
      { name: "episode_last_modified" }
    );

    // Genres id lookup
    await ensureIndex(
      tvCollection,
      { "metadata.genres.id": 1 },
      { name: "genres_id_index" }
    );

    // Ensure indexes on PlaybackStatus collection
    const playbackStatusCollection = mediaDb.collection("PlaybackStatus");
    // Compound index for user watch history
    await ensureIndex(
      playbackStatusCollection,
      {
        userId: 1,
        "videosWatched.lastUpdated": -1,
      },
      { name: "user_watchHistory" }
    );

    // Single field index on userId
    await ensureIndex(
      playbackStatusCollection,
      {
        userId: 1,
      },
      { name: "user_lookup" }
    );

    // Compound index for user video lookup
    await ensureIndex(
      playbackStatusCollection,
      {
        userId: 1,
        "videosWatched.videoId": 1,
      },
      { name: "user_videowatched_lookup" }
    );

    // Ensure indexes on Cache collection
    const cacheCollection = cacheDB.collection("cacheEntries");

    // 1. Create a text index on the 'url' field
    await ensureIndex(
      cacheCollection,
      { url: "text" },
      { name: "url_text_index", background: true }
    );

    // 2. Create a TTL index on the 'timestamp' field
    await ensureIndex(
      cacheCollection,
      { timestamp: 1 },
      {
        name: "cache_ttl_index",
        expireAfterSeconds: 7 * 24 * 60 * 60, // Example: 7 days
      }
    );

    // Ensure a unique index on app_config.settings.name so each setting
    // (autoSync, autoCaptions, ...) can only have one document.
    const appConfigDb = client.db("app_config");
    const settingsCollection = appConfigDb.collection("settings");
    // Detect an existing non-unique index on the same key — the generic
    // ensureIndex helper would short-circuit on key match alone, leaving the
    // constraint unenforced. Drop it so we can recreate as unique.
    const settingsIndexes = await settingsCollection.indexes();
    const existingNameIdx = settingsIndexes.find(
      (i) => JSON.stringify(i.key) === JSON.stringify({ name: 1 })
    );
    if (existingNameIdx && !existingNameIdx.unique) {
      logger.warn(
        `Found non-unique index "${existingNameIdx.name}" on app_config.settings.name; dropping to recreate as unique`
      );
      await settingsCollection.dropIndex(existingNameIdx.name);
    }
    try {
      await ensureIndex(
        settingsCollection,
        { name: 1 },
        { name: "settings_name_unique", unique: true }
      );
    } catch (err) {
      // Duplicate keys block index creation. Surface the offenders so an
      // operator can resolve manually — don't crash the whole app over this.
      if (err && (err.code === 11000 || /E11000|duplicate key/i.test(err.message || ""))) {
        const dupes = await settingsCollection
          .aggregate([
            { $group: { _id: "$name", count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
          ])
          .toArray();
        logger.error(
          `Cannot create unique index on app_config.settings.name — duplicates exist: ${JSON.stringify(
            dupes.map((d) => ({ name: d._id, count: d.count }))
          )}. Keep one document per name and restart to enforce uniqueness.`
        );
      } else {
        throw err;
      }
    }

    logger.info("Indexes have been initialized successfully.");
  } catch (error) {
    logger.error("An error occurred while initializing indexes:" + error);
    process.exit(1); // Exit with error
  }
}

export async function checkAutoSync() {
  try {
    const db = await getAppConfigDb();
    const settings = db.collection("settings");

    // Try to find the autoSync setting
    let autoSyncSetting = await settings.findOne({ name: "autoSync" });

    // If it doesn't exist, initialize it to true
    if (!autoSyncSetting) {
      await settings.insertOne({ name: "autoSync", value: true });
      autoSyncSetting = { value: true };
      logger.info("Auto Sync setting initialized to true.");
    }

    // Check the value of autoSync
    return autoSyncSetting?.value === true;
  } catch (error) {
    logger.error("An error occurred:" + error);
    return false;
  }
}

export async function updateLastSyncTime() {
  try {
    const db = await getAppConfigDb();
    const syncInfo = db.collection("syncInfo");

    // Update the last sync time
    await syncInfo.updateOne(
      { _id: "lastSyncTime" },
      { $set: { timestamp: new Date() } },
      { upsert: true }
    );

    logger.info("Last sync time updated successfully.");
  } catch (error) {
    logger.error(
      "An error occurred while updating the last sync time:" + error.message
    );
    process.exit(1); // Exit with error
  }
}


/**
 * Get user by Discord ID and verify admin status.
 * Used by the Discord bot to verify admin privileges via OAuth account linking.
 * @param {string} discordUserId - Discord User ID (accountId from Discord OAuth)
 * @returns {Object|null} User object or null if not found/not admin
 */
export async function getAdminByDiscordId(discordUserId) {
  try {
    const db = await getUsersDb();

    // Find the Better Auth account linked to this Discord ID
    const account = await db.collection("account").findOne({
      providerId: "discord",
      accountId: discordUserId,
    });

    if (!account?.userId) {
      return null;
    }

    const user = await db.collection("user").findOne({ _id: account.userId });

    if (!user) {
      return null;
    }

    if (user.role !== "admin") {
      return null;
    }

    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      image: user.image,
      admin: true,
      approved: user.approved || false,
      limitedAccess: user.limitedAccess || false,
    };
  } catch (error) {
    logger.error("Error getting admin by Discord ID:" + error);
    return null;
  }
}
