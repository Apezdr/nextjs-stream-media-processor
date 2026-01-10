import { MongoClient, ObjectId } from "mongodb";
import { createCategoryLogger } from "./lib/logger.mjs";

const logger = createCategoryLogger("mongoDB");
const uri = process.env.MONGODB_URI;

// Singleton client instance
let client = null;
let clientPromise = null;

/**
 * Get or create the MongoDB client connection.
 * Reuses the same connection across all calls.
 */
export async function getClient() {
  if (client) {
    // Verify the client is actually connected
    try {
      if (client.topology && client.topology.isConnected()) {
        return client;
      } else {
        logger.warn("MongoDB client exists but is not connected, reinitializing...");
        client = null;
        clientPromise = null;
      }
    } catch (error) {
      logger.warn("Error checking MongoDB client state, reinitializing:", error.message);
      client = null;
      clientPromise = null;
    }
  }

  if (!clientPromise) {
    logger.info("Initializing new MongoDB connection...");
    client = new MongoClient(uri, {
      maxPoolSize: 10, // adjust based on your workload
      minPoolSize: 2, // keep some connections warm
      maxIdleTimeMS: 60000, // close idle connections after 60s
    });
    clientPromise = client.connect();
  }

  try {
    await clientPromise;
    logger.info("MongoDB connection established successfully");
    return client;
  } catch (error) {
    logger.error(`MongoDB connection failed: ${error.message}`);
    // Reset state on failure
    client = null;
    clientPromise = null;
    throw error;
  }
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
 * Close the MongoDB connection and reset client state
 */
export async function closeConnection() {
  if (client) {
    await client.close();
    client = null;
    clientPromise = null;
    logger.info("MongoDB connection closed");
  }
}

// Register shutdown handlers
process.on("SIGINT", async () => {
  await closeConnection();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeConnection();
  process.exit(0);
});

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
 * Authenticate user using mobile token from authSessions collection
 * @param {string} mobileToken - The mobile session token
 * @returns {Object|null} User object or null if authentication fails
 */
export async function authenticateWithMobileToken(mobileToken) {
  try {
    const db = await getUsersDb();

    const authSession = await db.collection("authSessions").findOne({
      "tokens.mobileSessionToken": mobileToken,
      status: "complete",
    });

    if (authSession && authSession.tokens?.user?.id) {
      // Get fresh user data from AuthenticatedUsers
      const userObjectId = new ObjectId(authSession.tokens.user.id);
      const userData = await db
        .collection("AuthenticatedUsers")
        .findOne({ _id: userObjectId });

      if (userData) {
        return {
          id: userData._id.toString(),
          email: userData.email,
          name: userData.name,
          image: userData.image,
          approved: userData.approved || false,
          limitedAccess: userData.limitedAccess || false,
          admin: userData.admin || false,
        };
      }
    }

    return null;
  } catch (error) {
    logger.error("Error authenticating with mobile token:" + error);
    return null;
  }
}

/**
 * Authenticate user using regular Next.js session token
 * @param {string} token - The session token or session ID
 * @returns {Object|null} User object or null if authentication fails
 */
export async function authenticateWithSessionToken(token) {
  try {
    const db = await getUsersDb();

    // Try to find session by sessionToken (Next.js session)
    let session = await db.collection("session").findOne({
      sessionToken: token,
      expires: { $gt: new Date() },
    });

    // If not found, try by ObjectId (session ID)
    if (!session) {
      try {
        const sessionId = new ObjectId(token);
        session = await db.collection("session").findOne({
          _id: sessionId,
          expires: { $gt: new Date() },
        });
      } catch (error) {
        // Invalid ObjectId format, return null
        return null;
      }
    }

    if (!session) {
      return null;
    }

    // Get user details
    const userData = await db
      .collection("AuthenticatedUsers")
      .findOne({ _id: session.userId });

    if (!userData) {
      return null;
    }

    return {
      id: userData._id.toString(),
      email: userData.email,
      name: userData.name,
      image: userData.image,
      approved: userData.approved || false,
      limitedAccess: userData.limitedAccess || false,
      admin: userData.admin || false,
    };
  } catch (error) {
    logger.error("Error authenticating with session token:" + error);
    return null;
  }
}

/**
 * Get user by session ID for real-time updates
 * @param {string} sessionId - The session ID
 * @returns {Object|null} User object or null if not found
 */
export async function getUserBySessionId(sessionId) {
  try {
    const db = await getUsersDb();
    
    const sessionIdObjectId = new ObjectId(sessionId);
    const session = await db
      .collection("session")
      .findOne({ _id: sessionIdObjectId });

    if (!session) return null;

    const user = await db
      .collection("AuthenticatedUsers")
      .findOne({ _id: session.userId });

    if (!user) return null;

    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      image: user.image,
      approved: user.approved || false,
      limitedAccess: user.limitedAccess || false,
      admin: user.admin || false,
    };
  } catch (error) {
    logger.error("Error getting user by session ID:" + error);
    return null;
  }
}

/**
 * Get user by mobile token
 * @param {string} mobileToken - The mobile session token
 * @returns {Object|null} User object or null if not found
 */
export async function getUserByMobileToken(mobileToken) {
  try {
    const db = await getUsersDb();

    // Find the auth session that contains this mobile token
    const authSession = await db.collection("authSessions").findOne({
      "tokens.mobileSessionToken": mobileToken,
      status: "complete",
    });

    if (!authSession || !authSession.tokens?.user?.id) {
      return null;
    }

    // Get the fresh user data from AuthenticatedUsers (single source of truth)
    const userObjectId = new ObjectId(authSession.tokens.user.id);
    const user = await db
      .collection("AuthenticatedUsers")
      .findOne({ _id: userObjectId });

    if (!user) return null;

    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      image: user.image,
      approved: user.approved || false,
      limitedAccess: user.limitedAccess || false,
      admin: user.admin || false,
    };
  } catch (error) {
    logger.error("Error getting user by mobile token:" + error);
    return null;
  }
}

/**
 * Get user by Discord ID and verify admin status
 * Uses SSO OAuth linking to find Discord accounts
 * @param {string} discordUserId - Discord User ID (providerAccountId from Discord OAuth)
 * @returns {Object|null} User object or null if not found/not admin
 */
export async function getAdminByDiscordId(discordUserId) {
  try {
    const db = await getUsersDb();

    // First, find the SSO account linked to this Discord ID
    const ssoAccount = await db.collection("SSOAccounts").findOne({
      provider: "discord",
      providerAccountId: discordUserId,
    });

    if (!ssoAccount || !ssoAccount.userId) {
      // No Discord SSO account found for this user
      return null;
    }

    // Now get the user from AuthenticatedUsers using the linked userId
    const user = await db.collection("AuthenticatedUsers").findOne({
      _id: ssoAccount.userId,
    });

    if (!user) {
      // User not found (shouldn't happen but handle gracefully)
      return null;
    }

    // Check if user is an admin
    if (!user.admin) {
      // User exists but is not an admin
      return null;
    }

    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      image: user.image,
      admin: user.admin,
      approved: user.approved || false,
      limitedAccess: user.limitedAccess || false,
    };
  } catch (error) {
    logger.error("Error getting admin by Discord ID:" + error);
    return null;
  }
}
