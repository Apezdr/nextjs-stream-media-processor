const { MongoClient } = require('mongodb');
const uri = "mongodb+srv://dbUser:Obbd7ETBlK611ax5@movies.vf3yl0z.mongodb.net/?retryWrites=true&w=majority";
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

checkAutoSync();
