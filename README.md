# mattermost-cli

Standalone, read-only Mattermost retrieval and indexing. V1 provides authentication checks, curated conversation allowlists, a disposable SQLite/FTS5 index, deterministic thread retrieval, and bounded context packets without a daemon.

## Security model

The HTTP client exposes named read operations only: bounded `GET` requests and one bounded Mattermost post-search `POST`. It cannot post messages, edit, react, delete, or download attachment contents, and it does not export a generic HTTP helper. Explicitly configured channels and DMs are enforced again at sync, local-search, routing, and thread-hydration boundaries.

Mattermost PATs inherit the permissions of their user; they do not provide fine-grained scopes. Create a PAT under the Mattermost profile security settings only if PATs are enabled, use the least-privileged suitable account, and configure only conversations this tool needs. Never put a PAT in command arguments, committed files, logs, or issue text.

The preferred current source is `MATTERMOST_TOKEN`. An ignored local config token is supported but is plaintext, not encrypted secret storage. Git ignore rules reduce accidental tracking but do not protect against another process or user that can read the file. Operating-system credential-store integration is not currently available.

Mattermost URLs must use HTTPS. Plain HTTP is accepted only for loopback development. API success and error bodies are bounded, known tokens are redacted before displayed error truncation, local database files are set to mode `0600`, and `.mattermost` directories created by the tool use mode `0700`.

## Requirements

- Bun 1.3.3 or a compatible current Bun release
- a self-hosted Mattermost 11.9-compatible server
- a Mattermost PAT
- access to one configured Mattermost team

## Setup

```bash
bun install --frozen-lockfile
mkdir -p .mattermost
chmod 700 .mattermost
cp config.example.json .mattermost/config.json
chmod 600 .mattermost/config.json
cp .env.example .env
chmod 600 .env
```

Edit `.mattermost/config.json`. Channels and direct messages are separate allowlists. A DM or group message is eligible only when its channel ID appears explicitly under `directMessages`.

```json
{
  "schemaVersion": 1,
  "url": "https://mattermost.example.test",
  "teamId": "team-id",
  "historyDays": 365,
  "synonyms": {
    "репликация": ["replication", "data replication"]
  },
  "channels": {
    "engineering": {
      "id": "channel-id",
      "name": "engineering",
      "description": "Engineering discussion",
      "repositories": ["example-service"],
      "scopes": ["backend"]
    }
  },
  "directMessages": {
    "leads": {
      "channelId": "dm-or-group-channel-id",
      "description": "Explicitly allowed project coordination conversation",
      "participants": ["alice", "bob"]
    }
  }
}
```

Default paths are tied to this repository rather than the caller's current directory:

```text
.mattermost/config.json
.mattermost/mattermost.sqlite3
```

Environment overrides are available for controlled local use:

```text
MATTERMOST_URL
MATTERMOST_TOKEN
MATTERMOST_CONFIG
MATTERMOST_DATABASE
```

Overrides may select alternate files only under this repository's `.mattermost/` directory; paths outside that private, ignored runtime boundary are rejected.

## Validate and synchronize

```bash
bun run src/bin.ts whoami
bun run src/bin.ts channels
bun run src/bin.ts channels validate
bun run src/bin.ts doctor
bun run src/bin.ts sync
bun run src/bin.ts sync --channel engineering
```

`channels validate` checks remote identity and type without rewriting config. `doctor` checks authentication, team/conversation access, FTS5, index integrity/migrations, writable directories, and private `.env`/config/database permissions. Run it after setup and after credential, server, or path changes.

Initial sync is bounded by `historyDays`. It traverses stable post cursors and records whether the indexed history is complete or cutoff-bounded. Incremental sync reconciles an overlap window and advances freshness only after durable success. Use the explicit, potentially expensive full rebuild only when needed:

```bash
bun run src/bin.ts sync --full
```

## Retrieve context

```bash
bun run src/bin.ts search 'deployment timeout'
bun run src/bin.ts context PROJ-123
bun run src/bin.ts context --query 'deployment timeout' --repository example-service
bun run src/bin.ts context 'incident' --channel engineering --fresh
bun run src/bin.ts context 'incident' --local --no-widen
bun run src/bin.ts context 'incident' --more
bun run src/bin.ts thread <post-id-or-permalink> --more
bun run src/bin.ts thread <post-id-or-permalink> --full
```

