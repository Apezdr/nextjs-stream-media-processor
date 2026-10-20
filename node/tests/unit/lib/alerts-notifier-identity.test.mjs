/**
 * The log alert notifier (lib/alerts/notifier.mjs): Discord and the home
 * frontend (FRONT_END_1, the architecture's current assumption) are
 * independent, failed frontend deliveries are retried and timed for the
 * home-frontend rule. And the processor's own ID (lib/processorIdentity.mjs).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { alertEmbed, createAlertNotifier } from '../../../lib/alerts/notifier.mjs';
import { getProcessorId } from '../../../lib/processorIdentity.mjs';

const alert = {
  key: 'recurring:abc',
  rule: 'recurring',
  severity: 'warning',
  title: 'session-cache: "Memory pressure detected: #MB used" 20 times in the last 60 minutes',
  category: 'session-cache',
  fp: 'abcdefabcdef',
  count: 20,
  windowMinutes: 60,
  firedAt: '2026-10-19T12:00:00.000Z',
};

describe('alert notifier', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.FRONT_END_1 = 'https://home.example/';
    process.env.WEBHOOK_ID_1 = 'home-key-123456, other';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('posts to the home frontend with its webhook ID, and sends Discord an embed, independently', async () => {
    const http = { post: jest.fn().mockResolvedValue({ status: 200 }) };
    const notificationManager = { sendDiscordEmbed: jest.fn().mockRejectedValue(new Error('bot down')) };
    const notifier = createAlertNotifier({ notificationManager, processor: { id: 'proc-1', label: 'tower' }, http });

    const result = await notifier.send(alert, 'fired', ['discord', 'frontend']);

    expect(result).toEqual({ discord: false, frontend: true });
    const [url, body, options] = http.post.mock.calls[0];
    expect(url).toBe('https://home.example/api/authenticated/admin/log-alert');
    expect(body).toEqual({ alert, transition: 'fired', processor: { id: 'proc-1', label: 'tower' } });
    expect(options.headers['X-Webhook-ID']).toBe('home-key-123456');
  });

  it('keeps failed frontend deliveries, times the outage, and delivers them once the frontend is back', async () => {
    let now = 1_000_000;
    const http = { post: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const notifier = createAlertNotifier({
      notificationManager: { sendDiscordEmbed: jest.fn() },
      processor: { id: 'proc-1', label: 'tower' },
      http,
      now: () => now,
    });

    expect(await notifier.send(alert, 'fired', ['frontend'])).toEqual({ discord: false, frontend: false });
    expect(notifier.homeStatus()).toEqual({ failingSince: 1_000_000, url: 'https://home.example' });

    now += 60_000;
    http.post.mockResolvedValue({ status: 200 });
    await notifier.flush();
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(notifier.homeStatus().failingSince).toBeNull();
  });

  it('has no frontend to send to, or to retry, without FRONT_END_1 and WEBHOOK_ID_1', async () => {
    delete process.env.FRONT_END_1;
    const http = { post: jest.fn() };
    const notifier = createAlertNotifier({ notificationManager: { sendDiscordEmbed: jest.fn() }, processor: { id: 'p', label: 'l' }, http });
    expect(await notifier.send(alert, 'fired', ['frontend'])).toEqual({ discord: false, frontend: false });
    await notifier.flush();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('builds a Discord embed that names the server and points at the fingerprint', () => {
    const embed = alertEmbed(alert, 'fired', 'tower');
    expect(embed.title.startsWith('⚠️ Warning: session-cache')).toBe(true);
    expect(embed.description).toContain('`abcdefabcdef`');
    expect(embed.fields).toEqual(
      expect.arrayContaining([{ name: 'Server', value: 'tower', inline: true }, { name: 'Count', value: '20 in 60 min', inline: true }])
    );
    expect(alertEmbed(alert, 'resolved', 'tower').title.startsWith('✅ Resolved:')).toBe(true);
  });
});

describe('processor identity', () => {
  let directory;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-id-'));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('makes an ID on first start, keeps it in the db directory, and reads it back after that', async () => {
    const id = await getProcessorId({ directory });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(await fs.readFile(path.join(directory, 'processor-identity.json'), 'utf8')).id).toBe(id);
    expect(await getProcessorId({ directory })).toBe(id);
  });
});
