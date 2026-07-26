# Retrieval

## Commands

```bash
mm search 'deployment timeout'
mm context PROJ-123
mm context --query 'deployment timeout' --repository example-service
mm context 'incident' --channel engineering --fresh
mm context 'incident' --local --no-widen
mm context PROJ-123 --include-automation
mm context PROJ-123 --timeline
mm context PROJ-123 --brief
mm people --channel engineering
mm thread <post-id-or-permalink>
mm thread <post-id-or-permalink> --full
mm file <file-id>
mm file <file-id> --out /tmp/evidence.png
mm files file-a file-b --out-dir /tmp/mm-evidence
mm files --post <post-id> --out-dir /tmp/mm-evidence
mm files --thread <thread-id> --out-dir /tmp/mm-evidence
```

`context` defaults to network reconciliation while `search` never leaves the
local index, so the two commands can see different candidate sets for the same
subject. `search` emits `stale_local_index` when its index is behind, and
`context --local` is the way to compare like with like.

## Probes and queries

Repeated `--query`, `--repository`, `--scope`, and `--channel` options are
supported. Package callers can additionally pass typed `probes` for ticket
titles and descriptions, repositories, file paths, symbols, errors, services,
and participants; probe kinds are retained in match, structured-match, fusion,
and remote-search diagnostics.

Queries are independent ranking and retrieval signals, not mandatory filters. A
ticket relationship or other stronger evidence can still select a candidate with
no full textual query match, and the result emits an
`unmatched_retrieval_probe` diagnostic when that happens. It has
`severity: "informational"`; the strict `status: "no_match"` may still include
`matchedTerms`, `missingTerms`, and bounded `partialEvidencePostIds` from
selected packet evidence. Those fields explain lexical overlap but never create
a background pointer or claim semantic equivalence. Unknown repository or scope
metadata hints likewise emit informational `unmapped_routing_hint` rather than
being ignored silently. These
hints are exact configured metadata values, not workspace names inferred from a
ticket: an unmapped hint did not narrow routing, but does not make otherwise
selected evidence invalid. The informational warning lists capped known values
only from conversations eligible for this request, so callers can correct an
exact metadata alias without exposing unrelated config; it never auto-normalizes
or widens routing.

Probes change *which* threads are selected, not only how the selected ones are
ordered: a packet built with `--query` is not a superset of the same subject
without it, and both are honest — they answer differently ranked questions.

### Background pointers

A ticket subject routes only to conversations already linked to that ticket, so
`--query` probes can reorder that set but never reach beyond it. When a ticket
subject is combined with explicit `--query` probes, `context` therefore also
returns `background[]`: up to five pointers (`threadId`, conversation,
`permalink`, `latestActivityAt`, matched probes, excerpts, and an `mm thread`
argv in `--agent`) found by those probes in the remaining configured
conversations.

Background pointers are never hydrated, never packed, and never part of thread
selection — the packet is identical with or without them — so they answer "why
does this task exist at all" without disturbing ranking.

## Filters

Both `context` and `search` support hard thread filters:

| Filter | Meaning |
| --- | --- |
| `--from <username>` | thread author |
| `--after <date>` | inclusive lower bound |
| `--before <date>` | exclusive upper bound |
| `--has-file` | thread has an attachment |
| `--file <pattern>` | case-insensitive attachment filename substring; implies `--has-file` |

Dates are normalized to ISO timestamps in JSON. Date-only values use UTC;
date-times require `Z` or an explicit UTC offset.

Unreplied bot or automation roots (Mattermost `is_bot`, post `from_bot` /
`from_webhook` props, or usernames listed in `suppressAuthors`) are omitted from
`context` and `search` unless `--include-automation` is set. Bot roots that
already have human replies remain eligible.

## Conversation allowlist

An unknown `--channel` alias fails with `unknown_conversation` naming the
closest known alias (when one is close enough to be worth suggesting) and a
capped list of known aliases, channels before direct messages. An alias that is
configured but not yet indexed is reported as such, with the
`mm sync --channel <alias>` that would fix it, rather than as a typo.

Explicit `--channel` aliases are a hard V1 allowlist: sync, local search,
widening, direct resolution, and final hydration cannot leave them. Without
explicit channels, routing may widen once unless `--no-widen` is set.

A refused conversation fails with `conversation_not_allowed` carrying
`error.details`:

- `reason` — `not_configured` when the conversation is absent from the config,
  `channel_restriction` when the caller's own `--channel` excluded an otherwise
  configured one;
- `postId` echoes the caller-supplied target;
- `conversationId` is present only for `channel_restriction`, where the
  conversation is configured and already visible through `mm channels`; an
  unconfigured refusal never reveals its conversation identity;