Repeated `--query`, `--repository`, `--scope`, and `--channel` options are supported. Queries are independent ranking/retrieval signals, not mandatory filters: a ticket relationship or other stronger evidence can still select a candidate with no textual query match, and the result emits an `unmatched_retrieval_probe` warning when that happens. Unknown repository or scope metadata hints emit `unmapped_routing_hint` rather than being ignored silently. Package callers can additionally pass typed `probes` for ticket titles/descriptions, repositories, file paths, symbols, errors, services, and participants; probe kinds are retained in match, structured-match, fusion, and remote-search diagnostics.

English and Russian significant terms and stop words are recognized. Russian search is case-insensitive and treats `ё`/`е` equivalently while preserving original messages in output.

The local index also extracts conservative engineering entities such as tickets, repository references, pull requests, commits, URLs and permalinks, file paths, scoped packages, code symbols, error codes, usernames, services, and attachment filenames. Exact structured matches are reported separately from lexical evidence and can admit a candidate without weakening conversation allowlists.

Russian retrieval uses bounded inflection-prefix variants, a small built-in set of common Russian/English engineering aliases, and mixed-script transliteration for technical tokens. Project-specific synonym groups can be configured with the top-level `synonyms` object; groups are symmetric, limited to 32 keys and eight aliases per key, and reported in each probe’s `expansions` diagnostics. Exact phrases and exact all-term matches retain stronger ranking evidence than expanded matches.

Both `context` and `search` support hard thread filters: `--from <username>`, `--after <date>`, `--before <date>`, `--has-file`, and case-insensitive attachment filename substring matching with `--file <pattern>`. Dates are normalized to ISO timestamps in JSON; date-only values use UTC, date-times require `Z` or an explicit UTC offset, `after` is inclusive, and `before` is exclusive. `--file` implies `--has-file`.

Explicit `--channel` aliases are a hard V1 allowlist: sync, local search, widening, direct resolution, and final hydration cannot leave them. Without explicit channels, routing may widen once unless `--no-widen` is set.

- Normal `context` reconciles stale routed conversations and re-fetches selected threads.
- When routed local coverage remains stale or cutoff-bounded, `context` may use Mattermost’s bounded native post search after local retrieval; `--remote-search` requests it explicitly.
- Remote search uses only the named read-only team post-search operation—no generic HTTP helper is exposed. It runs at most four independent probes, accepts at most 20 posts per probe and 12 thread roots, rejects posts outside the currently routed configured conversations before hydration, and reports failures without discarding usable local evidence.
- `--fresh` forces routed reconciliation.
- `--local` performs zero network calls and conflicts with `--remote-search`.
- `search` is always local discovery, includes a permalink per candidate, and reports search coverage; use `context` before relying on a result.
- Default human `context` output shows a compact root/match/latest view while JSON retains the complete bounded packet.
- `--more` increases bounded packet limits and expands human rendering.
- Only the deliberately selected `thread --full` returns an unbudgeted complete thread.

Messages are never split or silently truncated. Packing omits whole messages and reports global/per-thread budget use, returned/omitted post counts, and returned/omitted/unreported attachment metadata counts. Attachment contents are never downloaded automatically.

Historical chat is evidence, not automatically current product truth. Reconcile it with the issue tracker, code, documentation, and newer authoritative sources.

## JSON contract

Add `--json` to emit exactly one minified JSON document on stdout. Use `--pretty` instead for indented JSON when debugging. Progress and human diagnostics never share JSON stdout. Every result has:

```json
{
  "command": "context",
  "schemaVersion": 1,
  "success": true,
  "data": {},
  "warnings": []
}
```

Failures replace `data` with a stable error containing `source`, `kind`, and `message`. Retrieval contracts include freshness mode/timestamps, `searchCoverageComplete`, `selectedThreadsComplete` for context packets, searched conversations and routing evidence (including unmatched hints), explicit-channel/widening state, deterministic ranking reasons/order, candidate permalinks, budgets, and omission counts. Context packets also expose whether bounded remote search was requested or performed, its trigger, per-probe accepted counts, failures, and `remote_search` selection reasons. The legacy `complete` field remains an alias for search coverage in V1.

