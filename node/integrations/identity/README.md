# Identity providers

External systems that already know which TMDB entity a library folder is. The
processor asks each configured provider for its claims at the start of every
scan tick and applies them to each folder's `tmdb.config` through one
precedence rule. Managed folders are matched exactly; unmanaged folders keep
the name search. Nothing configured means byte-for-byte today's behaviour.

## Layout

```
integrations/identity/
├── provider.mjs        IdentityProvider contract, claim/event shapes, library-path helpers
├── registry.mjs        PROVIDER_CLASSES — the one list; order is precedence
├── index-builder.mjs   pull every provider once per tick → IdentityIndex (path → claim)
├── reconciler.mjs      apply an index to the library, produce the report
├── routes.mjs          webhook + status/report/reconcile endpoints
├── index.mjs           createIdentityService — what app.mjs uses
└── arr/
    ├── arrProvider.mjs shared *arr base (v3 API, X-Api-Key, root map, webhook shape)
    ├── radarr.mjs      movies
    └── sonarr.mjs      tv
```

The precedence rule itself lives in `utils/tmdbConfig.mjs`
(`resolveIdentityPin`, `pinTmdbIdentity`), because it is about who may change
`tmdb_id` — a property of the file, not of any provider (§4.6 of
`docs/BACKEND_ARCHITECTURE.md`).

## When it runs

Freshness is the service's own job, not the scan tick's. A scan tick can run
for ten minutes after a batch of repairs, so the report would otherwise
describe the tick's start for that long.

| Trigger | Reason | Forced? |
|---|---|---|
| the service's own job, every `IDENTITY_RECONCILE_INTERVAL_SECONDS` (default 60, `0` = off, minimum 15) | `identity-tick` | no |
| top of every scan tick (`runGenerateList`) | `scan-tick` | yes |
| `POST /api/identity/reconcile` | `manual` | yes |
| a provider webhook that names a folder | `<provider>-webhook` | yes |

Unforced runs go through a change detector: every provider list is
fingerprinted over `(path, tmdbId, hasFile)` as it arrives, the library's
folder names are fingerprinted the same way, and if neither moved since the
last real run the report keeps its `at` and gets a fresh `checkedAt` with
`unchanged: true`. Nothing on disk is read or written on such a pass. One
provider failing on an unforced run leaves the last good report untouched
(the failure is on `status.providers[].lastFetch.error`); the next run after a
failure never skips. Concurrent callers share one run.

A repair found outside the scan tick (a write with `replacedId`) requests an
early scan so the title regenerates now.

The report publishes `checkedAt` (last time the providers were compared),
`at` (last time the library was actually reconciled), `unchanged`,
`checkedReason`, and `staleAfterMs` (3 × the job interval; 3 × the scan
cadence when the job is off). A page should judge freshness on `checkedAt`
against `staleAfterMs`, never on a threshold of its own.

## How a claim becomes a repair

```
tick ─► buildIdentityIndex ─► reconcileIdentities ─► pinTmdbIdentity (per folder)
                                                        │
              write (id changed) ──► tmdb.config mtime moves ──► scanner: stale-by-config
                                                                  ──► generator force-refresh by id
              stamp (source only) ─► mtime preserved ──► nothing downstream re-runs
              keep / conflict ─────► no write; conflicts go in the report
```

The scanner and generator have no identity-specific branches. A write looks to
them exactly like an operator editing the id by hand, which is the path that
already wipes the old id's art and repulls.

## Precedence

| stored `tmdb_id_source` | provider says | result | write-back |
|---|---|---|---|
| `manual` (or no source, default reading) | same id | manual pin | none |
| `manual` | different id | manual pin; **conflict reported** | none |
| `manual` | not managed | manual pin | none |
| `auto` / a provider | same id | that id | source stamped (mtime preserved) |
| `auto` / a provider | different id | provider id (the repair) | id + source |
| `auto` / a provider | not managed | stored id | none |
| nothing | any id | provider id | id + source |
| nothing | not managed | name search (today) | id + `source=auto` |

A human pin is the only thing that beats a provider; a provider is the only
thing that beats an automatic match; a search never overwrites anything.

`IDENTITY_UNSOURCED_PINS=auto` changes the first reading: legacy pins with no
source are treated as automatic and become repairable. Use it for one pass
after checking the conflict report, then remove it.

The admin `PUT /api/admin/metadata/config` marks an id it added or changed as
`manual` (`stampProvenanceForOperatorWrite`), so a hand correction is never
undone by the next tick.

## Configuration

```env
RADARR_URL=http://radarr:7878
RADARR_API_KEY=…
SONARR_URL=http://sonarr:8989
SONARR_API_KEY=…

# Optional. Default: basename(path) under movies/ or tv/.
# RADARR_ROOT_MAP=/processed_movies=movies;/anime_movies=movies
# SONARR_ROOT_MAP=/processed_tv=tv
# RADARR_TIMEOUT_MS=15000
# IDENTITY_UNSOURCED_PINS=manual
# IDENTITY_RECONCILE_INTERVAL_SECONDS=60
```

## Webhook (optional push)

Radarr/Sonarr → Settings → Connect → Webhook:

- URL: `https://<processor>/api/identity/webhook/radarr` (or `/sonarr`)
- Method: POST
- Username: anything; Password: one of the processor's `WEBHOOK_ID_*` values

The processor reconciles the one folder the event names and starts its normal
scan tick early for import/upgrade/rename/add events, so a finished download
reaches the frontend in seconds rather than up to three minutes.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/identity/webhook/:provider` | webhook id (header or Basic password) or admin | provider push |
| `GET /api/identity/status` | webhook id or admin | providers, last index, recent events |
| `GET /api/identity/report` | webhook id or admin | last reconcile report (written, conflicts, provider-only, unmanaged) |
| `POST /api/identity/reconcile` | webhook id or admin | run a reconcile now |

## Adding a provider

1. Create `integrations/identity/<name>.mjs` (or `<family>/<name>.mjs`).
2. Subclass `IdentityProvider`. For a *arr clone, subclass `ArrProvider` and
   override `listEndpoint`, `webhookSubjectKey`, `eventKinds`, `itemHasFile`.
3. Implement `static fromEnv(env, deps)` → instance or `null` when unset.
   Throw for "set but wrong"; the registry reports it and skips the provider.
4. Implement `fetchClaims()` → `IdentityClaim[]` via `this.makeClaim(...)`.
   Claims are keyed by library-relative path (`movies/<folder>`, `tv/<folder>`).
5. Optionally implement `parseWebhook(body, headers)` → `IdentityEvent[]`.
6. Add the class to `PROVIDER_CLASSES` in `registry.mjs`.
7. Tests: a fixture of the provider's list response, `fetchClaims` against an
   injected `fetchImpl`, and (if applicable) one webhook payload per event kind.

The provider's `name` is what gets written as `tmdb_id_source`, so keep it a
short lowercase token and never rename it once shipped.
