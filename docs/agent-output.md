# Agent output (`--agent`)

`--agent` emits a minified agent-oriented projection of the same validated
result described in the [JSON contract](json-contract.md). It conflicts with
`--json` and `--pretty`.

For successful commands it flattens command data into the top-level envelope.
For `context`, `search`, and `thread` it replaces retrieval internals with a
normalized subject and a reader-shaped packet.

Agents should parse `--agent` JSON rather than treating it as prose.

## Projections

`--navigate`, `--short`, and `--full-posts` remain exclusive with each other;
`--brief` combines with `--full-posts` (decision layer + dense posts). Ticket
`--agent --navigate` still keeps the top-level brief / `researchSummary` (lean
posts + decision layer). Explicit `--brief --navigate` is also allowed.

| Projection | Contents |
| --- | --- |
| default (non-ticket) | dense `posts` and `messages`, per-thread `brief`, `evidence` |
| ticket `--agent` default / `--brief` | decision layer only (`projection: "brief"`) |
| ticket `--agent --full-posts` | dense posts **and** top-level merged `brief` / `researchSummary` (no `projection: "brief"`) |
| `--navigate` | lean navigation: `anchors` / `clusters` / `skips` / packing hints; ticket `--agent` still emits top-level `brief` |
| `--timeline` | one merged chronology instead of per-thread `posts[]` |
| `--short` | legacy card + timeline projection |
| `--follow-recommended` | after packing, run `priority: "recommended"` next steps once and merge into one packet + `followLog[]` (requires `--agent`) |

For a **ticket** subject, `context … --agent` applies the brief projection
automatically (`projection: "brief"` on the envelope). Pass `--full-posts` to
keep dense posts **while still emitting** top-level `brief`, or `--navigate` /
`--short` for those modes. Free-text and post subjects keep the dense default
unless `--brief` is explicit. Start ticket research with `context KEY --agent`.

When brief filtering or packing omits chronology, `timelineComplete: false`
marks that the visible timeline is incomplete.

**`--navigate`** gives `anchors` / `clusters` / `skips` and packing hints with no
dense `posts` and no top-level `messages`. Ticket `--agent --navigate` still
emits top-level `brief` / `researchSummary` for orientation. It still uses the
**default** total character budget, but reserves a fair per-thread share of
`maxThreads` so one fat candidate cannot silently drop siblings; if budget still
truncates selection, the packet warns `navigate_truncated_threads`. Each anchor
is one post carrying every role it plays in `kinds[]` (`root` /
`ticket_mention` / `match_hit` / `file` / `multi_ticket` / `codeish` / `latest`)
rather than one repeated entry per role. `--short` conflicts with `--navigate`.

**`--follow-recommended`** (requires `--agent`) executes each
`evidence.next` step with `priority: "recommended"` once — thread gap recovery,
inspect_dropped, and `read_attachments` (including media-only images that may
need OCR). Broad `sync` is skipped. Steps that still need an external reader
after inspect are logged as `skipped_external_reader` and the chain
**continues** with remaining recommended steps. Results merge into the same
context packet with `followLog[]` (always present when the flag ran — empty when
there was nothing to do), optional `followExhausted: true` when no further
recommended next remains, and optional `followedAttachments[]` (inspect/OCR text
is merged onto matching `threads[].attachments[].inspection` when present).
There is no persistent session store.

Context agent packets also emit `hints.readOrder` — a stable list of fields to
read first. Orient on `researchSummary.primaryThreadId`; agent `threads[].role`
is aligned to that id (retrieval rank stays in `rank`).

**`--brief`** (and the ticket `--agent` default) returns `evidence`, a top-level
merged `brief`, per-thread `threads[].brief`, and only the decision layer:
outcome-window posts, decisions, acknowledgements, refinements, open questions,
file-bearing posts, and their capped response pointers. Every other packed post
collapses into a `{ "skip": { "reason": "brief_projection" } }` marker and the
envelope is marked `projection: "brief"` — shown messages plus skip counts always
equal `messageCount`. The top-level `brief` merges `decisions[]` and
`openQuestions[]` across selected threads (unresolved open questions are never
dropped from the merge; answered ones fill remaining slots); each entry carries
`threadId`. Per-thread briefs remain for locality. Use `--full-posts` when you
need the dense transcript **together with** the decision brief.