Use `--agent` for a minified agent-oriented projection of the same validated result. It flattens successful command data into the top-level envelope and, for `context`, `search`, and `thread`, replaces retrieval internals with a normalized subject, completeness status, semantic selection reasons, ISO timestamps, compact posts/files, permalinks, and omission counts. Detailed per-conversation freshness evidence remains available in `--json`; `--agent` retains only aggregate completeness status and relevant warnings. Warnings appear only once at the top level. `--agent` conflicts with `--json` and `--pretty`.

Zod schemas and inferred TypeScript types for every command are exported from the package, including `commandResultV1Schema`, command-specific `*ResultV1Schema` values, and `parseCommandResultV1`. Complete synthetic V1 golden documents live in `src/contracts.v1.fixture.json`.

Schema policy:

- compatible optional/additive fields may retain `schemaVersion: 1`;
- removing or renaming a field, changing its meaning/type, changing required ordering, or changing error source/kind semantics requires a schema-version increment;
- human prose is opaque and may change without a schema-version increment.

## Package API

```ts
import {
  contextResultV1Schema,
  getMattermostContext,
} from "mattermost-cli";

const data = await getMattermostContext({
  subject: "PROJ-123",
  repositories: ["example-service"],
  probes: [
    { kind: "ticket_title", value: "Payment reconciliation timeout" },
    { kind: "file_path", value: "src/payments/reconcile.ts" },
    { kind: "symbol", value: "reconcilePayment" },
    { kind: "error_message", value: "upstream request timed out" },
  ],
  from: "alice",
  after: "2026-01-01",
  hasFile: true,
  file: ".log",
  remoteSearch: true,
});

contextResultV1Schema.parse({
  command: "context",
  schemaVersion: 1,
  success: true,
  data,
  warnings: [],
});
```

## Migrations, backup, and recovery

Database migrations run automatically and transactionally whenever a database-using command opens the store. Applied versions are recorded in `schema_migrations`; no manual migration command is required.

SQLite is a disposable retrieval index, not the source of truth. A backup is optional and useful only to avoid another backfill. If `doctor` reports a corrupt, locked, or incompatible index, stop other `mm` processes, optionally copy the database for diagnosis, then rebuild:

```bash
rm -f .mattermost/mattermost.sqlite3 \
      .mattermost/mattermost.sqlite3-shm \
      .mattermost/mattermost.sqlite3-wal
bun run src/bin.ts sync
```

A failed sync or migration does not advance a successful freshness checkpoint. Timeouts, inaccessible conversations, missing roots, and partial reconciliation produce explicit errors or incomplete warnings rather than current-looking evidence.

## Recommended retrieval workflow

1. Run `doctor` when local health or credentials are uncertain.
2. Prefer one constrained `context` call with ticket/repository/scope/channel hints.
3. Read freshness, completeness, routing, budget, and omission metadata.
4. Use `thread --more` or `thread --full` only for a selected thread.
5. Treat chat as historical evidence and reconcile it with the issue tracker, code, and newer sources.

The CLI is fully functional without a daemon. WebSockets and operating-system credential-store integration are possible future enhancements.

## Development and release gate

```bash
bun run check
```

The opt-in Mattermost 11.9 smoke gate is strictly read-only and requires an explicitly configured safe channel, post, and query. A DM is included when configured:

```bash
MATTERMOST_INTEGRATION=1 \
MATTERMOST_SMOKE_CHANNEL_ID=<configured-channel-id> \
MATTERMOST_SMOKE_DM_ID=<optional-configured-dm-id> \
MATTERMOST_SMOKE_POST_ID=<safe-post-id> \
MATTERMOST_SMOKE_QUERY=<safe-query> \
bun run check:release
```

The smoke database is created in an OS temporary directory and removed afterward. The suite does not post, react, edit, delete, download attachments, or write captured messages to tracked fixtures.
