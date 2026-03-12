import { betterAuth } from 'better-auth'
import { mongodbAdapter } from 'better-auth/adapters/mongodb'
import { admin } from 'better-auth/plugins'
import { bearer } from 'better-auth/plugins'
import { mongoClient } from './mongo.mjs'

const authDb = mongoClient.db(process.env.MONGODB_AUTH_DB || 'Users')

export const auth = betterAuth({
  database: mongodbAdapter(authDb, {
    client: mongoClient,
    transaction: process.env.MONGODB_TRANSACTIONS === 'true',
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  advanced: {
    database: { generateId: false },
  },
  session: {
    deferSessionRefresh: true,
  },
  user: {
    additionalFields: {
      approved:      { type: 'boolean', defaultValue: false, input: true },
      limitedAccess: { type: 'boolean', defaultValue: false, input: true },
    },
  },
  plugins: [
    admin({ defaultRole: 'user', adminRole: 'admin' }),
    bearer(),
  ],
})
