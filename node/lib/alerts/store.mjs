/**
 * Where log alerts live between restarts: this processor's own Mongo,
 * app_config.log_fingerprints and app_config.log_alerts, every document keyed
 * by processor ID (lib/processorIdentity.mjs) since several processors can
 * share one Mongo.
 *
 * Kept small on purpose: one document per fingerprint (never per line) with
 * a TTL on lastSeen, and one per alert, removed 30 days after it resolves.
 */

import { ensureIndex, getAppConfigDb } from '../../database.mjs';

const DAY_SECONDS = 86_400;
const FINGERPRINT_TTL_SECONDS = 90 * DAY_SECONDS;
const RESOLVED_ALERT_KEEP_MS = 30 * DAY_SECONDS * 1000;

export function createAlertStore({ getDb = getAppConfigDb } = {}) {
  const fingerprints = async () => (await getDb()).collection('log_fingerprints');
  const alerts = async () => (await getDb()).collection('log_alerts');

  return {
    async ensureIndexes() {
      const fingerprintCollection = await fingerprints();
      const alertCollection = await alerts();
      await ensureIndex(fingerprintCollection, { lastSeen: 1 }, { name: 'log_fingerprints_ttl', expireAfterSeconds: FINGERPRINT_TTL_SECONDS });
      await ensureIndex(fingerprintCollection, { processorId: 1, fp: 1 }, { name: 'log_fingerprints_by_processor' });
      await ensureIndex(alertCollection, { expiresAt: 1 }, { name: 'log_alerts_ttl', expireAfterSeconds: 0 });
      await ensureIndex(alertCollection, { processorId: 1, state: 1, updatedAt: -1 }, { name: 'log_alerts_by_state' });
    },

    async knownFingerprints(processorId) {
      const docs = await (await fingerprints()).find({ processorId }, { projection: { fp: 1 } }).toArray();
      return new Set(docs.map((doc) => doc.fp));
    },

    /** Upserts the sightings: first seen, template and sample on insert; last seen and count always. */
    async saveFingerprints(processorId, sightings) {
      if (sightings.length === 0) return;
      await (await fingerprints()).bulkWrite(
        sightings.map((sighting) => ({
          updateOne: {
            filter: { _id: `${processorId}:${sighting.fp}` },
            update: {
              $setOnInsert: {
                processorId,
                fp: sighting.fp,
                category: sighting.category,
                level: sighting.level,
                template: sighting.template,
                sample: sighting.sample,
                firstSeen: new Date(sighting.firstSeen),
              },
              $max: { lastSeen: new Date(sighting.lastSeen) },
              $inc: { count: sighting.count },
            },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    },

    async firingAlerts(processorId) {
      return (await alerts()).find({ processorId, state: 'firing' }).toArray();
    },

    /** Saves an alert; a resolved one is set to expire 30 days on. */
    async saveAlert(alert) {
      const expiresAt = alert.state === 'resolved' ? new Date(Date.parse(alert.resolvedAt) + RESOLVED_ALERT_KEEP_MS) : null;
      await (await alerts()).replaceOne({ _id: alert._id }, { ...alert, expiresAt }, { upsert: true });
    },

    /** Firing alerts, and those resolved since `resolvedSince`, newest first. */
    async listAlerts(processorId, { resolvedSince, limit = 100 }) {
      return (await alerts())
        .find({
          processorId,
          $or: [{ state: 'firing' }, { state: 'resolved', resolvedAt: { $gte: resolvedSince.toISOString() } }],
        })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .toArray();
    },
  };
}
