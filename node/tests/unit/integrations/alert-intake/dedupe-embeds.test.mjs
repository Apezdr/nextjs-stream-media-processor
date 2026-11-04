/**
 * The dedupe memory's bounds and token buckets (dedupe.mjs, rateLimit.mjs),
 * and the embeds (embeds.mjs): within every Discord limit whatever the
 * payload, since a refused message would be an endless 5xx retry.
 */

import { describe, it, expect } from '@jest/globals';
import { createDedupe } from '../../../../integrations/alert-intake/dedupe.mjs';
import { createBucket } from '../../../../integrations/alert-intake/rateLimit.mjs';
import { intakeEmbeds, heldSummaryEmbed, embedCharacters, EMBED_LIMITS } from '../../../../integrations/alert-intake/embeds.mjs';
import { intakeAlert, cleanUrl } from '../../../../integrations/alert-intake/alert.mjs';
import { COLORS } from '../../../../lib/alerts/embedStyle.mjs';

let clock = 0;
const now = () => clock;
const alertOf = (fields = {}) => ({
  ...intakeAlert({ format: 'alertmanager', kind: 'stateful', title: 'Disk almost full', fingerprint: 'fp', severity: 'warning', ...fields }, Date.parse('2026-11-04T09:00:00Z')),
  source: fields.source ?? 'signoz',
});

describe('dedupe bounds', () => {
  it('keeps at most maxEntriesPerSource entries, evicting the oldest settled one, never one in flight', () => {
    const dedupe = createDedupe({ now, maxEntriesPerSource: 3 });
    const inFlight = alertOf({ fingerprint: 'in-flight' });
    dedupe.begin(inFlight, Promise.resolve());
    for (const fingerprint of ['a', 'b', 'c', 'd']) {
      const alert = alertOf({ fingerprint });
      dedupe.begin(alert, Promise.resolve());
      dedupe.settle(alert, true);
    }
    expect(dedupe.size('signoz')).toBe(3);
    expect(dedupe.classify(inFlight).verdict).toBe('inflight');
    expect(dedupe.classify(alertOf({ fingerprint: 'a' })).verdict).toBe('new'); // evicted: a repeat DM at worst
    expect(dedupe.classify(alertOf({ fingerprint: 'd' })).verdict).toBe('duplicate');
    // Sources are kept apart.
    expect(dedupe.classify(alertOf({ fingerprint: 'd', source: 'grafana' })).verdict).toBe('new');
  });

  it('sweeps expired entries as new ones arrive', () => {
    const dedupe = createDedupe({ now, remindAfterMs: 1000, eventWindowMs: 500 });
    for (const fingerprint of ['a', 'b']) {
      const alert = alertOf({ fingerprint });
      dedupe.begin(alert, Promise.resolve());
      dedupe.settle(alert, true);
    }
    clock += 2000;
    const fresh = alertOf({ fingerprint: 'c' });
    dedupe.begin(fresh, Promise.resolve());
    expect(dedupe.size('signoz')).toBe(1);
  });

  it('forgets an alert whose only send failed', () => {
    const dedupe = createDedupe({ now });
    const alert = alertOf();
    dedupe.begin(alert, Promise.resolve());
    dedupe.settle(alert, false);
    expect(dedupe.size('signoz')).toBe(0);
  });
});

describe('token buckets', () => {
  it('give a burst, refill continuously, and take refunds up to the burst', () => {
    clock = 0;
    const bucket = createBucket({ capacity: 2, perHour: 60, now });
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
    expect(bucket.msUntilToken()).toBe(60_000);
    clock += 30_000;
    expect(bucket.take()).toBe(false);
    clock += 30_000;
    expect(bucket.take()).toBe(true);
    bucket.refund();
    bucket.refund();
    bucket.refund();
    expect(bucket.tokens).toBe(2);
  });
});

