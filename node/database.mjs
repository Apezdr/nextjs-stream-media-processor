import { MongoClient } from 'mongodb';
import { createCategoryLogger } from './lib/logger.mjs';
const logger = createCategoryLogger('mongoDB');
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

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
    const indexExists = indexes.some(index => {
        // Compare index keys
        return JSON.stringify(index.key) === JSON.stringify(indexSpec);
    });

    if (!indexExists) {
        await collection.createIndex(indexSpec, indexOptions);
        logger.info(`Created index: ${indexOptions.name} on collection: ${collection.collectionName}`);
    } else {
        logger.info(`Index: ${indexOptions.name} already exists on collection: ${collection.collectionName}`);
    }
}

export async function initializeMongoDatabase() {
    try {
        await client.connect();
        const mediaDb = client.db("Media");
        const cacheDB = client.db("Cache");

        // Ensure collections in Media database
        const collections = await mediaDb.listCollections().toArray();
        const collectionNames = collections.map(col => col.name);

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
        const mediaCollectionNames = mediaCollection.map(col => col.name);

        if (!mediaCollectionNames.includes("PlaybackStatus")) {
            await mediaDb.createCollection("PlaybackStatus");
            logger.info("Created collection: PlaybackStatus");
        }

        // Ensure collections in Cache database
        const cacheCollections = await cacheDB.listCollections().toArray();
        const cacheCollectionNames = cacheCollections.map(col => col.name);
        if (!cacheCollectionNames.includes("cacheEntries")) {
            await cacheDB.createCollection("cacheEntries");
            logger.info("Created collection: cacheEntries");
        }

        logger.info("Database and collections have been initialized successfully.");
    } catch (error) {
        logger.error("An error occurred while initializing the database and collections:", error);
        process.exit(1); // Exit with error
    }
}

/**
 * Initializes the indexes for all relevant collections.
 * Ensures that each index exists, creating it if necessary.
 */
export async function initializeIndexes() {
    try {
        await client.connect();
        const mediaDb = client.db("Media");
        const cacheDB = client.db("Cache");

        // Ensure indexes on Media.Movies collection
        const moviesCollection = mediaDb.collection("Movies");
        await ensureIndex(moviesCollection, 
            { videoURL: 1 }, 
            { name: "video_lookup" }
        );

        // Ensure indexes on Media.TV collection
        const tvCollection = mediaDb.collection("TV");
        await ensureIndex(tvCollection, 
            { "seasons.episodes.videoURL": 1 }, 
            { name: "episode_lookup" }
        );
        // Keep the title index as it might be useful for other queries
        await ensureIndex(tvCollection, 
            { title: -1 }, 
            { name: "title_index" }
        );

        // Ensure indexes on PlaybackStatus collection
        const playbackStatusCollection = mediaDb.collection("PlaybackStatus");
        // Compound index for user watch history
        await ensureIndex(playbackStatusCollection, 
            { 
                userId: 1,
                "videosWatched.lastUpdated": -1 
            }, 
            { name: "user_watchHistory" }
        );
        
        // Single field index on userId
        await ensureIndex(playbackStatusCollection, 
            { 
                userId: 1,
            }, 
            { name: "userId_1" }
        );

        // Ensure indexes on Cache collection
        const cacheCollection = cacheDB.collection("cacheEntries");

        // 1. Create a text index on the 'url' field
        await ensureIndex(cacheCollection,
            { url: "text" },
            { name: "url_text_index" , background: true}
        );

        // 2. Create a TTL index on the 'timestamp' field
        await ensureIndex(cacheCollection,
            { timestamp: 1 },
            { 
                name: "cache_ttl_index",
                expireAfterSeconds: 7 * 24 * 60 * 60  // Example: 7 days
            }
        );

        logger.info("Indexes have been initialized successfully.");
    } catch (error) {
        logger.error("An error occurred while initializing indexes:", error);
        process.exit(1); // Exit with error
    } finally {
        await client.close();
    }
}

export async function checkAutoSync() {
    let autoSyncResponse = false
    try {
        await client.connect();
        const database = client.db("app_config");
        const settings = database.collection("settings");
        
        // Try to find the autoSync setting
        let autoSyncSetting = await settings.findOne({ name: "autoSync" });

        // If it doesn't exist, initialize it to true
        if (!autoSyncSetting) {
            await settings.insertOne({ name: "autoSync", value: true });
            autoSyncSetting = { value: true };
            logger.info("Auto Sync setting initialized to true.");
        }

        // Check the value of autoSync
        if (autoSyncSetting && autoSyncSetting.value) {
            autoSyncResponse = true;
        } else {
            autoSyncResponse = false;
        }
    } catch (error) {
        logger.error("An error occurred:", error);
        //process.exit(1); // Exit with error
    } finally {
        await client.close();
        return autoSyncResponse;
    }
}

export async function updateLastSyncTime() {
    try {
        await client.connect();
        const database = client.db("app_config");
        const syncInfo = database.collection("syncInfo");

        // Update the last sync time
        await syncInfo.updateOne(
            { _id: "lastSyncTime" },
            { $set: { timestamp: new Date() } },
            { upsert: true }
        );

        logger.info("Last sync time updated successfully.");
    } catch (error) {
        logger.error("An error occurred while updating the last sync time:" + error.message);
        process.exit(1); // Exit with error
    } finally {
        await client.close();
    }
}