- `conversationAlias` and `restrictionSource: "cli"` for a configured
  conversation excluded by the caller's explicit flag;
- `restrictedTo` for that caller-supplied restriction;
- `recommendedAction` naming what would change it. Advice to drop or widen
  `--channel` is emitted only when that flag actually caused the refusal.

`mm` never widens the allowlist itself.

## Freshness and failure handling

- Normal `context` reconciles stale routed conversations and re-fetches selected
  threads.
- Conversation identity for retrieval comes from configured channel/DM IDs and
  the local index; Mattermost is not asked to resolve every allowlisted
  conversation on each `context` call. Sync and freshen still validate
  identities for the conversations they actually refresh.
- When routed local coverage remains stale or cutoff-bounded, `context` may use
  Mattermost's bounded native post search after local retrieval;
  `--remote-search` requests it explicitly.
- Remote search uses only the named read-only team post-search operation — no
  generic HTTP helper is exposed. Its `returnedPosts` is the literal
  server-search count, so zero does not invalidate candidates found through
  local FTS or structured ticket relationships. It runs at most four independent
  probes, accepts at most 20 posts per probe and 12 thread roots, rejects posts
  outside the currently routed configured conversations before hydration, and
  reports failures without discarding usable local evidence.
- When a Mattermost post/thread fetch or a freshen/sync fails with an API or
  network error but usable local evidence already exists, `context` and `thread`
  continue with that local evidence and emit `remote_resolve_failed`,
  `remote_hydrate_failed`, or `remote_freshen_failed` instead of aborting. A
  thread that comes back inconsistent (missing root, moved or re-rooted posts)
  is a `mattermost`-sourced `thread_not_found` / `post_not_found` /
  `thread_boundary_mismatch` error, never a configuration or routing one.
- `context` decides a candidate against indexed evidence before fetching it, so
  ranking noise costs no Mattermost request; candidates the local index cannot
  judge (remote-search results) are still fetched. One candidate that cannot be
  retrieved is dropped with `dropReason: "unavailable"` and a
  `candidate_hydrate_failed` warning instead of failing the request — except a
  directly targeted post, which has no alternative and still fails. Past the
  per-request hydration ceiling, remaining candidates use indexed evidence only
  and the packet reports `hydration_budget` with non-current `evidence.currency`.
- `--fresh` forces routed reconciliation and remote thread refresh when
  possible. `--local` performs zero network calls and conflicts with
  `--remote-search`.
- Local search uses a soft wall-clock deadline and may emit `search_deadline`
  with partial evidence.
- `thread` follows the same freshness policy as `context`: fresh local threads
  stay local unless `--fresh` forces a remote refresh.

## Command behavior

- `--brief` (on `context` / `thread`) returns the decision layer only.
  `--navigate` returns lean navigation on the default packing budget.
  `--short` remains the legacy small-budget card mode. `--timeline` (on
  `context`) merges the selected threads into one chronology instead of
  repeating them per thread, and combines with `--brief`.
- `search` is always local discovery (it accepts `--local` for symmetry),
  includes a permalink per candidate, defaults to the top 10 ranked candidates
  (`--limit <n>` overrides), and reports search coverage; use `context` before
  relying on a result. In `--agent` output each candidate carries a 1-based
  `rank`, its ranking `reasons[]`, and at most `--excerpts <n>` excerpts
  (default 3; the remainder is counted in `omittedExcerpts` and the full match
  list stays in `--json`).
- `people` lists indexed authors with their Mattermost profile role, message
  counts, and latest activity, scoped to the configured allowlist (`--channel`
  narrows it, `--limit` truncates). Roles reach the index only when a sync
  touches that author, so a cold index reports `role unknown`; when most listed
  people lack a role the command adds a `roles_unindexed` warning pointing at
  `mm sync`.
- `context`, `search`, and `thread` accept `--out <path>`: the result document
  is written there (overwriting an explicit path, as `mm file --out` does) and
  stdout carries only a compact receipt — `{"out","bytes"}` plus `adequacy`,
  `threads`, `warnings`, and `recommendedNext` when the document has them, or
  the same as a one-line human sentence. The receipt exists so a caller can tell
  whether a `recommended` step is waiting without a second pass over the file,
  which is the read `--out` was meant to avoid; it never replaces the document.
  A failed command is never redirected — the error stays on the stream the
  caller is reading.
- Default `context` / `thread` output is a dense bounded packet with
  chronological skip markers for omitted spans. The prose renderer prints the
  `role: "primary"` thread first and labels each section `[primary]` /
  `[secondary]` with its retrieval `rank`; `--json` / `--agent` keep threads in
  retrieval order, so `rank` is how the two views map onto each other.
