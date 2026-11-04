# Alert intake

Other apps send their alerts to this processor, which relays them as Discord
DMs from its bot (and to its Discord webhook channels, as its own log alerts
go). The apps speak a format they already know, so most need no code:

| Format | Who sends it |
|---|---|
| `alertmanager` | Prometheus Alertmanager, SigNoz, Grafana |
| `gotify` | Sonarr, Radarr, Prowlarr, Lidarr, Uptime Kuma, Proxmox VE, Healthchecks, Diun, Jellyseerr, Watchtower and Beszel (through shoutrrr) |
| `ntfy` | the same *arr apps, Uptime Kuma, Healthchecks, Watchtower, curl from cron, systemd |
| `generic` | our own small JSON, for this project's services and scripts |

Forward only: nothing is stored. The key is the authentication, over any URL:
it works the same behind a proxy, on a LAN or on the internet. Keeping the
endpoint off the internet is optional hardening, not what makes it safe.

## Before you start

- The processor's Discord bot works ([../discord/README.md](../discord/README.md)):
  `NOTIFICATION_<n>_TYPE=discord_bot` with `DISCORD_NOTIFY_USERS`, or a
  `NOTIFICATION_<n>_TYPE=discord` webhook channel. Without one, every intake
  request answers 503 and the processor says so at startup.
- The URL the senders reach the processor at, here `https://processor.example.com`.
- HTTPS. Keys travel in headers and, for some senders, in the query string.

## Keys

One key per sender, so each is named in its alerts and can be revoked alone:

```
ALERT_INTAKE_KEYS=signoz:<key>,grafana:<key>,uptime-kuma:<key>,sonarr:<key>
```

- Entries are `source:key`, separated by commas or newlines.
- The source names the sender in the DM and the logs: 1 to 32 of `a-z 0-9 . _ -`.
- A key is 32 to 256 of `A-Z a-z 0-9 . _ -`. Generate one:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
  (43 characters). Gotify senders that check the token's shape (shoutrrr) take
  the Gotify 3 form: put `gtfya.` in front of it.
- A source may have several keys: to rotate, add the new one, switch the
  sender, remove the old one.
- Read at startup; restart the processor after a change.
- One bad entry leaves the whole intake misconfigured: every request answers
  503 until it is fixed, and the processor logs each problem at startup under
  `alert-intake-setup`. (With `ALERT_INTAKE_KEYS` unset the intake is off and
  answers 404.) A key may not be a `WEBHOOK_ID_<n>` or `SERVER_API_KEY` value.

Rate caps, per source and for all sources together, in Discord messages:

| Variable | Default | |
|---|---|---|
| `ALERT_INTAKE_BURST` | 10 | messages a source may send at once |
| `ALERT_INTAKE_SOURCE_PER_HOUR` | 20 | messages a source may send an hour after its burst |

All sources together: 30 at once, 60 an hour. Critical alerts skip the
per-source cap, never the global one.

## Endpoints

| Format | URL to give the sender | Methods | Key |
|---|---|---|---|
| alertmanager | `https://processor.example.com/api/alert-intake/alertmanager` | POST, PUT | `Authorization: Bearer <key>`, or Basic with the key as the password |
| gotify | base `https://processor.example.com/api/alert-intake/gotify` (the client adds `/message`) | POST | `?token=<key>`, else `X-Gotify-Key`, else `Authorization: Bearer` |
| ntfy | base `https://processor.example.com/api/alert-intake/ntfy`; topic `<base>/<topic>` | POST, PUT | `?auth=` (ntfy's form), else `Authorization: Bearer`, or Basic (an empty username's password is the key) |
| generic | `https://processor.example.com/api/alert-intake/generic` | POST | `Authorization: Bearer <key>`, or Basic |

## Per tool

**SigNoz** (0.145 and later). Settings → Account Settings → Notification
Channels → New Channel → Webhook. URL: the alertmanager URL. Authentication:
Bearer token = the key. Keep "Send resolved alerts" on. Press Test: a DM marked
`[test]` arrives. Then pick the channel on each rule. Before creating the
channel, check every rule's channels: a rule without any chosen may send to
all of them. In any SigNoz rule over this processor's own logs, exclude
`attribute.category = 'alert-intake'` (those lines are about relaying). Older
SigNoz: leave Username empty and put the key in Password.

**Grafana.** Alerting → Contact points → Add → Webhook. URL: the alertmanager
URL. Optional Webhook settings → Authorization Header: scheme `Bearer`,
credentials = the key (or basic auth with the key as the password). Leave the
custom payload empty: a template replaces the payload this reads, and it
answers 400. Test, then route a notification policy to it.

**Prometheus Alertmanager.**

```yaml
receivers:
  - name: processor
    webhook_configs:
      - url: https://processor.example.com/api/alert-intake/alertmanager
        send_resolved: true
        max_alerts: 50
        timeout: 15s
        http_config:
          authorization:
            credentials_file: /etc/alertmanager/processor-intake.key
```

