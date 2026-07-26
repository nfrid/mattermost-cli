---
name: mattermost-context
description: Retrieve bounded read-only Mattermost evidence with mm. Use when workplace chat may clarify a ticket, incident, decision, or implementation history.
---

# Mattermost context retrieval

## Boundary

`mm` reads history from explicitly configured conversations. It grants no edit, delivery, or external authority; chat is not automatically current product truth. Never print or persist a PAT. Keep every user-supplied `--channel` as a hard allowlist. If `mm` is missing from `PATH`, report the setup problem rather than installing it.

This repository is the package: the CLI entry is `src/cli/bin.ts` (bin name `mm`), and `bun --bun run check` validates local changes. Conversations are in Russian: write subjects and `--query` probes in Russian, keeping identifiers verbatim. When a contract described here changes, update this skill and the workspace copy in the same change.

## Fast path

1. `mm context <subject> --agent` — a ticket key, a permalink or post id, or free text when the work is not filed yet. One call with `--repository` / `--scope` / `--channel` hints and high-signal `--query` probes beats several narrow ones. Pass every Mattermost link in the ticket description as a repeatable `--permalink <url>` in that same call rather than running one `context` per link; `permalinks[]` then reports each as `resolved` / `duplicate` / `not_allowed` / `unresolved` / `invalid`, and a refused link never costs you the others.
2. Read `evidence.verdict` first — four booleans (`canAnswerFromSelectedEvidence`, `mayHaveMissedOtherThreads`, `selectedEvidenceMayBeStale`, `recommendedActionRequired`) derived from the axes below; drop to the axes when reporting *why*. One deliberate softening: `mayHaveMissedOtherThreads` ignores cutoff-bounded history on an otherwise trusted packet, since nearly every conversation is bounded — `completeness.indexHistory` still reports it. Execute only `priority: "recommended"` steps from `evidence.next`, copying `command` argv verbatim (never join into a shell string). At most one `thread_full` is ever recommended. An absent optional step is not an invitation to run it anyway.
3. Read each thread's `brief`. `decisions[]` inlines the decision text (`author` / `at` / `text`, plus `ackPostId` when acknowledged) — do not resolve `decisionPostIds` yourself, **unless** the entry carries `textTruncated: true`: the packet cut that text, and the cut tail is where a decision's conditions live. A trailing `…` without the flag is the author's own punctuation, not a loss. Read `decisions[].kind` before acting: only `approved_decision` is agreement or approval; `discussion_outcome` says a discussion happened, `implementation_intent` is one author's plan, and `proposal` is an option floated. Reporting an intent as a team decision is the single most expensive mistake here. A decision's `refinements[]` are later posts that narrow its scope ("нет, это только про координацию"): read them before sizing an implementation, or you will build wider than what was settled. `openQuestions[]` is the symmetric answer to "what is still hanging": `kind: "question"` is being asked, `kind: "follow_up"` is deferred work stated as a fact — do not answer a follow-up as if someone were waiting. `repliesAfter: 0` means nobody spoke after it *in this packet*, and `isThreadTail` means the thread stopped there; neither proves the question is still open. `outcomeWindow` is tail-anchored and its `precedingInWindow` posts are still in the packet, so it is never an omission count. `purposeHints` (`announce` | `decision` | `open_question` | `debugging` | `status` | `noise`) picks what to read. `role: "primary"` is substance, `rank` is retrieval order; they need not agree and neither promises the go-ahead.
4. Check `attachments[]` before concluding from text alone. `mediaOnly: true` means the post has no text — the file *is* the message and may contradict surrounding text. A `read_attachments` step with `reason: "data_file_on_decision_post"` points at a spreadsheet or log hanging off a decision or open question: the post has text, but the numbers it claims live only in the file. `inPacket: false`, or a `skip` marker with `files`, means images sit outside the returned posts. Copy `downloadCommand` argv, or `mm files --post|--thread --out-dir` for batches; `omitted.unreportedAttachments` means the index itself is short. Never invent OCR or captions.
5. `people[]` names the authors of the packed posts with the role Mattermost knows (`roleSource: "profile"`, or `"config"` from a local override). Weigh a statement by who made it — a product manager's "можно делать" is not an engineer's — and say when the role is unknown rather than guessing it. `mm people [--channel …]` lists the roster with message counts.
6. `relatedTickets` with `alreadyInPacket: true` needs no second `context`.

## What the packet admits

Each field below is deliberately separate — report them, do not infer one from another.

