# mattermost-cli

Standalone, read-only Mattermost retrieval and indexing. V1 provides authentication checks, curated conversation allowlists, a disposable SQLite/FTS5 index, deterministic thread retrieval, and bounded context packets without a daemon.

## Security model

The HTTP client exposes named read operations only: bounded `GET` requests, one bounded Mattermost post-search `POST`, and an explicit attachment download used by `mm file` / `mm files`. It cannot post messages, edit, react, or delete, and it does not export a generic HTTP helper. Explicitly configured channels and DMs are enforced again at sync, local-search, routing, thread-hydration, and file-download boundaries.

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
  "people": {
    "alice": "Product manager"
  },
  "budgets": {
    "matchNeighborhoodRadius": 2,
    "ticketNeighborhoodRadius": 8,
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
bun run src/cli/bin.ts whoami
bun run src/cli/bin.ts channels
bun run src/cli/bin.ts channels validate
bun run src/cli/bin.ts doctor
bun run src/cli/bin.ts sync
bun run src/cli/bin.ts sync --channel engineering
```

`channels validate` checks remote identity and type without rewriting config. `doctor` checks authentication, team/conversation access, FTS5, index integrity/migrations, writable directories, and private `.env`/config/database permissions. Run it after setup and after credential, server, or path changes.

Initial sync is bounded by `historyDays`. It traverses stable post cursors and records whether the indexed history is complete or cutoff-bounded. Incremental sync reconciles an overlap window and advances freshness only after durable success. Use the explicit, potentially expensive full rebuild only when needed:

```bash
bun run src/cli/bin.ts sync --full
```

## Retrieve context

```bash
bun run src/cli/bin.ts search 'deployment timeout'
bun run src/cli/bin.ts search 'customer billed twice'
bun run src/cli/bin.ts context PROJ-123
bun run src/cli/bin.ts context --query 'deployment timeout' --repository example-service
bun run src/cli/bin.ts context 'incident' --channel engineering --fresh
bun run src/cli/bin.ts context 'incident' --local --no-widen
bun run src/cli/bin.ts context PROJ-123 --include-automation
bun run src/cli/bin.ts context PROJ-123 --timeline
bun run src/cli/bin.ts context PROJ-123 --brief
bun run src/cli/bin.ts people --channel engineering
bun run src/cli/bin.ts thread <post-id-or-permalink>
bun run src/cli/bin.ts thread <post-id-or-permalink> --full
bun run src/cli/bin.ts file <file-id>
bun run src/cli/bin.ts file <file-id> --out /tmp/evidence.png
bun run src/cli/bin.ts files file-a file-b --out-dir /tmp/mm-evidence
bun run src/cli/bin.ts files --post <post-id> --out-dir /tmp/mm-evidence
bun run src/cli/bin.ts files --thread <thread-id> --out-dir /tmp/mm-evidence
```

Repeated `--query`, `--repository`, `--scope`, and `--channel` options are supported. Queries are independent ranking/retrieval signals, not mandatory filters: a ticket relationship or other stronger evidence can still select a candidate with no textual query match, and the result emits an `unmatched_retrieval_probe` warning when that happens. Unknown repository or scope metadata hints emit `unmapped_routing_hint` rather than being ignored silently. Package callers can additionally pass typed `probes` for ticket titles/descriptions, repositories, file paths, symbols, errors, services, and participants; probe kinds are retained in match, structured-match, fusion, and remote-search diagnostics.

Probes are ranking input, so they change *which* threads are selected, not only how the selected ones are ordered: a packet built with `--query` is not a superset of the same subject without it, and both are honest — they answer differently ranked questions. A ticket subject routes only to conversations already linked to that ticket, so `--query` probes can reorder that set but never reach beyond it. When a ticket subject is combined with explicit `--query` probes, `context` therefore also returns `background[]`: up to five pointers (`threadId`, conversation, permalink, `latestActivityAt`, matched probes, excerpts, and a `mm thread` argv in `--agent`) found by those probes in the remaining configured conversations. Background pointers are never hydrated, never packed, and never part of thread selection — the packet is identical with or without them — so they answer "why does this task exist at all" without disturbing ranking.

Unreplied bot or automation roots (Mattermost `is_bot`, post `from_bot`/`from_webhook` props, or usernames listed in `suppressAuthors`) are omitted from `context`/`search` unless `--include-automation` is set. Bot roots that already have human replies remain eligible.

For short direct-message threads, `context` may attach prior root posts from the same DM as `surround` so a late ticket link still carries the preceding problem discussion. Bounded packing keeps the root, matching posts, a tight match neighborhood (default radius 2), short high-priority latest posts, optional structural/densest-window anchors, then merges clusters separated by at most `clusterMergeGap` posts and spends leftover budget on the largest internal skip (`gap_fill`). When a subject ticket is mentioned more than once, packing treats the continuous span from the first hit through the last hit (plus neighborhood radius) as on-topic so decision middles are not labeled `omitted_gap` and refused by gap-fill. After unused global budget is reclaimed, a truncated **primary** ticket thread may be repacked so the subject-ticket core stays contiguous (edge trim / off-window drops preferred over mid-core holes; a noisy off-window root may be omitted). When only one or two candidate threads fit the packet, each receives a larger initial per-thread share of `defaultMaxCharacters`; after selection, truncated threads reclaim otherwise-unused global budget, strongest first, without exceeding the global limit. For ticket subjects, selection reserves the last thread slot for the best thin ticket stub when stronger substantive threads would otherwise crowd it out. Returned packets include an explicit chronological `timeline` with skip markers for omitted spans so consumers can see where evidence was dropped. Agent output adds `recommendFull` / `largestSkip` / `omittedRatio` when posts were omitted, plus top-level `relatedTickets` parsed from selected threads and `evidence.selection.droppedCandidates` for omitted ranked hits. Dropped candidates retain the `excerpt` added in schema version 2 and may add up to two distinct `excerpts[]` already available from ranking; they are never hydrated automatically. Candidates whose ranking reasons are purely routing or ordering artifacts (`rank_fusion`, `routing_*`, `conversation_priority`, `latest_activity`) are filtered out before the cap, so the list carries real lexical or structured matches plus actionable thin/ticket drops rather than the rest of the allowlist. `inspect_dropped` in `evidence.next` is emitted only for actionable thin or ticket-related drops.

Local search uses a soft wall-clock deadline and may emit `search_deadline` with partial evidence. Concurrent freshen/sync processes take a database-adjacent lockfile; a waiter that cannot acquire it emits `freshen_lock_busy` and continues with local evidence. SQLite opens with `busy_timeout`, open/migrate retries while another process holds the write lock, and WAL `synchronous=NORMAL`. Context freshen is targeted (ticket-related / matched / capped stale set) rather than refreshing the entire allowlist on every call.

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

An unknown `--channel` alias fails with `unknown_conversation` naming the closest known alias (when one is close enough to be worth suggesting) and a capped list of known aliases, channels before direct messages; an alias that is configured but not yet indexed is reported as such with the `mm sync --channel <alias>` that would fix it, rather than as a typo. Explicit `--channel` aliases are a hard V1 allowlist: sync, local search, widening, direct resolution, and final hydration cannot leave them. Without explicit channels, routing may widen once unless `--no-widen` is set.

- Normal `context` reconciles stale routed conversations and re-fetches selected threads.
- Conversation identity for retrieval comes from configured channel/DM IDs (and the local index); Mattermost is not asked to resolve every allowlisted conversation on each `context` call. Sync/freshen still validates identities for the conversations it actually refreshes.
- When routed local coverage remains stale or cutoff-bounded, `context` may use Mattermost’s bounded native post search after local retrieval; `--remote-search` requests it explicitly.
- Remote search uses only the named read-only team post-search operation—no generic HTTP helper is exposed. Its `returnedPosts` is the literal server-search count, so zero does not invalidate candidates found through local FTS or structured ticket relationships. It runs at most four independent probes, accepts at most 20 posts per probe and 12 thread roots, rejects posts outside the currently routed configured conversations before hydration, and reports failures without discarding usable local evidence.
- When Mattermost post/thread fetch or freshen/sync fails with an API/network error but usable local evidence already exists, `context` and `thread` continue with that local evidence and emit `remote_resolve_failed`, `remote_hydrate_failed`, or `remote_freshen_failed` warnings instead of aborting the whole command. A thread that comes back inconsistent (missing root, moved or re-rooted posts) is a `mattermost`-sourced `thread_not_found` / `post_not_found` / `thread_boundary_mismatch` error, never a configuration or routing one.
- `context` decides a candidate against indexed evidence before fetching it, so ranking noise costs no Mattermost request; candidates the local index cannot judge (remote-search results) are still fetched. One candidate that cannot be retrieved is dropped with `dropReason: "unavailable"` and a `candidate_hydrate_failed` warning instead of failing the request, except for a directly targeted post, which has no alternative and still fails. Past the per-request hydration ceiling, remaining candidates use indexed evidence only and the packet reports `hydration_budget` with non-current `evidence.currency`.
- `--fresh` forces routed reconciliation / remote thread refresh when possible.
- `--local` performs zero network calls and conflicts with `--remote-search`.
- `--brief` (on `context` / `thread`) returns the decision layer only; `--navigate` returns lean navigation on the default packing budget; `--short` remains the legacy small-budget card mode. `--timeline` (on `context`) merges the selected threads into one chronology instead of repeating them per thread, and combines with `--brief`.
- `people` lists indexed authors with their Mattermost profile role, message counts, and latest activity, scoped to the configured allowlist (`--channel` narrows it, `--limit` truncates). Roles reach the index only when a sync touches that author, so a cold index reports `role unknown`; when most listed people lack a role the command adds a `roles_unindexed` warning pointing at `mm sync`.
- `context`, `search`, and `thread` accept `--out <path>`: the result document is written there (overwriting an explicit path, as `mm file --out` does) and stdout carries only `{"out","bytes"}` (or a one-line human receipt). A failed command is never redirected — the error stays on the stream the caller is reading.
- `context` defaults to network reconciliation while `search` never leaves the local index, so the two commands can see different candidate sets for the same subject; `search` emits `stale_local_index` when its index is behind, and `context --local` is the way to compare like with like.
- `search` is always local discovery (accepts `--local` for symmetry), includes a permalink per candidate, defaults to the top 10 ranked candidates (`--limit <n>` overrides), and reports search coverage; use `context` before relying on a result. In `--agent` output each candidate carries a 1-based `rank`, its ranking `reasons[]`, and at most `--excerpts <n>` excerpts (default 3; the remainder is counted in `omittedExcerpts` and the full match list stays in `--json`).
- Short URL/ticket-stub threads are retained but downranked below substantive discussion with the same ticket (`thin_thread` in `--json` reasons).
- Default `context` / `thread` output is a dense bounded packet with chronological skip markers for omitted spans. The prose renderer prints the `role: "primary"` thread first and labels each section `[primary]` / `[secondary]` with its retrieval `rank`; `--json` / `--agent` keep threads in retrieval order, so `rank` is how the two views map onto each other.
- `thread` follows the same freshness policy as `context`: fresh local threads stay local unless `--fresh` forces a remote refresh.
- Only the deliberately selected `thread --full` returns an unbudgeted complete thread.
- `file <file-id>` downloads one attachment from a configured conversation to `/tmp/mm-<id>-<name>`, or to `--out <path>` (explicit path, overwrites), or into `--out-dir <dir>` (attachment name, created if missing, never overwrites — same naming and refusal rules as `mm files`). `--out` and `--out-dir` conflict. Contents are never downloaded automatically during context/sync.
- `files` downloads a bounded batch into a required `--out-dir` from exactly one selector: positional `<file-id…>`, `--post <id>`, or `--thread <id>`. Defaults: max **20** files and **50 MiB** total; refuses overwrites; path-traversal-safe names; per-file success/error/skip in the result (command succeeds when at least one file downloads). Still never auto-runs from `context`.

Messages are never split or silently truncated. Packing omits whole messages, inserts skip markers in the timeline, and reports global/per-thread budget use, returned/omitted post counts, and returned/omitted/unreported attachment metadata counts. Attachment contents are never downloaded automatically; use `mm file <id>` or `mm files … --out-dir <dir>` for an explicit, allowlisted download.

Historical chat is evidence, not automatically current product truth. Reconcile it with the issue tracker, code, documentation, and newer authoritative sources.

## JSON contract

Add `--json` to emit exactly one minified JSON document on stdout. Use `--pretty` instead for indented JSON when debugging. Progress and human diagnostics never share JSON stdout. Every result has:

```json
{
  "command": "context",
  "schemaVersion": 4,
  "success": true,
  "data": {},
  "warnings": []
}
```

Failures replace `data` with a stable error containing `source`, `kind`, and `message`. Retrieval contracts include freshness mode/timestamps, `searchCoverageComplete`, `selectedThreadsComplete` for context packets, searched conversations and routing evidence (including unmatched hints), explicit-channel/widening state, deterministic ranking reasons/order, candidate permalinks, budgets, and omission counts. Context packets also expose whether bounded remote search was requested or performed, its trigger, per-probe accepted counts, failures, and `remote_search` selection reasons, plus an `evidence` summary (`adequacy`, selected-evidence `currency`, `completeness` including separate discovery freshness, actionable `next[]`, selection drop counts / `droppedCandidates[]`, and packing stats), `selection` drop counts, one-hop `relatedTickets` pointers, and per-thread ticket-window fields (`ticketDensity`, `nearestTicketDistance`, `segments`). The legacy `complete` field remains an alias for search coverage.

Use `--agent` for a minified agent-oriented projection of the same validated result. It flattens successful command data into the top-level envelope and, for `context`, `search`, and `thread`, replaces retrieval internals with a normalized subject, slim `status.freshness`, ISO message timestamps (`messages[].at` / `editedAt`), consecutive same-author message groups interleaved with `{ "skip": { "posts", "after?", "before?", "reason?", "files?" } }` markers (`outside_ticket_window` / `omitted_gap` when ticket-window packing left a gap; `files` counts live attachments swallowed by that gap), permalinks, omission counts, packing hints (`recommendFull` / `largestSkip` / `omittedRatio` when posts were omitted), `evidence`, optional one-hop `relatedTickets` pointers (never hydrated; `alreadyInPacket: true` when the source thread is already in the packet), and attachment `files[].id` / `name` (plus `mimeType` / `size` when known) with copy-ready `downloadCommand` argv (`["mm","file",id,"--agent"]`). Threads carry `messageCount` (packed messages, as opposed to `posts[]` entries, which are author blocks or `{ skip }` markers) and, for context packets, a 1-based retrieval `rank` that is independent of `role`. Threads may set `filesPresent: true` when any packed post has attachments, and carry a flat `attachments[]` index (`id` / `name` / `postId` / `inPacket` / `mediaOnly?` / `downloadCommand`) covering both returned posts and posts hidden inside skip spans, so downloading is an informed decision; `attachmentsTruncated: true` marks a capped index, and `omitted.unreportedAttachments` counts omitted attachments whose metadata did not fit the reporting budget. Every thread carries `latestAt`; an untruncated thread that stops on a question or an error message also carries mechanical `tail` (`kind` / `postId` / `at`). Default `--agent` attaches a lean per-thread `brief` (`purposeHints` / `decisionPostIds` / inlined `decisions[]` with `id` / `author` / `at` / `text`, optional `ackPostId`, optional `refinements[]` — later posts that narrow the decision's scope — inlined `openQuestions[]` with `repliesAfter` and optional `isThreadTail`, and an optional mechanical `outcomeWindow`) and omits full advisory `signals` / `technicalEntities`; pass `--signals` on `context` / `thread` to include both (capped packed-post entities plus candidate spans / roleHints / outcome window) — `brief` may still appear alongside. `purposeHints` labels are `announce` | `decision` | `open_question` | `debugging` | `status` | `noise`; `open_question` marks unresolved questions, which are no longer folded into `debugging`, and fires whenever the thread's last packed post is itself a question (suppressed on a truncated packet, which cannot know how the thread ended). `openQuestions[]` is the symmetric counterpart of `decisions[]`: `repliesAfter: 0` means nobody spoke after it *inside this packet*, which is not proof the question is still open. Every `decisions[]` entry carries `kind`: `approved_decision` (approval or agreement phrasing, or a personal commitment another author affirmed with a short «ок» / «да»), `discussion_outcome` (someone reports where a discussion landed — «обсудили…», «итого…» — which is not a go-ahead), `implementation_intent` (one author states what *they* will do), or `proposal` (every sentence carrying the cue also hedges, so it is an option, not a course). Entries are ordered strongest first and the cap keeps the strongest, so an acknowledged agreement is never displaced by a louder intent; only `approved_decision` may be reported as something the team settled, and even that is a cue reading — weigh the author against `people[]`. Negated cues («не решили», "not going with", "never approved") produce no decision at all. Symmetrically, each `openQuestions[]` entry carries `kind`: `question` (something is being asked or explicitly not settled) or `follow_up` (deferred work stated as a fact — «рано или поздно надо будет привести модерацию в порядок» is not waiting on an answer); a `?` inside a URL does not make a follow-up into a question. A post inlined as a decision is never repeated as an open question. Decision-layer texts (`decisions[].text`, their `refinements[].text`, and `openQuestions[].text`) are budgeted far more generously than pointer excerpts, because they are read *instead of* the post; when the packet still had to cut one it sets `textTruncated: true` on that entry. Treat a trailing `…` alone as nothing — authors type it too — and read the cited post before relying on a truncated decision's conditions. `signals.candidateSpans[].excerpt` stays pointer-sized by design and carries no such flag. `outcomeWindow` is tail-anchored: when the window after the last subject-ticket mention exceeds its cap, the emitted `postIds` are its final posts and `precedingInWindow` counts the eligible posts ahead of that slice — those posts remain in the packet, so it is not an omission count. A post whose text is empty while carrying a live attachment is marked `mediaOnly: true` on both the message and its attachment entry; when such a post lands after the last subject-ticket mention (or is the last packed post without a ticket subject), `evidence.next` carries one `recommended` `read_attachments` step (`impact: "may_contradict_visible_text"`, with `postId` and a single-file argv). Execute only `priority: "recommended"` entries from `evidence.next`; at most one `thread_full` is ever `recommended` (the primary or widest-skip thread), and further truncated threads appear as `optional`. Do not invent optional `sync` / `inspect_dropped` follow-ups when absent. `inspect_dropped`, when emitted, carries `["mm","thread",<droppedId>,"--agent"]` — copy that argv rather than re-running `context`. Secondary threads may include `presentation: "announce"` (typically `multi_ticket_root`) for assignment/bulletin noise, not the decision body. Optional DM `surround` may include `surroundRelevance` (`low` | `possible`); treat `low` as skippable unless needed. `possible` means relevance could not be ruled out — including when the thread root is a bare link with no vocabulary to compare against, where `low` would be an unearned verdict. There is no positive-relevance verdict. `thread --agent` emits `threads: [thread]` plus context-like `evidence`, so every command shares one top-level `threads[]` array — there is no `packet` wrapper object. The duplicated singular `thread` key was removed in schema version 3. Start with default `context --agent`; use `--navigate` when you need lean navigation (`anchors` / `clusters` / `skips` / packing hints; no dense `posts` or top-level `messages`). `--navigate` packs on the **default** budget and changes only the projection, so a lean view no longer demands a follow-up `thread --full`. Each anchor is one post carrying every role it plays in `kinds[]` (`root` / `ticket_mention` / `match_hit` / `file` / `multi_ticket` / `codeish` / `latest`) rather than one repeated entry per role. `--brief` is the decision-only projection: `evidence`, per-thread `brief`, and only the outcome-window / decision posts, with every withheld packed post collapsed into a `{ "skip": { "reason": "brief_projection" } }` marker and the envelope marked `projection: "brief"` — shown messages plus skip counts always equal `messageCount`. `--brief`, `--navigate`, and `--short` are mutually exclusive. `--timeline` adds a top-level `timeline[]` merging every selected thread into one chronology (`at` / `conversation` / `threadId` / `author` / `postId` / `text`, plus `editedAt` / `deleted` / `anchor` / `mediaOnly` / `files` and `{ skip }` gap entries) and drops per-thread `posts[]`, so each message travels exactly once; ranked thread order routinely presents a rollout note after the report that it broke, and the merged view is the only place that sequence is readable. `--timeline --brief` merges the decision layer only. Context packets also carry `people[]` — the authors of the packed posts as `username` plus `role` / `roleSource` (`profile` from the Mattermost profile title, `config` from the local `people` map) — so a statement's weight is attributable; the agent projection deliberately omits display names. `--short` remains the legacy card+timeline projection (anchors plus short `messages` and `posts`) and conflicts with `--navigate`. Ranking `why` reasons stay in `--json` only; agent ranking order encodes strength. Agents should parse `--agent` JSON rather than treating it as prose. For a post-id or permalink subject, `context` / `thread` add `resolved` (`postId` / `from` / `threadId` / `inPacket`) and mark the requested message with `anchor: true`, so a returned `threadId` that differs from the requested id is legible rather than looking like a substitution. When some searched conversation is cutoff-bounded, `evidence.history.cutoffBounded[]` names each one with `oldestIndexedAt` and `inSelectedThreads` (capped, with `additional`). `evidence.selection.droppedNoMatch` counts candidates that ranked but carried no current content match; `dropReason: "unavailable"` marks a candidate whose thread could not be retrieved, so it was never judged. `evidence.completeness.selectedThreads` is `complete` | `truncated` | `not_applicable`, the last when no thread was selected at all — an empty packet has no transcript to call truncated. `evidence.completeness.selection` is a separate axis from `selectedThreads`: `budget_bounded` means ranked candidates were never examined because thread/character room or the hydration ceiling ran out, so the packet cannot speak for them — `selectedThreads: "complete"` alongside it only means nothing was dropped *inside* the selected threads. When enough candidates went unexamined, `evidence.next` adds an `optional` `review_candidates` step carrying `["mm","search",<subject>,"--agent"]`. Detailed per-conversation freshness evidence remains available in `--json`; `--agent` retains aggregate `evidence` status and relevant warnings. Warnings appear only once at the top level. `--agent` conflicts with `--json` and `--pretty`.

Zod schemas and inferred TypeScript types for every command are exported from the package, including `commandResultV1Schema`, command-specific `*ResultV1Schema` values, and `parseCommandResultV1`. Complete synthetic golden documents live in `src/contracts/contracts.v1.fixture.json`.

Schema policy:

- compatible optional/additive fields may retain the current `schemaVersion`;
- removing or renaming a field, changing its meaning/type, changing required ordering, or changing error source/kind semantics requires a schema-version increment; widening an existing enum counts, since a strict consumer cannot parse the new value — `schemaVersion` 4 adds `completeness.selectedThreads: "not_applicable"` alongside the additive `people[]`, `timeline[]`, `brief.openQuestions[]`, `decisions[].refinements[]`, and the `people` command;
- human prose is opaque and may change without a schema-version increment.

## Package API

Documented package surface (see `src/index.ts`):

- `getMattermostContext` / `searchMattermost` / `getMattermostThread` and their input/result types
- V1 Zod schemas (`contextResultV1Schema`, `commandResultV1Schema`, …)
- `projectAgentResult` for `--agent` projection
- `MattermostClient` / connection helpers and Mattermost schemas
- `loadMattermostConfig` / config types

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
  schemaVersion: 4,
  success: true,
  data,
  warnings: [],
});
```

## Source layout

```text
src/
  cli/           Commander program, command handlers, bin entry
  config/        Local config load + validation
  contracts/     V1 Zod schemas and golden fixtures
  context/       Orchestration: prepare, freshen, hydrate, selection, filters
  evidence/      Packing, ticket segments, evidence status summary
  mattermost/    Read-only HTTP client (`http.ts` transport + resource methods)
  output/        Human format, `--agent` projection, cross-thread timeline, shared labels
  search/        Subject/probes, routing, lexical retrieval, fusion, ranking
  store/         SQLite schema, reads/writes, FTS/trigram helpers
  sync/          Sync, setup/doctor, file download, conversation allowlist
  shared/        Errors, locks, limits, paths, concurrency
  benchmark/     Retrieval benchmark + compare CLIs
```

Internal modules under those directories are not part of the documented package API.

## Migrations, backup, and recovery

Database migrations run automatically and transactionally whenever a database-using command opens the store. Applied versions are recorded in `schema_migrations`; no manual migration command is required.

SQLite is a disposable retrieval index, not the source of truth. A backup is optional and useful only to avoid another backfill. Concurrent `mm` processes wait on SQLite locks (`busy_timeout` plus open retries) instead of treating a busy index as corrupt. If `doctor` reports a corrupt or incompatible index — after other `mm` processes have stopped — optionally copy the database for diagnosis, then rebuild:

```bash
rm -f .mattermost/mattermost.sqlite3 \
      .mattermost/mattermost.sqlite3-shm \
      .mattermost/mattermost.sqlite3-wal
bun run src/cli/bin.ts sync
```

A failed sync or migration does not advance a successful freshness checkpoint. Timeouts, inaccessible conversations, missing roots, and partial reconciliation produce explicit errors or incomplete warnings rather than current-looking evidence.

## Recommended retrieval workflow

1. Run `doctor` when local health or credentials are uncertain.
2. Prefer one constrained `context … --agent` call with ticket/repository/scope/channel hints; do not open with `--navigate` just to save tokens.
3. Read `evidence` first; execute only `priority: "recommended"` from `next`. Do not invent optional sync/inspect follow-ups when absent. Use `brief` on primary then secondaries — `decisions[]` carries the decision text inline, so resolving ids against the timeline is rarely needed; skip `presentation: "announce"` and `surroundRelevance: "low"` unless needed.
4. Use `thread --full --agent` only for a selected incomplete thread; for `inspect_dropped`, copy the provided `thread … --agent` argv. Consult `attachments[]` before concluding from text alone: an entry with `inPacket: false`, or a `skip` marker carrying `files`, means decisive evidence may sit outside the packet. Download with the `downloadCommand` argv or `files --thread … --out-dir` and Read before UI/screenshot-dependent claims. Do not re-`context` related tickets marked `alreadyInPacket`.
5. Treat chat as historical evidence and reconcile it with the issue tracker, code, and newer sources.

The CLI is fully functional without a daemon. WebSockets and operating-system credential-store integration are possible future enhancements.

## Archived and future experiments

- [Rejected local reranker](experiments/reranker.md)
- [Deferred hybrid semantic retrieval](experiments/semantic-search.md)

## Development and release gate

```bash
bun --bun run check
```

The opt-in Mattermost 11.9 smoke gate is strictly read-only and requires an explicitly configured safe channel, post, and query. A DM is included when configured:

```bash
MATTERMOST_INTEGRATION=1 \
MATTERMOST_SMOKE_CHANNEL_ID=<configured-channel-id> \
MATTERMOST_SMOKE_DM_ID=<optional-configured-dm-id> \
MATTERMOST_SMOKE_POST_ID=<safe-post-id> \
MATTERMOST_SMOKE_QUERY=<safe-query> \
bun --bun run check:release
```

The smoke database is created in an OS temporary directory and removed afterward. The suite does not post, react, edit, delete, download attachments, or write captured messages to tracked fixtures.
