const { MongoClient } = require('mongodb');
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

async function ensureIndex(collection, indexSpec, indexOptions) {
    const indexes = await collection.indexes();
    const indexExists = indexes.some(index => {
        return JSON.stringify(index.key) === JSON.stringify(indexSpec);
    });

    if (!indexExists) {
        await collection.createIndex(indexSpec, indexOptions);
    }
}

async function initializeMongoDatabase() {
    try {
        await client.connect();
        const mediaDb = client.db("Media");

        // Ensure collections in Media database
        const collections = await mediaDb.listCollections().toArray();
        const collectionNames = collections.map(col => col.name);

        if (!collectionNames.includes("Movies")) {
            await mediaDb.createCollection("Movies");
            console.log("Created collection: Movies");
        }

        if (!collectionNames.includes("TV")) {
            await mediaDb.createCollection("TV");
            console.log("Created collection: TV");
        }

        // Ensure collections in PlaybackStatus database
        const mediaCollection = await mediaDb.listCollections().toArray();
        const mediaCollectionNames = mediaCollection.map(col => col.name);

        if (!mediaCollectionNames.includes("PlaybackStatus")) {
            await mediaDb.createCollection("PlaybackStatus");
            console.log("Created collection: PlaybackStatus");
        }

        console.log("Database and collections have been initialized successfully.");
    } catch (error) {
        console.error("An error occurred while initializing the database and collections:", error);
        process.exit(1); // Exit with error
    }
}

async function initializeIndexes() {
    try {
        await client.connect();
        const mediaDb = client.db("Media");

        // Ensure index on Media.Movies collection
        const moviesCollection = mediaDb.collection("Movies");
        await ensureIndex(moviesCollection, { videoURL: -1 }, { name: "videoURL_index" });

        // Ensure indexes on Media.TV collection
        const tvCollection = mediaDb.collection("TV");
        await ensureIndex(tvCollection, { title: -1 }, { name: "title_index" });
        await ensureIndex(tvCollection, { "seasons.episodes.videoURL": -1 }, { name: "episodes_videoURL_index" });

        // Ensure index on PlaybackStatus collection
        const playbackStatusCollection = mediaDb.collection("PlaybackStatus");
        await ensureIndex(playbackStatusCollection, { userId: 1 }, { name: "userId_1" });

        console.log("Indexes have been initialized successfully.");
    } catch (error) {
        console.error("An error occurred while initializing indexes:", error);
        process.exit(1); // Exit with error
    } finally {
        await client.close();
    }
}

async function checkAutoSync() {
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
            console.log("Auto Sync setting initialized to true.");
        }

        // Check the value of autoSync
        if (autoSyncSetting && autoSyncSetting.value) {
            autoSyncResponse = true;
        } else {
            autoSyncResponse = false;
        }
    } catch (error) {
        console.error("An error occurred:", error);
        process.exit(1); // Exit with error
    } finally {
        await client.close();
        return autoSyncResponse;
    }
}

async function updateLastSyncTime() {
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

        console.log("Last sync time updated successfully.");
    } catch (error) {
        console.error("An error occurred while updating the last sync time:", error);
        process.exit(1); // Exit with error
    } finally {
        await client.close();
    }
}

// Export the functions
module.exports = {
    initializeMongoDatabase,
    initializeIndexes,
    checkAutoSync,
    updateLastSyncTime
};