**`--timeline`** adds a top-level `timeline[]` merging every selected thread into
one chronology (`at` / `conversation` / `threadId` / `author` / `postId` /
`text`, plus `editedAt` / `deleted` / `anchor` / `mediaOnly` / `files` and
`{ skip }` gap entries) and drops per-thread `posts[]`, so each message travels
exactly once. Ranked thread order routinely presents a rollout note after the
report that it broke, and the merged view is the only place that sequence is
readable. `--timeline --brief` merges the decision layer only; ticket
`--agent --timeline` gets the same brief+timeline pairing by default.

## Threads

Every command shares one top-level `threads[]` array — there is no `packet`
wrapper object. `thread --agent` emits `threads: [thread]` plus context-like
`evidence`. The duplicated singular `thread` key was removed in schema version 3.

Opaque numeric score vectors stay in `--json`; agent ranking order encodes
strength. `search --agent` candidates carry bounded `reasons[]` and
`contributingProbes[]` so retrieval contributions can be attributed without
claiming every term matched or exposing score internals. For context packets each thread carries a 1-based retrieval `rank`,
independent of `role`.

### Counts

- `messageCount` — packed messages, as opposed to `posts[]` entries, which are
  author blocks or `{ skip }` markers.
- `totalPosts` — what the whole thread holds, and what `mm thread --full`
  returns.

`totalPosts - messageCount` is exactly `omitted.posts`, so the two numbers
differing is packing, not a discrepancy.

### Messages and skips

Messages carry ISO timestamps (`messages[].at` / `editedAt`). Consecutive
same-author messages are grouped, interleaved with
`{ "skip": { "posts", "after?", "before?", "reason?", "files?" } }` markers.
Skip reasons include `outside_ticket_window` and `omitted_gap` when
ticket-window packing left a gap; `files` counts live attachments swallowed by
that gap.

Threads also carry permalinks, omission counts, and packing hints
(`recommendFull` / `largestSkip` / `omittedRatio`) when posts were omitted.

### Tail

Every thread carries `latestAt`. An untruncated thread that stops on a question
or an error message also carries a mechanical `tail` (`kind` / `postId` / `at`).
Absent `tail` is not evidence of resolution — it is withheld on a truncated
packet, which cannot know how a thread ended.

## The decision layer (`brief`)

Default `--agent` attaches a lean per-thread `brief` and omits the full advisory
`signals` / `technicalEntities`. Pass `--signals` on `context` / `thread` to
include both (capped packed-post entities plus candidate spans, `roleHints`, and
the outcome window); `brief` may still appear alongside.

Under `--brief` or the ticket `--agent` brief default (`projection: "brief"`),
the envelope also carries a top-level `brief` with merged `decisions[]` and
`openQuestions[]` across threads — strongest first, each entry annotated with
`threadId`. Per-thread `threads[].brief` is unchanged.

`threads[].brief` contains `purposeHints`, `decisionPostIds`, inlined
`decisions[]`, inlined `openQuestions[]`, and an optional mechanical
`outcomeWindow`.

### `purposeHints`

Labels are `announce` | `decision` | `open_question` | `debugging` | `status` |
`noise`. `open_question` marks unresolved questions — these are no longer folded
into `debugging` — and fires whenever the thread's last packed post is itself a
question. It is suppressed on a truncated packet.

### `decisions[]`