describe('intakeEmbeds', () => {
  const context = { source: 'signoz', format: 'alertmanager', processorLabel: 'tower' };

  it('builds the notifier-styled embed: label, colour, fields, links, footer', () => {
    const [embed] = intakeEmbeds(
      [
        alertOf({
          severity: 'critical',
          message: 'free space *dropped* below 4%',
          url: 'https://grafana.example.com/x',
          links: [{ label: 'Silence', url: 'https://grafana.example.com/s' }],
          labels: [['instance', 'nas_01']],
          subject: 'processor-intake',
          startsAt: '2026-11-04T08:55:10.000Z',
        }),
      ],
      context
    );
    expect(embed).toMatchObject({
      title: '🚨 Critical: Disk almost full',
      url: 'https://grafana.example.com/x',
      color: COLORS.critical,
      description: 'free space \\*dropped\\* below 4%',
      footer: { text: 'Alert intake · relayed by tower · alertmanager' },
      timestamp: '2026-11-04T08:55:10.000Z',
    });
    expect(embed.fields).toEqual([
      { name: 'Source', value: 'signoz · processor-intake', inline: true },
      { name: 'Since', value: '<t:1793782510:R>', inline: true },
      { name: 'Labels', value: 'instance: nas\\_01' },
      { name: 'Links', value: '[Silence](https://grafana.example.com/s)' },
    ]);
  });

  it('styles resolved, reminder and test sends', () => {
    const resolved = alertOf({ status: 'resolved', endsAt: '2026-11-04T09:41:00.000Z' });
    const reminder = alertOf();
    const test = alertOf({ severity: 'info', test: true, fingerprint: 't' });
    const embeds = intakeEmbeds([resolved, reminder, test], { ...context, reminders: new Set([reminder.id]) });
    expect(embeds.map((embed) => [embed.title, embed.color])).toEqual([
      ['✅ Resolved: Disk almost full', COLORS.resolved],
      ['⚠️ Still warning: Disk almost full', COLORS.warning],
      ['[test] ℹ️ Info: Disk almost full', COLORS.info],
    ]);
    expect(embeds[0].fields.find((field) => field.name === 'Resolved').value).toBe('<t:1793785260:R>');
  });

  it('stays inside every Discord limit for oversized alerts, folding what does not fit into an overflow embed', () => {
    const huge = (index) =>
      alertOf({
        fingerprint: `f${index}`,
        title: `T${index} ${'t'.repeat(400)}`,
        message: 'm'.repeat(4000),
        labels: Array.from({ length: 12 }, (_, i) => [`label${i}`, 'v'.repeat(200)]),
        links: Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, url: `https://example.com/${'p'.repeat(300)}${i}` })),
      });
    const alerts = Array.from({ length: 30 }, (_, index) => huge(index));
    const embeds = intakeEmbeds(alerts, { ...context, truncated: 4 });
    expect(embeds.length).toBeLessThanOrEqual(EMBED_LIMITS.embeds);
    expect(embeds.reduce((sum, embed) => sum + embedCharacters(embed), 0)).toBeLessThanOrEqual(EMBED_LIMITS.total);
    for (const embed of embeds) {
      expect(embed.title.length).toBeLessThanOrEqual(EMBED_LIMITS.title);
      expect((embed.description ?? '').length).toBeLessThanOrEqual(EMBED_LIMITS.description);
      for (const field of embed.fields ?? []) {
        expect(field.value.length).toBeGreaterThan(0);
        expect(field.value.length).toBeLessThanOrEqual(EMBED_LIMITS.fieldValue);
      }
    }
    const overflow = embeds.at(-1);
    expect(overflow.title).toMatch(/…and \d+ more from signoz/);
    expect(overflow.description).toContain('4 not sent by the sender');
  });

  it('holds exactly ten alerts without an overflow, and eleven as nine plus an overflow', () => {
    const many = (count) => Array.from({ length: count }, (_, index) => alertOf({ fingerprint: `f${index}` }));
    expect(intakeEmbeds(many(10), context)).toHaveLength(10);
    const eleven = intakeEmbeds(many(11), context);
    expect(eleven).toHaveLength(10);
    expect(eleven[9].title).toBe('⚠️ …and 2 more from signoz');
  });

  it('only ever gets clean URLs: javascript:, data: and garbage are dropped before embedding', () => {
    expect(cleanUrl('javascript:alert(1)')).toBeNull();
    expect(cleanUrl('data:text/html,x')).toBeNull();
    expect(cleanUrl('not a url')).toBeNull();
    expect(cleanUrl(`https://example.com/${'x'.repeat(2100)}`)).toBeNull();
    expect(cleanUrl('https://user:pw@example.com/x?token=abc&q=1')).toBe('https://REDACTED@example.com/x?token=REDACTED&q=1');
  });

  it('reports held alerts in a summary embed', () => {
    const embed = heldSummaryEmbed(
      { count: 3, bySeverity: { warning: 2, info: 1 }, firstAt: Date.parse('2026-11-04T10:02:00Z'), lastAt: Date.parse('2026-11-04T10:15:00Z'), samples: [{ severity: 'warning', title: 'jellyfin Down' }] },
      { source: 'uptime-kuma', perHour: 20, processorLabel: 'tower' }
    );
    expect(embed.title).toBe('⚠️ Rate cap: 3 alerts from uptime-kuma held back');
    expect(embed.description).toContain('warning 2, info 1');
    expect(embed.description).toContain('jellyfin Down');
    expect(embed.color).toBe(COLORS.warning);
  });
});
