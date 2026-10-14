import { MongoClient } from 'mongodb'

const uri = process.env.MONGODB_URI

export const mongoClient = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 2,
  maxIdleTimeMS: 60000,
})

// Connect at boot and keep retrying until one attempt succeeds. After a failed
// connect() the driver (7.x) keeps the closed topology on the client, and its
// auto-connect only runs when there is no topology at all — so a boot that
// races mongod's startup would leave every later operation throwing "Topology
// is closed" until the process restarts. better-auth (lib/auth.mjs) holds this
// client directly, so it has to heal here, not only in database.mjs getClient().
// Docker's depends_on doesn't cover this: the daemon ignores it on a host
// reboot or a restart-policy restart.
const BOOT_CONNECT_RETRY_MS = 5_000
function connectUntilUp(client) {
  client.connect().catch(() => {
    setTimeout(() => connectUntilUp(client), BOOT_CONNECT_RETRY_MS).unref()
  })
}
connectUntilUp(mongoClient)