Each entry carries `id` / `author` / `at` / `text`, an optional `ackPostId`
plus its inlined verbatim `acknowledgement`, optional `refinements[]` (later
posts that narrow the decision's scope), and a `kind`. Short settled cues may
also carry `supportingPostIds` / `supportingExcerpt` from a preceding packed
proposal or intent (verbatim only — never a paraphrase). Soft
`offlineOrVoiceApproval: true` marks offline/voice phrasing («обсудили голосом»,
«на дейли») without upgrading `kind` into a substantive in-channel approval. A
question containing a scope word is not itself a refinement; only a
non-interrogative follow-up is attached. Top-level merged entries also carry
`threadId`.

Architectural approach statements («оставляем на стороне…», «отдельный роут»,
«separate endpoint») surface as `proposal` only — never as
`approved_decision`, even when short-acked.

When a short affirming ack among the final packed posts confirms an earlier
decision that adjacency pairing missed, the brief may also carry
`lateAcknowledgement` (`kind: "late_thread_acknowledgement"`) with its own
lower confidence. That field is not a widened `ackPostId` window. Under
`projection: "brief"`, the strongest late ack is also promoted to top-level
`brief.lateAcknowledgement` (with `threadId`); `hints.readOrder` points at it.

| `kind` | Meaning |
| --- | --- |
| `approved_decision` | approval or agreement phrasing, or a personal commitment another author affirmed with a short «ок» / «да» |
| `discussion_outcome` | someone reports where a discussion landed («обсудили…», «итого…») — not a go-ahead |
| `implementation_intent` | one author states what *they* will do |
| `proposal` | every sentence carrying the cue also hedges, so it is an option, not a course; also architectural approach cues |

Entries are ordered strongest first and the cap keeps the strongest, so an
acknowledged agreement is never displaced by a louder intent. Only
`approved_decision` may be reported as something the team settled — and even
that is a cue reading, so weigh the author against `people[]`.

Negated cues («не решили», "not going with", "never approved") produce no
decision at all.

### `openQuestions[]`

The historically named counterpart of `decisions[]`. The name is not a verified
claim that every item remains open. Each entry carries `repliesAfter`, an
optional `isThreadTail`, a conservative packet-local `resolution`, and capped
`responsePostIds` to inspect, plus a `kind`:

- `question` — something is being asked or explicitly not settled;
- `follow_up` — deferred work stated as a fact. «рано или поздно надо будет
  привести модерацию в порядок» is not waiting on an answer.

A `?` inside a URL does not make a follow-up into a question. A post inlined as a
decision is never repeated as an open question.

`resolution` is `possibly_answered` when another author replied later,
`unanswered` only when a complete packed thread ends on the question, and
`unknown` otherwise. `answered` is reserved for future evidence stronger than
mere chronology. `possibly_answered` is deliberately not a conclusion: read the
cited `responsePostIds`, which also carry capped `responseExcerpts[]`
(`id` / `author` / `at` / `text`) drawn from already-packed response posts so a
reader need not resolve ids against the timeline. Likewise, `repliesAfter: 0`
alone is not proof that the question is still open. Top-level merged entries
also carry `threadId`.

### Text budgets

Decision-layer texts (`decisions[].text`, their `refinements[].text`, and
`openQuestions[].text`) are budgeted far more generously than pointer excerpts,
because they are read *instead of* the post. When the packet still had to cut
one it sets `textTruncated: true` on that entry. `responseExcerpts[].text` stays
pointer-sized.

Treat a trailing `…` alone as nothing — authors type it too — and read the cited
post before relying on a truncated decision's conditions.
`signals.candidateSpans[].excerpt` stays pointer-sized by design and carries no
such flag.

### `outcomeWindow`

Tail-anchored. When the window after the last subject-ticket mention exceeds its
cap, the emitted `postIds` are its final posts and `precedingInWindow` counts the
eligible posts ahead of that slice — those posts remain in the packet, so it is
not an omission count.

### `researchSummary`

Optional top-level roll-up on `context` / `thread` agent packets:
`primaryThreadId` (best orientation thread: strongest decision-bearing thread
when any exist, otherwise highest ticket signal / non-noise purpose — agent
`threads[].role` is aligned to this id),
`decisionThreadIds` (threads that contribute brief decisions, strongest-first),
`decisionsByKind` (zeros omitted), `unresolvedOpenQuestions` (packet-local
resolutions other than `possibly_answered` / `answered`; matches the unresolved
entries kept in top-level `brief.openQuestions[]`),
`blockedOrUnresolvedPermalinks` (caller inputs with status `not_allowed` /
`unresolved` / `invalid`), and `recommendedNext` (action names from
`evidence.next` steps with `priority: "recommended"`). Counts and ids only — never
LLM prose.

## Attachments

Threads may set `filesPresent: true` when any packed post has attachments, and
carry a flat `attachments[]` index (`id` / `name` / `postId` / `inPacket` /
`mediaOnly?` / `downloadCommand` / `inspectCommand` / optional `inspection`)
covering both returned posts and posts hidden inside skip spans, so downloading
is an informed decision. After `--follow-recommended` succeeds at OCR/preview,
`inspection` carries low-trust `preview` / `text_extracted` text on both
`followedAttachments[]` and the matching thread attachment entry.
`attachmentsTruncated: true` marks a capped index, and
`omitted.unreportedAttachments` counts omitted attachments whose metadata did not
fit the reporting budget.

Message-level `files[]` carry `id` / `name` (plus `mimeType` / `size` when known)
with separate copy-ready commands: `downloadCommand` only downloads, while
`inspectCommand` includes `--inspect` and is the command to use when the
attachment itself is evidence. Nested `messages[]` also carry `author` (same
username as the parent group) so a flat map cannot invent `@None`.

A post whose text is empty while carrying a live attachment is marked
`mediaOnly: true` on both the message and its attachment entry.

`mm file <id> --inspect --agent` downloads the file and, for bounded textual
formats (CSV/TSV/TXT/LOG/JSON/NDJSON/XML/SQL), returns an `inspection` preview:
at most 64 KiB decoded, 10 lines by default (override with bounded
`--preview-lines 1..40`), and 8,000 characters. It explicitly reports
`decoded: true` and `syntaxValidated: false`; format classification does not
claim CSV rows or JSON/XML syntax were parsed. CSV/TSV columns with common
sensitive headers are replaced with `[REDACTED]` and reported through
`sensitiveFieldsDetected` / `redactionApplied`. Detection is best effort, not an
anonymization guarantee. The preview carries `truncated` when any bound cut it.

OOXML `.xlsx` workbooks get a bounded sheet preview (`format: "spreadsheet"`)
with `sheets` / `activeSheet` / `headers` / `rowCount` plus a CSV-like
`preview` of the first sheet (same line/character caps and header PII
redaction). Large workbook ZIP members (multi-MB `sharedStrings.xml` /
worksheet XML) are accepted up to an 8 MiB critical-entry cap; sheet XML may be
prefix-scanned for the first preview rows. `downloaded: true` / `inspected: true`
means a textual preview was produced — not that the whole workbook was verified.
Legacy `.xls` / `.ods` remain `not_interpreted`.

Images stay `status: "not_interpreted"` when no text can be extracted
(`downloaded: true` / `inspected: false`). OCR preference:

1. `MATTERMOST_OCR_MODULE` — explicit JS module exporting `extractImageText`
2. On macOS (Darwin), when that env is unset and `MATTERMOST_OCR_DISABLE_MACOS`
   is not `1`, mm tries the built-in Vision helper (`macos-vision`, low trust)
3. Otherwise `not_interpreted` + `external_image_reader_required`

Successful extraction yields `status: "text_extracted"` with `trust: "low"` /
`source: "ocr"`. Never treat OCR text as high-trust evidence. See
[retrieval.md](./retrieval.md#opt-in-ocr).

### `read_attachments` steps

When a media-only post lands after the last subject-ticket mention — or is the
last packed post without a ticket subject — `evidence.next` carries a
`read_attachments` step with a `postId` and a single-file argv. Textual files and
previewable `.xlsx` that `--inspect` can read stay `recommended` (xlsx keeps
`impact: "cannot_verify_quantities"`). Media-only **images** stay
`recommended` with `impact: "requires_external_reader"` so agents (and
`--follow-recommended`) attempt OCR / download before
`canAnswerFromSelectedEvidence` can become true. Legacy workbooks (`.xls` /
`.ods`) on decision posts stay `optional` with `requires_external_reader`.

A data file (`csv` / `tsv` / `xlsx` / `xls` / `ods` / `json` / `ndjson` / `log` /
`sql` / `txt`) attached to a post the brief flagged — a decision, one of its
refinements, or an open question — gets its own step with `reason:
"data_file_on_decision_post"`. Such a post has text, so the media-only rule never
covered it, yet the file is where a quantitative claim («вот дубли») lives.
Bounded textual formats and previewable `.xlsx` use
`impact: "may_verify_quantitative_claim"` or `cannot_verify_quantities` and stay
`recommended` (or `optional` behind a media-only step). Legacy workbooks
(`.xls` / `.ods`) use `impact: "requires_external_reader"` and `optional`
priority; the argv still includes `--inspect` so the packet can report
`not_interpreted` plus `downloaded`/`inspected`.

Pending media-only outcome attachments (and unresolved external-reader decision
attachments) keep `canAnswerFromSelectedEvidence: false` until `--inspect` /
follow yields `preview` or `text_extracted` for that file id.

## `evidence.next`

Execute only `priority: "recommended"` entries. Packing omissions normally
produce a `thread_around` command requesting posts from the largest skipped
range with `--window-only`, capped by both 50 posts and the per-thread character
budget (estimated from packed post size), rather than replaying the complete
thread. That mode disables normal structural/tail anchors and projects only the
explicit range under the character budget. Mattermost's thread endpoint still
supplies the thread to the local read-only hydration layer; the bound applies to
emitted model context, not server transfer or the ignored local index. Its
top-level `retrieval` reports requested and returned posts; `evidence.scope:
"gap_recovery"` and `gapRecovery` appear **only** on `thread --window-only
--agent` (the gap-window response), where `gapRecovery.requestedRangeComplete`,
not general answerability, decides whether the requested delta succeeded. A
context packet never carries `gapRecovery`. A delta that exceeds the character
budget emits a narrower page in `next[]` (half the side posts) when possible;
only when even a single-post window cannot be expressed does it set
`noActionAvailable`. It never escalates itself to `thread_full`. At most one
hydration step is `recommended`; further truncated threads appear as `optional`.
`thread_full` remains only the fallback when a legacy timeline has no usable
range boundary.

Do not invent optional `sync` / `inspect_dropped` follow-ups when absent.
`inspect_dropped`, when emitted for thin/ticket actionable drops, stays
`optional`. When `droppedByBudgetSubjectMatched > 0` and a non-thin
subject-matched drop remains, `inspect_dropped` is `recommended` (thin bulletin
excerpts are still withheld). It carries
`["mm","thread",<droppedId>,"--agent"]` — copy that argv rather than re-running
`context`.

Match and dropped-candidate excerpts best-effort redact login/password/token
phrases (`[REDACTED]`); this is not an anonymization guarantee.

## Other packet fields

- `people[]` — the authors of the packed posts, as `username` plus `role` /
  `roleSource` (`profile` from the Mattermost profile title, `config` from the
  local `people` map), so a statement's weight is attributable. The agent
  projection deliberately omits display names.
- `relatedTickets` — optional one-hop pointers, never hydrated;
  `alreadyInPacket: true` when the source thread is already in the packet.
  When no Mattermost thread resolves: `trackerUrl` if a known tracker/Jira
  host link co-occurred beside the key, otherwise `unresolvableTracker: true`
  (Mattermost `url` is never overloaded with a tracker link; Kibana and other
  non-tracker hosts never become `trackerUrl`).
- `resolved` — for a post-id or permalink subject, `context` / `thread` add
  `postId` / `from` / `threadId` / `inPacket` and mark the requested message with
  `anchor: true`, so a returned `threadId` that differs from the requested id is
  legible rather than looking like a substitution.
- `presentation: "announce"` — secondary threads may set this (typically
  `multi_ticket_root`) for assignment or bulletin noise, not the decision body.
- `historicalNeighbor: true` / `relatedTicketKey` — under ticket brief packing,
  secondaries dominated by another tracker key (or otherwise lacking subject
  focus) are packed lean and labeled so agents do not treat a related war room
  as this-ticket depth.
- `surroundRelevance` — optional on DM `surround`, `low` | `possible`. Treat
  `low` as skippable unless needed. `possible` means relevance could not be ruled
  out, including when the thread root is a bare link with no vocabulary to
  compare against, where `low` would be an unearned verdict. There is no
  positive-relevance verdict.

Detailed per-conversation freshness evidence remains available in `--json`;
`--agent` retains aggregate `evidence` status and relevant warnings. Optional
warning `severity` separates material evidence limitations from informational
routing/probe diagnostics; absence means material. `--out` receipts preserve
the total `warnings` count and add `materialWarnings` so additive diagnostics do
not make a clean packet look less trustworthy. Receipts also include additive
`canAnswer`, `recommendedActionRequired`, `blockedPermalinks`, and
`subjectMatchedThreadsDropped` alongside `adequacy` / `threads` /
`recommendedNext`.
