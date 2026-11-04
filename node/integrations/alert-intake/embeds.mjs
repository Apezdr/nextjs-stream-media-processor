/**
 * Relayed alerts as Discord embeds (PLAN.md §5): one embed per alert, all of
 * a request's alerts in one message, in the log alerts' colours and emoji
 * (lib/alerts/embedStyle.mjs). Pure.
 *
 * Everything here keeps Discord from refusing the message. A refusal would
 * be a 502 to the sender, and Alertmanager retries a 5xx forever, so a
 * payload must never be able to cause one: titles, descriptions and field
 * values stay inside Discord's limits, no field value is empty, URLs are
 * validated before they get here (alert.mjs cleanUrl), and the whole message
 * stays under 6000 characters, folding what doesn't fit into an overflow
 * embed.
 */

import { escapeMarkdown } from 'discord.js';
import { COLORS, EMOJI, truncate } from '../../lib/alerts/embedStyle.mjs';
import { SEVERITY_RANK } from './alert.mjs';

export const EMBED_LIMITS = Object.freeze({
  title: 256,
  description: 4096,
  fieldValue: 1024,
  footer: 2048,
  embeds: 10,
  total: 6000,
});

// Kept under Discord's 6000 so a rounding slip can't tip it over.
const TOTAL_BUDGET = 5800;
const MIN_DESCRIPTION = 120;
const OVERFLOW_TITLES = 12;

/** Plain text that Discord would otherwise read as markdown. */
function plain(text) {
  return escapeMarkdown(text, { heading: true, bulletedList: true, numberedList: true, maskedLink: true });
}

const shown = (alert, text) => (alert.markdown ? text : plain(text));
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
const capitalized = (word) => word[0].toUpperCase() + word.slice(1);

function labelOf(alert, reminder) {
  if (alert.status === 'resolved') return 'Resolved';
  return reminder ? `Still ${alert.severity}` : capitalized(alert.severity);
}

function colorOf(alert) {
  return COLORS[alert.status === 'resolved' ? 'resolved' : alert.severity] ?? COLORS.info;
}

function emojiOf(alert) {
  return EMOJI[alert.status === 'resolved' ? 'resolved' : alert.severity] ?? '';
}

/** Markdown links joined with a middle dot, as many as fit in one field value. */
function linksValue(links) {
  const parts = [];
  let length = 0;
  for (const { label, url } of links) {
    const part = `[${plain(label)}](${url})`;
    const added = (parts.length ? 3 : 0) + part.length;
    if (length + added > EMBED_LIMITS.fieldValue) break;
    parts.push(part);
    length += added;
  }
  return parts.join(' · ');
}

function alertEmbed(alert, { processorLabel, reminder }) {
  const fields = [
    { name: 'Source', value: plain(alert.subject ? `${alert.source} · ${alert.subject}` : alert.source), inline: true },
  ];
  if (alert.startsAt) fields.push({ name: 'Since', value: `<t:${unix(alert.startsAt)}:R>`, inline: true });
  if (alert.status === 'resolved' && alert.endsAt) fields.push({ name: 'Resolved', value: `<t:${unix(alert.endsAt)}:R>`, inline: true });
  if (alert.labels.length) {
    const value = truncate(alert.labels.map(([name, text]) => `${plain(name)}: ${plain(text)}`).join('\n'), EMBED_LIMITS.fieldValue);
    fields.push({ name: 'Labels', value });
  }
  const links = linksValue(alert.links);
  if (links) fields.push({ name: 'Links', value: links });

  const embed = {
    title: truncate(`${alert.test ? '[test] ' : ''}${emojiOf(alert)} ${labelOf(alert, reminder)}: ${shown(alert, alert.title)}`, EMBED_LIMITS.title),
    color: colorOf(alert),
    fields: fields.filter((field) => field.value),
    footer: { text: truncate(`Alert intake · relayed by ${processorLabel} · ${alert.format}`, EMBED_LIMITS.footer) },
    timestamp: (alert.status === 'resolved' && alert.endsAt) || alert.startsAt || alert.receivedAt,
  };
  if (alert.url) embed.url = alert.url;
  if (alert.message) embed.description = truncate(shown(alert, alert.message), EMBED_LIMITS.description);
  return embed;
}

