# AGENTS.md — nextjs-stream-media-processor

Canonical repository-wide engineering instructions. Every coding agent working
in this repository follows this file. The sibling frontend repository
(`nextjs-stream`) keeps the same file at its root; the conventions are shared
deliberately, and several invariants here exist because the frontend consumes
this backend's output.

| Agent | How it receives this file |
| --- | --- |
| OpenAI Codex | Natively — `AGENTS.md` is its project instruction file |
| GitHub Copilot | Natively in VS Code and on github.com |
| Claude Code | Through the `@AGENTS.md` import at the top of `CLAUDE.md` |

## Where the truth lives

| Document | What it is |
| --- | --- |
| [docs/BACKEND_ARCHITECTURE.md](docs/BACKEND_ARCHITECTURE.md) | Current-state architecture. Read before structural changes |
| [docs/BACKEND_OPEN_QUESTIONS.md](docs/BACKEND_OPEN_QUESTIONS.md) | Owner decision records ("Decided — not yet implemented"). Shrinking this file is the goal: an item that ships gets documented in the architecture doc, then deleted here. Never rewrite a recorded decision — append |
| [docs/jit-transcoder.md](docs/jit-transcoder.md), [docs/jit-url-addressability.md](docs/jit-url-addressability.md) | JIT transcoder contract and URL addressability |

Evidence outranks documentation: source and tests are authoritative when a doc
disagrees — verify the behaviour, follow the evidence, and fix the current-state
doc in the same change. Decision records are point-in-time and are not edited
to match later code.

## Branches and merges

- One concern per branch: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`.
- Umbrella epics are `epic/<name>` with children `epic/<prefix>-p<N>-<slug>`
  landed **in order**, one named merge commit each. When a merge changes what
  production *does* — not just how robustly it does it — the merge subject
  carries a `⚠ behavior:` marker.
- Commit locally. Do not push, and do not open a pull request, unless asked.
- Never run destructive git commands (`reset --hard`, `clean -fd`, `rebase`,
  `push --force`) on your own initiative, and treat every pre-existing
  working-tree change as user work.

## Load-bearing invariants

- **Failed ≠ absent.** A scan item that throws (unreadable directory, transient
  mount fault) must be retained and retried next tick, never treated as removed.
  Remove a name from the existing-names set before any I/O on it, so a swallowed
  error can never turn into a false removal. One bad item must never skip the
  rest of the scan, the removal loop, or downstream jobs.
- **Derived tables are a function of `movies`/`tv_shows`.** `metadata_hashes`,
  `missing_data_media`, `episode_metadata_missing` and `blurhash_hashes` are
  projections; no single failure may become a deletion in them, and removal
  cascades must cover all of them (title row deleted last).
- **`withWriteTx` is not re-entrant.** A helper running inside a write
  transaction must issue raw statements; it must not call another `deleteX`
  helper that opens its own transaction.
- **Stale hash rows are worse than missing ones.** The frontend sync skips a
  title whose `metadata_hashes` row matches, forever — a stale row silently
  freezes that title. A missing row merely costs a resync. When an inline hash
  generate fails, degrade to MISSING (delete the title's rows), never leave
  STALE.
- **JIT path keys are strict unpadded base64url** of the source path relative
  to its library root (`node/utils/jitUrl.mjs`), matching the transcoder's own
  `path_key` encoding. Never hand-build a stream URL another way.
- The frontend's sync skip-gate compares per-title `hash` only (verified
  2026-08-23 against `MovieSyncService.ts`), so regenerating identical hashes
  causes no frontend churn.
- Do not invent data to get past an error: missing, unknown, empty and
  unavailable are different states, and a sync or scan pass that suffered any
  failure is not authoritative — it may not delete rows or clear provenance.

## Verification

From `node/`: `npm test` (full Jest suite), `npm run test:unit`,
`npm run test:integration`. Scanner behaviour changes need integration
coverage (see `tests/integration/scan-failed-not-absent.test.mjs` for the
pattern). Never claim a check passed unless it ran and succeeded.

## Related repositories

The frontend (`nextjs-stream`) and this repository are usually checked out as
siblings. Build against the sibling's source when a contract question arises —
its `AGENTS.md`/`ARCHITECTURE.md` document the consuming side, including the
Mongo flat-collection sync that reads this backend's hash and media endpoints.