vmalert and Prometheus without Alertmanager post Alertmanager's API
(`/api/v2/alerts`), not its webhook; route them through Alertmanager for now.

**Uptime Kuma.** Prefer ntfy, which tells Down from Up: Notification type
ntfy, Server URL the ntfy base, Topic `uptime`, Priority 4 (Down goes to 5),
Authentication method Access Token = the key. Gotify works too (Server URL the
gotify base, Application Token = the key), but Down and Up then look alike.

**Sonarr, Radarr, Prowlarr, Lidarr.** Settings → Connect → + → ntfy: Server
URL the ntfy base, Topics `sonarr` (any name), Access Token = the key,
Priority 4; triggers On Health Issue, On Health Restored, On Application
Update, On Manual Interaction Required. Or Gotify: Server the gotify base, App
Token = the key; it is sent as `?token=` (see Security).

**Proxmox VE** (8.1 and later). Datacenter → Notifications → Add → Gotify:
Server URL the gotify base, API Token = the key (sent in headers). Add a
matcher for the events you want (backup failures, replication, fencing).

**Watchtower** (the maintained `nicholas-fedor/watchtower`) **and Beszel**, through shoutrrr:
`ntfy://:<key>@processor.example.com/api/alert-intake/ntfy/watchtower` (Basic
with an empty user). Or Gotify with a `gtfya.` key:
`gotify://processor.example.com/api/alert-intake/gotify/<gtfya.key>?useheader=yes`.
The archived `containrrr/watchtower` accepts only 15-character Gotify tokens,
shorter than a key may be: use its ntfy form.

**Healthchecks.** Integrations → ntfy: Server URL the ntfy base, topic `cron`,
priorities for down and up, access token = the key. Gotify works too
(Healthchecks adds the trailing slash itself).

**Diun, Jellyseerr.** Gotify: endpoint the gotify base, token = the key (Diun
sends it in a header).

**curl from cron.** The ntfy text form needs no JSON escaping:

```sh
curl -fsS -u ":$ALERT_INTAKE_KEY" -H "Title: nightly backup failed" -H "Priority: high" \
  --data-binary @/var/log/backup.err https://processor.example.com/api/alert-intake/ntfy/backups
```

**systemd `OnFailure=`.** A template unit, `/etc/systemd/system/alert-intake@.service`:

```ini
[Unit]
Description=Relay the failure of %i to the media processor

[Service]
Type=oneshot
# ALERT_INTAKE_URL=https://processor.example.com and ALERT_INTAKE_KEY=..., mode 600
EnvironmentFile=/etc/alert-intake.env
ExecStart=/bin/sh -c 'journalctl -u %i -n 30 --no-pager | curl -fsS --max-time 15 -u ":$ALERT_INTAKE_KEY" -H "Title: %i failed on %H" -H "Priority: urgent" --data-binary @- "$ALERT_INTAKE_URL/api/alert-intake/ntfy/systemd"'
```

and in each unit to watch: `OnFailure=alert-intake@%n.service`.

## The generic format

`POST /api/alert-intake/generic`, `Content-Type: application/json`, one alert:

```json
{
  "title": "GPU encoder unavailable",
  "message": "VAAPI device failed to open; sessions fall back to software encode.",
  "severity": "critical",
  "status": "firing",
  "fingerprint": "gpu-encoder-unavailable",
  "service": "jit-transcoder",
  "url": "https://signoz.example.com/logs/...",
  "links": [{ "label": "Logs", "url": "https://..." }],
  "fields": { "host": "media-01" },
  "markdown": false,
  "startsAt": "2026-11-04T09:30:00Z",
  "test": false
}
```

Only `title` (1 to 256 characters) is required. `severity` is critical,
warning (the default) or info; `status` firing (the default) or resolved. With
a `fingerprint` the alert has state: a repeat isn't sent again until its
status changes; send `"status": "resolved"` with the same fingerprint when it
clears. Without one it is a one-off message. Up to 5 links and 10 fields. An
unknown field, or a known one of the wrong shape, is a 400 that names it.

## What arrives in Discord

One message per request, one embed per alert (up to 10; more are summed up in
a last embed), in the colours of the processor's own log alerts: red critical,
amber warning, blue info, green resolved. A stateful alert still firing after
4 hours is sent once more as "Still …". Test sends are marked `[test]`. Links
(rule, logs, traces, runbook, dashboard, silence) are shown with their real
URLs.

Severity by format:

| Format | critical | warning | info |
|---|---|---|---|
| alertmanager label `severity` (then `threshold.name`, `priority`, `level`) | critical, error, high, major, fatal, page, p1 … | warning, medium, minor, p2, p3 … | info, notice, low, none, p4, p5 … (anything else: warning) |
| gotify `priority` | 8 to 10 | 4 to 7 | 0 to 3, or none |
| ntfy priority | 5, max, urgent | 4, high | 1 to 3, min, low, default, or none |