- Only the deliberately selected `thread --full` returns an unbudgeted complete
  thread.
- Short URL/ticket-stub threads are retained but downranked below substantive
  discussion with the same ticket (`thin_thread` in `--json` reasons).

## Attachments

- `file <file-id>` downloads one attachment from a configured conversation to
  `/tmp/mm-<id>-<name>`, or to `--out <path>` (explicit path, overwrites), or
  into `--out-dir <dir>` (attachment name, created if missing, never overwrites
  — same naming and refusal rules as `mm files`). `--out` and `--out-dir`
  conflict. `--inspect` additionally emits a bounded textual preview or an
  explicit `not_interpreted` state for images, spreadsheets, and other binaries.
- `files` downloads a bounded batch into a required `--out-dir` from exactly one
  selector: positional `<file-id…>`, `--post <id>`, or `--thread <id>`. Defaults
  are max **20** files and **50 MiB** total. It refuses overwrites, uses
  path-traversal-safe names, and reports per-file success/error/skip in the
  result; the command succeeds when at least one file downloads.

Attachment contents are never downloaded automatically during `context` or
`sync`. Inspection is explicit and only decodes a bounded UTF-8 preview; the
reported format is filename/MIME classification, not CSV/JSON/XML syntax
validation. It does not perform OCR, image captioning, or binary spreadsheet
parsing.

## Extra permalink targets

`context` accepts a repeatable `--permalink <url>` (a permalink or a bare post
id) that folds extra links into the same packet — a ticket description routinely
links two or three posts, and reading them otherwise costs one process each plus
manual reconciliation.

Those threads are packed **before** ranked candidates, since the caller already
decided they are evidence, and they are exempt from the subject-match drop that
would otherwise discard a linked thread for not naming the ticket.

Each target is reported in `permalinks[]` with `input` (verbatim, so it maps
back to the argument), `status` (`resolved` | `duplicate` | `not_allowed` |
`unresolved` | `invalid`), the `postId` / `threadId` / `conversationId` it
reached, and `packed`. `resolved` only says the link pointed at an allowed
conversation — packing can still drop it, so a resolved-but-unpacked link is not
evidence anyone read.

Because `maxThreads` is small, several links can fill the packet on their own;
when that leaves no room for any ranked candidate the packet warns
`permalink_crowded_out_ranked` instead of looking as though the subject had no
threads.

Failures are per link rather than fatal: one link outside the allowlist must not
cost the caller the others. The allowlist is never widened to serve an explicit
link — a configured conversation excluded by the caller's own `--channel` is
reported `not_allowed` with `details.reason: "channel_restriction"`.

## Packing

For short direct-message threads, `context` may attach prior root posts from the
same DM as `surround` so a late ticket link still carries the preceding problem
discussion.

Bounded packing keeps the root, matching posts, a tight match neighborhood
(default radius 2), short high-priority latest posts, and optional structural or
densest-window anchors. It then merges clusters separated by at most
`clusterMergeGap` posts and spends leftover budget on the largest internal skip
(`gap_fill`).

When a subject ticket is mentioned more than once, packing treats the continuous
span from the first hit through the last hit (plus neighborhood radius) as
on-topic, so decision middles are not labeled `omitted_gap` and refused by
gap-fill. After unused global budget is reclaimed, a truncated **primary** ticket
thread may be repacked so the subject-ticket core stays contiguous — edge trim
and off-window drops are preferred over mid-core holes, and a noisy off-window
root may be omitted.

When only one or two candidate threads fit the packet, each receives a larger
initial per-thread share of `defaultMaxCharacters`; after selection, truncated
threads reclaim otherwise-unused global budget, strongest first, without
exceeding the global limit. For ticket subjects, selection reserves the last
thread slot for the best thin ticket stub when stronger substantive threads
would otherwise crowd it out.

Messages are never split or silently truncated. Packing omits whole messages,
inserts skip markers in the timeline, and reports global and per-thread budget
use, returned/omitted post counts, and returned/omitted/unreported attachment
metadata counts.

Returned packets include an explicit chronological `timeline` with skip markers
for omitted spans so consumers can see where evidence was dropped. Agent output
adds `recommendFull` / `largestSkip` / `omittedRatio` when posts were omitted,
plus top-level `relatedTickets` parsed from selected threads and
`evidence.selection.droppedCandidates` for omitted ranked hits.

