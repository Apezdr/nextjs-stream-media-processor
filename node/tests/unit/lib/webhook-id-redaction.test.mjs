/**
 * Webhook IDs never reach the logs (lib/webhookIdRedaction.mjs, wired into
 * lib/logger.mjs) unless LOG_UNREDACTED_WEBHOOK_IDS=true. autoSync used to log
 * its headers, ID included, on every sync under DEBUG, and the webhook auth
 * logged the first 8 characters of IDs it saw. Runs the real logger with a
 * transport that keeps what would have been written.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { createHash } from 'crypto';
import { Writable } from 'stream';
import { transports } from 'winston';

const FIRST = 'whk-0123456789-first';
const SECOND = 'whk-abcdef-second';
const SERVER_KEY = 'srv-key-9876543210';
process.env.WEBHOOK_ID_1 = `${FIRST}, ${SECOND}`;
process.env.SERVER_API_KEY = SERVER_KEY;
delete process.env.LOG_UNREDACTED_WEBHOOK_IDS;

const { default: baseLogger, createCategoryLogger } = await import('../../../lib/logger.mjs');
const { describeWebhookId } = await import('../../../lib/webhookIdRedaction.mjs');

const written = [];
const sink = new transports.Stream({
  stream: new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
  }),
});

beforeAll(() => baseLogger.add(sink));
afterAll(() => baseLogger.remove(sink));
afterEach(() => {
  written.length = 0;
  delete process.env.LOG_UNREDACTED_WEBHOOK_IDS;
});

const logger = createCategoryLogger('redaction-test');
const fingerprint = (id) => `[webhook-id sha256:${createHash('sha256').update(id).digest('hex').slice(0, 8)}]`;
const flushed = () => new Promise((resolve) => setImmediate(resolve));

describe('webhook IDs in log records', () => {
  it('replaces an ID in the fields with its fingerprint, without touching the caller\'s object', async () => {
    const headers = { 'X-Webhook-ID': FIRST, 'Content-Type': 'application/json' };
    logger.info('Sending headers', { headers });
    await flushed();

    const line = written.join('');
    expect(line).not.toContain(FIRST);
    expect(line).toContain(fingerprint(FIRST));
    expect(headers['X-Webhook-ID']).toBe(FIRST);
  });

  it('catches every configured ID anywhere in the record: message, nested fields, arrays', async () => {
    logger.warn(`retrying with ${SECOND}`, { attempts: [{ key: SERVER_KEY }], note: `a ${FIRST} b ${FIRST}` });
    await flushed();

    const line = written.join('');
    for (const id of [FIRST, SECOND, SERVER_KEY]) {
      expect(line).not.toContain(id);
      expect(line).toContain(fingerprint(id));
    }
  });

  it('writes IDs in full only when LOG_UNREDACTED_WEBHOOK_IDS=true', async () => {
    process.env.LOG_UNREDACTED_WEBHOOK_IDS = 'true';
    logger.info('Sending headers', { 'X-Webhook-ID': FIRST });
    await flushed();

    expect(written.join('')).toContain(FIRST);
    expect(describeWebhookId(FIRST)).toBe(FIRST);
  });

  it('treats anything but exactly "true" as off', () => {
    for (const value of ['1', 'TRUE', 'yes', '']) {
      process.env.LOG_UNREDACTED_WEBHOOK_IDS = value;
      expect(describeWebhookId(FIRST)).toBe(fingerprint(FIRST));
    }
  });
});
