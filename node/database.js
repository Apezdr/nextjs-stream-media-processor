const { MongoClient } = require('mongodb');
const uri = "mongodb://your_username:your_password@mongodb:14902/?authMechanism=DEFAULT";
const client = new MongoClient(uri);

async function checkAutoSync() {
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
            console.log("true");
        } else {
            console.log("false");
        }
    } catch (error) {
        console.error("An error occurred:", error);
        process.exit(1); // Exit with error
    } finally {
        await client.close();
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
    checkAutoSync,
    updateLastSyncTime
};