Resolved: alertmanager and generic say so. ntfy messages tagged
`green_circle`, `white_check_mark`, `heavy_check_mark`,
`ballot_box_with_check` or `resolved` are shown as resolved (Uptime Kuma and
Healthchecks tag an Up that way). Gotify has no resolved.

## Limits and behaviour

- Bodies: 1 MiB for alertmanager, 64 KiB for the rest. At most 100 alerts of
  one payload are read.
- Duplicates are dropped: a stateful alert until its status changes (or the
  4-hour reminder); an identical one-off message for 10 minutes. So a second
  identical Gotify or ntfy test within 10 minutes sends no DM. Test sends from
  SigNoz and Grafana are never dropped.
- Over a rate cap, alerts are held: not sent, and reported in one "Rate cap"
  DM per source when the source may send again.
- The reply comes after Discord took the message (at most 10 seconds). 200
  means delivered, a duplicate, or held for the summary. 502 means Discord
  refused it; 503 means there is no Discord channel, the bot isn't ready, a
  send is still in progress, or relaying is paused for 30 seconds after a
  send Discord refused (`Retry-After` says how long). Alertmanager, SigNoz and Grafana
  retry a 5xx; Uptime Kuma and the *arr apps show it as an error.
- Nothing is kept across a restart: an alert still firing may DM once more at
  its sender's next repeat.

## Security

- Use HTTPS: Basic credentials and query keys are plain text on the wire.
- Gotify senders put the key in the query string (`?token=`), and ntfy's
  `?auth=` is one too, so they land in reverse-proxy access logs. Caddy logs
  the URI with its query; by default it redacts only the `Cookie`,
  `Set-Cookie`, `Authorization` and `Proxy-Authorization` headers. Filter the
  rest:

  ```caddy
  log {
  	format filter {
  		request>uri query {
  			replace token REDACTED
  			replace auth REDACTED
  			replace authorization REDACTED
  		}
  		request>headers>X-Gotify-Key delete
  	}
  }
  ```

  Prefer a header where the tool offers one (Proxmox, Diun, shoutrrr's
  `useheader=yes`, ntfy's access token).
- The processor never logs a key, a payload or a query: a key that reaches a
  log line by mistake is replaced by `[intake-key sha256:…]`. Refused requests
  are logged at most once a minute with the route and the socket address only.
  Spans carry the source and the key's fingerprint, never the key.
- A key lets its sender put any text and link in your DMs: give each sender
  its own and revoke it alone.

## Troubleshooting

| Status | Meaning |
|---|---|
| 401 | No key where this format looks, or not a configured one |
| 400 | The body isn't what the format sends (a custom template, a bad field) |
| 404 | `ALERT_INTAKE_KEYS` isn't set, or the URL is wrong (check the base for gotify and ntfy) |
| 413 / 415 | Too large / wrong content type (Gotify multipart: send JSON or `-d` fields) |
| 502 | Discord refused the message (a DM user who blocks the bot, a bad webhook) |
| 503 | Misconfigured keys, no Discord channel, the bot logging in, or paused after a failure |

The processor's log has it: `category = alert-intake` while running,
`alert-intake-setup` at startup.

Nothing arrives? Check that the bot is ready, that `DISCORD_NOTIFY_USERS`
holds your user ID, and that you allow DMs from the bot's server.

Relay failures don't become the processor's own Discord log alerts (that
could loop). Report them out of band, with an email-only SigNoz rule on
`attribute.category = 'alert-intake' AND body CONTAINS 'Relay to Discord failed'`.

## Capturing fixtures

The test fixtures in `node/tests/fixtures/alert-intake/` were rebuilt from each
sender's source and docs, not captured. To replace one with the real thing:
point the sender at a request catcher you run yourself (for example
`nc -l 8080` or a small Express app that prints the method, path, headers and
body), send its Test, and save the request in the fixture's shape with the
key replaced by `${KEY}`. Never commit a real key or a real hostname.

## Code

| File | |
|---|---|
| `index.mjs` | builds the intake from the environment, logs its state at startup |
| `config.mjs` | the keys and limits |
| `auth.mjs` | where each format reads the key; the timing-safe match |
| `adapters/` | one pure module per format: request in, alerts or a rejection out, the replies its clients expect |
| `alert.mjs` | the normalized alert and its cleaning |
| `relay.mjs`, `dedupe.mjs`, `rateLimit.mjs` | dedupe, caps, the breaker, held-alert summaries, delivery state |
| `embeds.mjs` | the Discord embeds |
| `discordSink.mjs` | the way into Discord (NotificationManager's quiet `deliverDiscordEmbeds`) |
| `routes.mjs` | the HTTP surface |

Adding a format: an adapter in `adapters/` and a line in `adapters/index.mjs`.
A format whose senders take only a URL (Slack- or Discord-compatible) carries
its key in the path, which needs a scrub rule in `lib/spanRedaction.mjs` and
the logs before it ships.
