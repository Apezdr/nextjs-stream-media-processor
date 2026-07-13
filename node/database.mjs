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
  // Must resolve the same database the Better Auth instance uses
  // (lib/auth.mjs), or admin lookups query a DB auth never writes to.
  return client.db(process.env.MONGODB_AUTH_DB || "Users");
}

export async function getAppConfigDb() {
  const client = await getClient();
  return client.db("app_config");
}

/**
 * Closes the shared MongoClient's connection pool. app.mjs's graceful
 * shutdown resolves this export by name behind a `typeof` guard, so renaming
 * it silently turns the close into a no-op.
 */
export async function closeMongoConnection() {
  await mongoClient.close();
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

/**
 * Initializes the indexes for the Mongo state this repo actually owns.
 * Only `app_config` is provisioned here — the legacy Media/Cache collections
 * (Movies, TV, PlaybackStatus, cacheEntries) had no consumers in either repo
 * and their startup provisioning was removed (M-3); the live frontend data
 * lives in the Flat* collections managed by the frontend's own sync.
 */
export async function initializeIndexes() {
  const client = await getClient();
  try {
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

    // If it doesn't exist, initialize it to true.
    // M-4 revert-detection audit line: app_config.settings self-heals to
    // defaults when a document is missing, so on an ESTABLISHED deployment
    // this warn firing means the operator's stored setting was lost (wipe /
    // stale-backup restore) and silently reverted — exactly the signature the
    // audit trail exists to catch. On a genuinely fresh install it is normal
    // first-boot seeding. Grep marker: "app_config.settings audit".
    if (!autoSyncSetting) {
      await settings.insertOne({ name: "autoSync", value: true });
      autoSyncSetting = { value: true };
      logger.warn(
        'app_config.settings audit: seeded default document (name="autoSync", value=true) — expected on first boot only; on an established deployment this indicates a settings loss/revert'
      );
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
