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
  baseURL: process.env.BETTER_AUTH_URL,
  advanced: {
    database: { generateId: false },
    // Must match the Next.js app's cookiePrefix so the same cookie is recognised
    cookiePrefix: 'nextjs-stream',
    crossSubDomainCookies: {
      enabled: !!process.env.AUTH_COOKIE_DOMAIN,
      domain: process.env.AUTH_COOKIE_DOMAIN?.replace(/^\./, ''),
    },
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
