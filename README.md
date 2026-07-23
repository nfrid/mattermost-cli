# mattermost-cli

Standalone, read-only Mattermost retrieval and indexing. V1 provides authentication checks, curated conversation allowlists, a disposable SQLite/FTS5 index, deterministic thread retrieval, and bounded context packets without a daemon.

## Security model

The HTTP client exposes named read operations only: bounded `GET` requests, one bounded Mattermost post-search `POST`, and an explicit attachment download used by `mm file`. It cannot post messages, edit, react, or delete, and it does not export a generic HTTP helper. Explicitly configured channels and DMs are enforced again at sync, local-search, routing, thread-hydration, and file-download boundaries.

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
  "concepts": {
    "duplicate-charge": [
      "повторное списание",
      "списали дважды",
      "duplicate charge"
    ]
  },
  "suppressAuthors": ["legacy-integration"],
  "budgets": {
    "matchNeighborhoodRadius": 2,
    "clusterMergeGap": 2,
    "conversationSurroundRoots": 5,
    "shortThreadMaxReplies": 2
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
bun run src/bin.ts search 'customer billed twice'
bun run src/bin.ts context PROJ-123
bun run src/bin.ts context --query 'deployment timeout' --repository example-service
bun run src/bin.ts context 'incident' --channel engineering --fresh
bun run src/bin.ts context 'incident' --local --no-widen
bun run src/bin.ts context PROJ-123 --include-automation
bun run src/bin.ts thread <post-id-or-permalink>
bun run src/bin.ts thread <post-id-or-permalink> --full
bun run src/bin.ts file <file-id>
bun run src/bin.ts file <file-id> --out /tmp/evidence.png
```

Repeated `--query`, `--repository`, `--scope`, and `--channel` options are supported. Queries are independent ranking/retrieval signals, not mandatory filters: a ticket relationship or other stronger evidence can still select a candidate with no textual query match, and the result emits an `unmatched_retrieval_probe` warning when that happens. Unknown repository or scope metadata hints emit `unmapped_routing_hint` rather than being ignored silently. Package callers can additionally pass typed `probes` for ticket titles/descriptions, repositories, file paths, symbols, errors, services, and participants; probe kinds are retained in match, structured-match, fusion, and remote-search diagnostics.

Unreplied bot or automation roots (Mattermost `is_bot`, post `from_bot`/`from_webhook` props, or usernames listed in `suppressAuthors`) are omitted from `context`/`search` unless `--include-automation` is set. Bot roots that already have human replies remain eligible.

For short direct-message threads, `context` may attach prior root posts from the same DM as `surround` so a late ticket link still carries the preceding problem discussion. Bounded packing keeps the root, matching posts, a tight match neighborhood (default radius 2), and a latest-post fill, then merges clusters separated by at most `clusterMergeGap` posts. Returned packets include an explicit chronological `timeline` with skip markers for omitted spans so consumers can see where evidence was dropped.

Local search uses a soft wall-clock deadline and may emit `search_deadline` with partial evidence. Concurrent freshen/sync processes take a database-adjacent lockfile; a waiter that cannot acquire it emits `freshen_lock_busy` and continues with local evidence. SQLite opens with `busy_timeout` and WAL `synchronous=NORMAL`. Context freshen is targeted (ticket-related / matched / capped stale set) rather than refreshing the entire allowlist on every call.

English and Russian significant terms and stop words are recognized. Russian search is case-insensitive and treats `ё`/`е` equivalently while preserving original messages in output.

The local index also extracts conservative engineering entities such as tickets, repository references, pull requests, commits, URLs and permalinks, file paths, scoped packages, code symbols, error codes, usernames, services, and attachment filenames. Exact structured matches are reported separately from lexical evidence and can admit a candidate without weakening conversation allowlists.

Russian retrieval indexes Snowball-normalized document tokens in a separate `morph_fts` table and reports query `morphTerms` independently from exact terms and configured expansions. Morphology uses exact stem-token matching rather than prefix matching. Retrieval channels are combined with weighted reciprocal rank fusion, capped at one contribution per probe, source, and thread; diagnostics report each contribution’s source-local rank, weight, and weighted score. Exact phrase, strict lexical, term, broad, morphology, configured concepts, synonyms, transliteration, prefix, and trigram channels have successively weaker weights. The vendored stemmer is covered by the 3-clause BSD license and is verified against selected upstream vectors.

Project-specific synonym groups can be configured with the top-level `synonyms` object; groups are symmetric, limited to 32 keys and eight aliases per key, and reported in each probe’s `expansions` diagnostics. Bounded multi-phrase domain concepts use the separate `concepts` object. A concept has a stable lowercase ID and two to eight explicit aliases; aliases cannot be shared between concepts. Matching aliases add an opaque token to the separate `concept_fts` index, while probe diagnostics expose only the concept ID and triggering phrase. Concept configuration changes automatically rebuild this disposable index.

Keyboard-layout correction, Latin-to-Russian transliteration, and mixed-script confusable correction are separate bounded expansion kinds and fusion sources. Layout correction is restricted to likely wrong-layout Latin tokens, including Russian letters entered through punctuation keys; transliteration is restricted to characteristic Russian Latin spellings. Corrected Russian forms use the morphology index, while mixed-script corrections use exact tokens. Script variants are disabled for file paths, symbols, repositories, error probes, URLs, and paths. Diagnostics retain the source token, corrected value, correction kind, source-local rank, and low fusion weight.

Candidate ranking performs a bounded in-memory proximity pass over at most eight terms per probe and 512 tokens per post; it does not add another retrieval request or index. Evidence distinguishes exact or morphological terms near each other, same-post coverage, expansion-assisted coverage, and terms distributed across a thread. Diagnostics expose same-post counts, the minimum covering token window, root/reply/across-thread term coverage, and distinct probe coverage. Exact phrase and multi-probe coverage remain stronger than proximity, and expansion-assisted proximity is deliberately non-absolute so a shallow same-line mention cannot automatically displace stronger thread evidence. Exact phrases and exact all-term matches retain stronger ranking evidence than morphological, concept, or corrected-script matches.

When otherwise equivalent candidates contain the exact query phrase in their root, ranking uses a bounded substantive-thread-depth tie-breaker before fusion and recency. The same tie-breaker is available to candidates reached through an explicit multi-word domain-concept phrase, but not through single-token technical aliases. It requires at least three posts containing six or more tokens and caps the score at five posts, so one unrelated late reply cannot promote an old thread. Diagnostics expose `threadPostCount`, `substantivePostCount`, and `threadDepthScore`; qualifying candidates include the `substantive_thread_depth` reason.

Typo fallback is evaluated per term only after exact and Russian morphology channels fail for that term. Prefix retrieval is restricted to typed or identifier-shaped repositories, filenames, symbols, and services; natural Russian words go directly from morphology to bounded typo matching. When a probe already activates a configured concept, Russian natural-word typo requests are suppressed while identifier and Latin technical fallbacks remain eligible. Trigram matching accepts one token of 5–64 characters, applies script- and length-aware similarity/edit-distance limits, and compares Russian query/document stems so an inflected correct form can match a typo without admitting a wider prefix family. Exact hits suppress typo evidence for the same term. Fusion diagnostics expose `fallbackKind`, `minimumSimilarity`, and `maximumEditDistance`, while ranking reasons distinguish `prefix_match` from `typo_match`.

Hard retrieval limits are fixed in code: each probe retains at most eight significant terms, eight morphology terms, eight concept matches, 24 generated expansions, and eight total fuzzy requests; each lexical or structured source returns at most 100 candidates. Proximity inspects at most eight terms and 512 tokens per post. These bounds keep diagnostics, fallback work, and candidate aggregation deterministic for oversized input.

Both `context` and `search` support hard thread filters: `--from <username>`, `--after <date>`, `--before <date>`, `--has-file`, and case-insensitive attachment filename substring matching with `--file <pattern>`. Dates are normalized to ISO timestamps in JSON; date-only values use UTC, date-times require `Z` or an explicit UTC offset, `after` is inclusive, and `before` is exclusive. `--file` implies `--has-file`.

Explicit `--channel` aliases are a hard V1 allowlist: sync, local search, widening, direct resolution, and final hydration cannot leave them. Without explicit channels, routing may widen once unless `--no-widen` is set.

- Normal `context` reconciles stale routed conversations and re-fetches selected threads.
- Conversation identity for retrieval comes from configured channel/DM IDs (and the local index); Mattermost is not asked to resolve every allowlisted conversation on each `context` call. Sync/freshen still validates identities for the conversations it actually refreshes.
- When routed local coverage remains stale or cutoff-bounded, `context` may use Mattermost’s bounded native post search after local retrieval; `--remote-search` requests it explicitly.
- Remote search uses only the named read-only team post-search operation—no generic HTTP helper is exposed. It runs at most four independent probes, accepts at most 20 posts per probe and 12 thread roots, rejects posts outside the currently routed configured conversations before hydration, and reports failures without discarding usable local evidence.
- When Mattermost post/thread fetch or freshen/sync fails with an API/network error but usable local evidence already exists, `context` and `thread` continue with that local evidence and emit `remote_resolve_failed`, `remote_hydrate_failed`, or `remote_freshen_failed` warnings instead of aborting the whole command.
- `--fresh` forces routed reconciliation / remote thread refresh when possible.
- `--local` performs zero network calls and conflicts with `--remote-search`.
- `search` is always local discovery, includes a permalink per candidate, defaults to the top 10 ranked candidates (`--limit <n>` overrides), and reports search coverage; use `context` before relying on a result.
- Short URL/ticket-stub threads are retained but downranked below substantive discussion with the same ticket (`thin_thread` in `--json` reasons).
- Default `context` / `thread` output is a dense bounded packet with chronological skip markers for omitted spans.
- `thread` follows the same freshness policy as `context`: fresh local threads stay local unless `--fresh` forces a remote refresh.
- Only the deliberately selected `thread --full` returns an unbudgeted complete thread.
- `file <file-id>` downloads one attachment from a configured conversation to `/tmp/mm-<id>-<name>` (or `--out <path>`). Contents are never downloaded automatically during context/sync.

Messages are never split or silently truncated. Packing omits whole messages, inserts skip markers in the timeline, and reports global/per-thread budget use, returned/omitted post counts, and returned/omitted/unreported attachment metadata counts. Attachment contents are never downloaded automatically; use `mm file <id>` for an explicit, allowlisted download.

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

Use `--agent` for a minified agent-oriented projection of the same validated result. It flattens successful command data into the top-level envelope and, for `context`, `search`, and `thread`, replaces retrieval internals with a normalized subject, completeness status (`status.threadsComplete` means packing has no omitted posts/attachments), ISO message timestamps (`messages[].at` / `editedAt`), consecutive same-author message groups interleaved with `{ "skip": { "posts", "after?", "before?" } }` markers, permalinks, omission counts, and attachment `files[].id` / `name` (plus `mimeType` / `size` when known). Optional DM `surround` groups remain available. Ranking `why` reasons stay in `--json` only; agent ranking order encodes strength. Agents should parse `--agent` JSON rather than treating it as prose. Detailed per-conversation freshness evidence remains available in `--json`; `--agent` retains only aggregate completeness status and relevant warnings. Warnings appear only once at the top level. `--agent` conflicts with `--json` and `--pretty`.

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
3. Read freshness, completeness, skip markers, budget, and omission metadata.
4. Use `thread --full` only for a selected incomplete thread; use `file <id>` for attachments of interest.
5. Treat chat as historical evidence and reconcile it with the issue tracker, code, and newer sources.

The CLI is fully functional without a daemon. WebSockets and operating-system credential-store integration are possible future enhancements.

## Archived and future experiments

- [Rejected local reranker](experiments/reranker.md)
- [Deferred hybrid semantic retrieval](experiments/semantic-search.md)

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
