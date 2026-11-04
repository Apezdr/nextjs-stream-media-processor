/**
 * The Discord side of the relay: NotificationManager.deliverDiscordEmbeds
 * (one message, every target, logs nothing, never rejects), the bot
 * readiness wait (whenDiscordReady), sendDiscordEmbed unchanged for the log
 * alerts, and the intake's Discord sink (discordSink.mjs).
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Writable } from 'stream';
import { transports } from 'winston';

process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017';
for (const name of ['NOTIFICATION_1_TYPE', 'NOTIFICATION_1_URL', 'NOTIFICATION_2_TYPE', 'DISCORD_NOTIFY_USERS', 'FRONT_END_1']) delete process.env[name];

const { default: baseLogger } = await import('../../../../lib/logger.mjs');
const { NotificationManager, discordTargets } = await import('../../../../integrations/index.mjs');
const { DiscordBotAdapter } = await import('../../../../integrations/discord/bot.mjs');
const { createDiscordSink } = await import('../../../../integrations/alert-intake/discordSink.mjs');
// The Discord bot's imports start the blurhash worker pool; its thread would outlive the test.
const { destroyPool } = await import('../../../../lib/blurhash-pool.mjs');

const written = [];
const sink = new transports.Stream({
  stream: new Writable({
    write(chunk, _encoding, callback) {
      written.push(JSON.parse(chunk.toString()));
      callback();
    },
  }),
});
beforeAll(() => baseLogger.add(sink));
afterAll(() => baseLogger.remove(sink));
const flushed = () => new Promise((resolve) => setImmediate(resolve));
const managerLines = () => written.filter((record) => record.category === 'notificationManager');

const ENV = {
  NOTIFICATION_1_TYPE: 'discord',
  NOTIFICATION_1_URL: 'https://discord.example.com/api/webhooks/1/token',
  NOTIFICATION_2_TYPE: 'discord_bot',
  DISCORD_NOTIFY_USERS: 'u1, u2',
};

let manager;
beforeAll(async () => {
  manager = new NotificationManager(); // no bot configured yet: nothing starts
  await manager.botInitPromise;
  Object.assign(process.env, ENV);
});
afterAll(async () => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  await destroyPool();
});

beforeEach(async () => {
  await flushed();
  written.length = 0;
  manager.discordAdapter.sendEmbeds = jest.fn().mockResolvedValue({ success: true });
  manager.discordBot = { ready: true, sendEmbedsDM: jest.fn().mockResolvedValue({ success: true }) };
});

const embeds = [{ title: 'one' }, { title: 'two' }];

describe('deliverDiscordEmbeds', () => {
  it('sends one message with every embed to each webhook and each DM user, and logs nothing', async () => {
    const outcome = await manager.deliverDiscordEmbeds(embeds);
    expect(outcome).toEqual({ targets: 3, delivered: 3, failed: 0, botNotReady: 0, reasons: [] });
    expect(manager.discordAdapter.sendEmbeds).toHaveBeenCalledWith(ENV.NOTIFICATION_1_URL, embeds);
    expect(manager.discordBot.sendEmbedsDM.mock.calls).toEqual([['u1', embeds], ['u2', embeds]]);
    await flushed();
    expect(managerLines()).toEqual([]);
  });

  it('counts refusals and a bot that is not ready, without rejecting or logging', async () => {
    manager.discordAdapter.sendEmbeds.mockRejectedValue(new Error('Request failed with status code 400'));
    manager.discordBot.ready = false;
    const outcome = await manager.deliverDiscordEmbeds(embeds);
    expect(outcome).toEqual({ targets: 3, delivered: 0, failed: 3, botNotReady: 2, reasons: ['Discord bot not ready', 'Request failed with status code 400'] });
    await flushed();
    expect(managerLines()).toEqual([]);
  });

  it('leaves sendDiscordEmbed as the log alerts know it: one embed, a warn per failure, a boolean', async () => {
    manager.discordBot.sendEmbedsDM.mockRejectedValueOnce(new Error('Cannot send messages to this user'));
    expect(await manager.sendDiscordEmbed({ title: 'log alert' })).toBe(true);
    expect(manager.discordAdapter.sendEmbeds).toHaveBeenCalledWith(ENV.NOTIFICATION_1_URL, [{ title: 'log alert' }]);
    await flushed();
    expect(managerLines().map((record) => [record.level, record.message])).toEqual([['warn', 'Discord alert delivery failed: Cannot send messages to this user']]);
  });

  it('reads the targets from the environment', () => {
    expect(discordTargets(process.env)).toEqual({ webhookUrls: [ENV.NOTIFICATION_1_URL], userIds: ['u1', 'u2'], botConfigured: true });
  });
});

describe('whenDiscordReady', () => {
  it('is false without a bot, true when ready, true when it becomes ready, false at the timeout', async () => {
    manager.discordBot = null;
    expect(await manager.whenDiscordReady(50)).toBe(false);
    manager.discordBot = { ready: true };
    expect(await manager.whenDiscordReady(50)).toBe(true);

    const bot = Object.create(DiscordBotAdapter.prototype);
    bot.ready = false;
    manager.discordBot = bot;
    const waiting = manager.whenDiscordReady(5000);
    setTimeout(() => bot.markReady(), 20);
    expect(await waiting).toBe(true);
    expect(bot.ready).toBe(true);

    const slow = Object.create(DiscordBotAdapter.prototype);
    slow.ready = false;
    manager.discordBot = slow;
    expect(await manager.whenDiscordReady(30)).toBe(false);
  });
});

describe('the intake\'s Discord sink', () => {
  const fakeManager = (outcome, ready = true) => ({
    whenDiscordReady: jest.fn().mockResolvedValue(ready),
    deliverDiscordEmbeds: jest.fn().mockResolvedValue(outcome),
  });

  it('answers no-target without touching the manager when there is nowhere to send', async () => {
    const getManager = jest.fn();
    const discord = createDiscordSink({ getManager, env: {} });
    expect(discord.hasTargets()).toBe(false);
    expect(await discord.deliver(embeds)).toEqual({ ok: false, reason: 'no-target' });
    expect(getManager).not.toHaveBeenCalled();
    // A bot channel with no one to DM is nowhere too.
    expect(createDiscordSink({ getManager, env: { NOTIFICATION_1_TYPE: 'discord_bot' } }).hasTargets()).toBe(false);
  });

  it('waits for the bot when it DMs, then reports delivered, not ready, or refused', async () => {
    const ok = fakeManager({ targets: 2, delivered: 2, failed: 0, botNotReady: 0, reasons: [] });
    const discord = createDiscordSink({ getManager: async () => ok, env: ENV, readyWaitMs: 1234 });
    expect(await discord.deliver(embeds)).toEqual({ ok: true, delivered: 2, failed: 0 });
    expect(ok.whenDiscordReady).toHaveBeenCalledWith(1234);

    const notReady = fakeManager({ targets: 2, delivered: 0, failed: 2, botNotReady: 2, reasons: ['Discord bot not ready'] }, false);
    expect(await createDiscordSink({ getManager: () => notReady, env: { NOTIFICATION_1_TYPE: 'discord_bot', DISCORD_NOTIFY_USERS: 'u1,u2' } }).deliver(embeds)).toEqual({
      ok: false,
      reason: 'not-ready',
    });

    const refused = fakeManager({ targets: 3, delivered: 0, failed: 3, botNotReady: 0, reasons: ['Cannot send messages to this user'] });
    expect(await createDiscordSink({ getManager: () => refused, env: ENV }).deliver(embeds)).toEqual({ ok: false, reason: 'rejected', detail: 'Cannot send messages to this user' });

    // Webhooks only: no readiness wait.
    const hooks = fakeManager({ targets: 1, delivered: 1, failed: 0, botNotReady: 0, reasons: [] });
    await createDiscordSink({ getManager: () => hooks, env: { NOTIFICATION_1_TYPE: 'discord', NOTIFICATION_1_URL: 'https://x.example.com/h' } }).deliver(embeds);
    expect(hooks.whenDiscordReady).not.toHaveBeenCalled();
  });
});
