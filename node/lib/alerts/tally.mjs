/**
 * The alert rules' view of the log: what this process has logged, minute by
 * minute, kept in memory for the last two hours.
 *
 * A winston transport (LogTallyTransport, added in lib/logger.mjs) feeds
 * every record in, so nothing reads the log files back. Per minute it counts
 * lines in total and per category, warn and error lines per fingerprint, and
 * secrets the logger masked; heartbeats (a library scan finishing) are
 * timestamps. Unflushed fingerprint sightings are kept apart for the alert
 * manager to write to Mongo (drainFingerprints).
 */

import { Transport } from 'winston';
import { SECRETS_MASKED } from '../logSecrets.mjs';
import { templateOf, fingerprintOf } from '../logFingerprint.mjs';

const MINUTE = 60_000;
const MINUTES_KEPT = 120;
// A runaway log call can't grow the tally without bound; past this many
// fingerprints in one minute the rest count only toward the totals.
const MAX_FINGERPRINTS_PER_MINUTE = 500;
const MAX_SAMPLE_LENGTH = 300;

export class LogTally {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.startedAt = now();
    this.minutes = new Map(); // minute index → { total, categories: Map, fingerprints: Map, secrets: [] }
    this.heartbeats = new Map(); // name → epoch ms
    this.unflushed = new Map(); // fp → sighting since the last drain
  }

  #bucket(minute) {
    let bucket = this.minutes.get(minute);
    if (!bucket) {
      bucket = { total: 0, categories: new Map(), fingerprints: new Map(), secrets: [] };
      this.minutes.set(minute, bucket);
      for (const old of this.minutes.keys()) {
        if (old <= minute - MINUTES_KEPT) this.minutes.delete(old);
      }
    }
    return bucket;
  }

  record(info) {
    const at = this.now();
    const bucket = this.#bucket(Math.floor(at / MINUTE));
    const category = typeof info.category === 'string' ? info.category : null;
    bucket.total += 1;
    bucket.categories.set(category, (bucket.categories.get(category) ?? 0) + 1);

    if (info[SECRETS_MASKED]) bucket.secrets.push({ category, kinds: info[SECRETS_MASKED], at });

    if (info.level !== 'warn' && info.level !== 'error') return;
    const message = String(info.message ?? '');
    const fp = typeof info.fp === 'string' ? info.fp : fingerprintOf(category, message);

    const seen = bucket.fingerprints.get(fp);
    if (seen) seen.count += 1;
    else if (bucket.fingerprints.size < MAX_FINGERPRINTS_PER_MINUTE) {
      bucket.fingerprints.set(fp, { count: 1, level: info.level, category, template: templateOf(message) });
    }

    const pending = this.unflushed.get(fp);
    if (pending) {
      pending.count += 1;
      pending.lastSeen = at;
    } else if (this.unflushed.size < MAX_FINGERPRINTS_PER_MINUTE) {
      this.unflushed.set(fp, {
        fp,
        count: 1,
        level: info.level,
        category,
        template: templateOf(message),
        sample: message.slice(0, MAX_SAMPLE_LENGTH),
        firstSeen: at,
        lastSeen: at,
      });
    }
  }

  heartbeat(name) {
    this.heartbeats.set(name, this.now());
  }

  /** The fingerprint sightings since the last call, emptied. */
  drainFingerprints() {
    const sightings = [...this.unflushed.values()];
    this.unflushed.clear();
    return sightings;
  }

  /** What the rules read. `minutes` is ordered oldest first, with empty minutes filled in. */
  snapshot() {
    const now = this.now();
    const current = Math.floor(now / MINUTE);
    const first = Math.max(current - MINUTES_KEPT + 1, Math.floor(this.startedAt / MINUTE));
    const minutes = [];
    for (let minute = first; minute <= current; minute += 1) {
      minutes.push({ minute, ...(this.minutes.get(minute) ?? { total: 0, categories: new Map(), fingerprints: new Map(), secrets: [] }) });
    }
    return { now, startedAt: this.startedAt, minutes, heartbeats: new Map(this.heartbeats) };
  }
}

/** Feeds every record the logger writes into a LogTally. */
export class LogTallyTransport extends Transport {
  constructor(tally, options = {}) {
    super({ level: 'silly', ...options });
    this.tally = tally;
  }

  log(info, callback) {
    try {
      this.tally.record(info);
    } catch {
      // Counting must never break logging.
    }
    callback();
  }
}