- `completeness.selectedThreads` = posts inside the selected threads (`not_applicable` when no thread was selected at all). `completeness.selection` = the candidate set: `budget_bounded` means ranked candidates were never examined, so the packet cannot speak for them (an `optional` `review_candidates` step lists them via `mm search`). Judge it by `selection.droppedByBudgetSubjectMatched`, not by `droppedByBudget`: zero means the unexamined candidates were the weak lexical tail.
- `messageCount` is what this packet returned; `totalPosts` is what the thread holds and what `mm thread --full` would return. Their difference is `omitted.posts` — not an inconsistency.
- `selection.droppedNoMatch` was judged and rejected; with an empty `droppedCandidates` that is ranking noise, not withheld evidence. `dropReason: "unavailable"` + `candidate_hydrate_failed` means a thread was never retrievable, so never judged. `hydration_budget` means later candidates came from the index only.
- `currency` (selected threads) is separate from `completeness.discovery` (search reach). `indexHistory: cutoff_bounded` can coexist with usable threads: compare `evidence.history.cutoffBounded[].oldestIndexedAt` with the thread's `latestAt` instead of reacting to the warning text.
- `latestAt` says when a thread stopped; `tail` says it stopped on a question or an error. Absent `tail` is not evidence of resolution — `tail` and `brief.openQuestions[].isThreadTail` are both withheld on a truncated packet, which cannot know how the thread ended.
- `threads[]` is in retrieval order, which is **not** chronological: with several threads, use `--timeline` before concluding anything about sequence ("we shipped it" can otherwise appear after the report that it broke). Prose output reads `role: "primary"` first and tags each thread with its `rank`; the JSON order never changes.
- On API/network failure with usable local evidence the command continues with one soft-degrade warning (`local_index_fallback`, `remote_*_failed`). Report it once; do not retry per thread.
- With `--brief`, the envelope says `projection: "brief"` and withheld posts appear as `{ "skip": { "reason": "brief_projection" } }`; shown messages plus those skips equal `messageCount`.

## Output shapes

- Threads are the top-level `threads[]` — no `packet` wrapper, no singular `thread`.
- `posts[]` is a timeline of `{ author, messages }` blocks and `{ skip }` markers. `posts.length` counts blocks; `messageCount` counts messages.
- Empty fields are omitted, not `null` (`nearestTicketDistance` is the only literal null).
- `anchors[]` is one entry per post listing every role it plays in `kinds[]`.
- `surroundRelevance` is `low` | `possible`; `possible` only means relevance could not be ruled *out*.
- A post subject adds `resolved` and marks its message `anchor: true`; a `threadId` differing from the requested id is normal.
- A `conversation_not_allowed` error carries `details`: `reason` (`not_configured` | `channel_restriction`), the `postId` / `conversationId` involved, `restrictedTo` when your own `--channel` excluded it, and a `recommendedAction`. Act on that — never try to route around the allowlist.
- `source: "config"` / `"routing"` errors are allowlist or routing limits. `source: "mattermost"` (`thread_not_found`, `post_not_found`, `thread_boundary_mismatch`) is inconsistent server data — never report it as a routing restriction.

## Flags

| Need | Use |
| --- | --- |
| Decision layer only, fewest tokens | `--brief` |
| What happened in what order across threads | `--timeline` (merged chronology; combines with `--brief`) |
| Who a username is | `people[]` in the packet, or `mm people` |
| Navigate a large thread | `--navigate` (`anchors` / `clusters` / `skips`) |
| Several links from a ticket description | `--permalink <url>` (repeatable; one packet, `permalinks[]` reports each) |
| Keep a large packet out of context | `--out <path>` (prints a receipt: `out` / `bytes` / `adequacy` / `threads` / `warnings` / `recommendedNext`) |
| Read as prose | no `--agent` — the transcript is usually *smaller* than the JSON; never hand-write a renderer |
| Discovery before hydrating | `mm search … --agent` |
| Freshness | `--fresh`, `--local`, `--remote-search` |

Hard filters (`--from`, `--after`, `--before`, `--has-file`, `--file`) exclude whole threads. `--include-automation` only when unreplied bot roots are the evidence. `--short` is legacy — prefer `--brief`. Avoid broad `sync`; `mm doctor --agent` only when credentials, access, or index health looks broken.

A ticket subject routes **only** to conversations already linked to that ticket. Adding `--query` there emits `background[]` — unhydrated pointers from the other conversations for "why does this task exist at all". Hydrate at most the one whose excerpt earns it. `probeCoverage[]` says what each probe actually did: `matched_selected`, `background_only` (it found nothing in the selected threads but is why a `background[]` pointer exists — not a defect), or `no_match`, which is the only status that also raises `unmatched_retrieval_probe`. Probes are ranking input, so they also change which threads get **selected**: a packet with `--query` is not a superset of the same subject without it. Pick one call and report the probes you used.

`context` reconciles over the network by default; `search` never leaves the local index and warns with `stale_local_index` when that index is behind. Two commands, two freshness stories — do not treat differing candidate sets as a contradiction.

## Completion

Report routing restrictions, `adequacy` / `currency` / both completeness axes, recommended steps taken, packing omissions, material related or background pointers, and anything unavailable or contradictory. Summarize with permalinks instead of pasting transcripts, and reconcile chat against Tracker, code, docs, and newer sources.

Mechanics and the full projection reference: [`README.md`](../../../README.md).