Dropped candidates retain the `excerpt` added in schema version 2 and may add up
to two distinct `excerpts[]` already available from ranking; they are never
hydrated automatically. Candidates whose ranking reasons are purely routing or
ordering artifacts (`rank_fusion`, `routing_*`, `conversation_priority`,
`latest_activity`) are filtered out before the cap, so the list carries real
lexical or structured matches plus actionable thin/ticket drops rather than the
rest of the allowlist. `inspect_dropped` in `evidence.next` is emitted only for
actionable thin or ticket-related drops.

## Ranking internals

### Language handling

English and Russian significant terms and stop words are recognized. Russian
search is case-insensitive and treats `ё` / `е` equivalently while preserving
original messages in output.

Russian retrieval indexes Snowball-normalized document tokens in a separate
`morph_fts` table and reports query `morphTerms` independently from exact terms
and configured expansions. Morphology uses exact stem-token matching rather than
prefix matching. The vendored stemmer is covered by the 3-clause BSD license and
is verified against selected upstream vectors.

### Structured entities

The local index extracts conservative engineering entities such as tickets,
repository references, pull requests, commits, URLs and permalinks, file paths,
scoped packages, code symbols, error codes, usernames, services, and attachment
filenames. Exact structured matches are reported separately from lexical
evidence and can admit a candidate without weakening conversation allowlists.

### Fusion

Retrieval channels are combined with weighted reciprocal rank fusion, capped at
one contribution per probe, source, and thread; diagnostics report each
contribution's source-local rank, weight, and weighted score. Exact phrase,
strict lexical, term, broad, morphology, configured concepts, synonyms,
transliteration, prefix, and trigram channels have successively weaker weights.

### Script correction

Keyboard-layout correction, Latin-to-Russian transliteration, and mixed-script
confusable correction are separate bounded expansion kinds and fusion sources.
Layout correction is restricted to likely wrong-layout Latin tokens, including
Russian letters entered through punctuation keys; transliteration is restricted
to characteristic Russian Latin spellings. Corrected Russian forms use the
morphology index, while mixed-script corrections use exact tokens. Script
variants are disabled for file paths, symbols, repositories, error probes, URLs,
and paths. Diagnostics retain the source token, corrected value, correction
kind, source-local rank, and low fusion weight.

### Proximity

Candidate ranking performs a bounded in-memory proximity pass over at most eight
terms per probe and 512 tokens per post; it does not add another retrieval
request or index. Evidence distinguishes exact or morphological terms near each
other, same-post coverage, expansion-assisted coverage, and terms distributed
across a thread. Diagnostics expose same-post counts, the minimum covering token
window, root/reply/across-thread term coverage, and distinct probe coverage.

Exact phrase and multi-probe coverage remain stronger than proximity, and
expansion-assisted proximity is deliberately non-absolute so a shallow same-line
mention cannot automatically displace stronger thread evidence. Exact phrases
and exact all-term matches retain stronger ranking evidence than morphological,
concept, or corrected-script matches.

### Thread-depth tie-breaker

When otherwise equivalent candidates contain the exact query phrase in their
root, ranking uses a bounded substantive-thread-depth tie-breaker before fusion
and recency. The same tie-breaker is available to candidates reached through an
explicit multi-word domain-concept phrase, but not through single-token
technical aliases. It requires at least three posts containing six or more
tokens and caps the score at five posts, so one unrelated late reply cannot
promote an old thread. Diagnostics expose `threadPostCount`,
`substantivePostCount`, and `threadDepthScore`; qualifying candidates include
the `substantive_thread_depth` reason.

### Typo and prefix fallback

Typo fallback is evaluated per term only after exact and Russian morphology
channels fail for that term. Prefix retrieval is restricted to typed or
identifier-shaped repositories, filenames, symbols, and services; natural
Russian words go directly from morphology to bounded typo matching. When a probe
already activates a configured concept, Russian natural-word typo requests are
suppressed while identifier and Latin technical fallbacks remain eligible.

Trigram matching accepts one token of 5–64 characters, applies script- and
length-aware similarity and edit-distance limits, and compares Russian
query/document stems so an inflected correct form can match a typo without
admitting a wider prefix family. Exact hits suppress typo evidence for the same
term. Fusion diagnostics expose `fallbackKind`, `minimumSimilarity`, and
`maximumEditDistance`, while ranking reasons distinguish `prefix_match` from
`typo_match`.

### Hard limits

Fixed in code, to keep diagnostics, fallback work, and candidate aggregation
deterministic for oversized input:

| Limit | Value |
| --- | --- |
| significant terms per probe | 8 |
| morphology terms per probe | 8 |
| concept matches per probe | 8 |
| generated expansions per probe | 24 |
| total fuzzy requests per probe | 8 |
| candidates per lexical or structured source | 100 |
| proximity terms per probe | 8 |
| proximity tokens per post | 512 |