function overflowEmbed(alerts, { source, extra, processorLabel, format }) {
  const count = alerts.length + extra;
  const resolved = alerts.filter((alert) => alert.status === 'resolved').length;
  const firing = alerts.filter((alert) => alert.status === 'firing');
  const worst = firing.reduce((top, alert) => (SEVERITY_RANK[alert.severity] > SEVERITY_RANK[top] ? alert.severity : top), 'info');
  const titles = alerts.slice(0, OVERFLOW_TITLES).map((alert) => plain(alert.title));
  const counts = [firing.length ? `firing ${firing.length}` : null, resolved ? `resolved ${resolved}` : null, extra ? `${extra} not sent by the sender` : null]
    .filter(Boolean)
    .join(', ');
  return {
    title: truncate(`${firing.length ? EMOJI[worst] : EMOJI.resolved} …and ${count} more from ${plain(source)}`, EMBED_LIMITS.title),
    description: truncate(`${counts}${titles.length ? `: ${titles.join(', ')}` : ''}${alerts.length > OVERFLOW_TITLES ? ', …' : ''}`, 1000),
    color: firing.length ? COLORS[worst] : COLORS.resolved,
    footer: { text: truncate(`Alert intake · relayed by ${processorLabel} · ${format}`, EMBED_LIMITS.footer) },
  };
}

/** The characters Discord counts toward a message's 6000. */
export function embedCharacters(embed) {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text?.length ?? 0) +
    (embed.author?.name?.length ?? 0) +
    (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

const totalOf = (embeds) => embeds.reduce((sum, embed) => sum + embedCharacters(embed), 0);

/** Trims descriptions evenly, then drops Labels then Links fields from the last embed back, until it fits. */
function fit(embeds, budget) {
  if (totalOf(embeds) <= budget) return true;
  const withDescription = embeds.filter((embed) => embed.description);
  if (withDescription.length) {
    const rest = totalOf(embeds) - withDescription.reduce((sum, embed) => sum + embed.description.length, 0);
    const each = Math.max(MIN_DESCRIPTION, Math.floor((budget - rest) / withDescription.length));
    for (const embed of withDescription) embed.description = truncate(embed.description, each);
  }
  for (const name of ['Labels', 'Links']) {
    for (let index = embeds.length - 1; index >= 0 && totalOf(embeds) > budget; index -= 1) {
      // The overflow embed has no fields.
      if (embeds[index].fields) embeds[index].fields = embeds[index].fields.filter((field) => field.name !== name);
    }
  }
  return totalOf(embeds) <= budget;
}

/**
 * The embeds of one Discord message for a request's alerts.
 * @param {import('./alert.mjs').IntakeAlert[]} alerts all of one source and format
 * @param {{ source: string, format: string, processorLabel: string, reminders?: Set<string>, truncated?: number }} context
 *   reminders: ids of alerts sent again as "still firing"; truncated: alerts the sender left out
 */
export function intakeEmbeds(alerts, { source, format, processorLabel, reminders = new Set(), truncated = 0 }) {
  const extra = Math.max(0, truncated);
  let shownCount = alerts.length + (extra ? 1 : 0) > EMBED_LIMITS.embeds ? EMBED_LIMITS.embeds - 1 : alerts.length;
  for (;;) {
    const embeds = alerts.slice(0, shownCount).map((alert) => alertEmbed(alert, { processorLabel, reminder: reminders.has(alert.id) }));
    const rest = alerts.slice(shownCount);
    if (rest.length || extra) embeds.push(overflowEmbed(rest, { source, extra, processorLabel, format }));
    if (fit(embeds, TOTAL_BUDGET) || shownCount <= 1) return embeds;
    shownCount -= 1;
  }
}

/**
 * The embed that reports alerts held back by the rate cap.
 * @param {{ count: number, bySeverity: Record<string, number>, firstAt: number, lastAt: number, samples: { severity: string, title: string }[] }} summary
 */
export function heldSummaryEmbed(summary, { source, perHour, processorLabel }) {
  const counts = ['critical', 'warning', 'info']
    .filter((severity) => summary.bySeverity[severity])
    .map((severity) => `${severity} ${summary.bySeverity[severity]}`)
    .join(', ');
  const lines = summary.samples.map((sample) => `${EMOJI[sample.severity] ?? ''} ${plain(sample.title)}`);
  return {
    title: truncate(`${EMOJI.warning} Rate cap: ${summary.count} alert${summary.count === 1 ? '' : 's'} from ${plain(source)} held back`, EMBED_LIMITS.title),
    description: truncate(
      `Between <t:${Math.floor(summary.firstAt / 1000)}:t> and <t:${Math.floor(summary.lastAt / 1000)}:t>, ${plain(source)} sent more than its cap of ${perHour} messages an hour, so these were not relayed (${counts}).${lines.length ? `\n\nMost severe:\n${lines.join('\n')}` : ''}`,
      EMBED_LIMITS.description
    ),
    color: COLORS.warning,
    footer: { text: truncate(`Alert intake · relayed by ${processorLabel}`, EMBED_LIMITS.footer) },
    timestamp: new Date(summary.lastAt).toISOString(),
  };
}
