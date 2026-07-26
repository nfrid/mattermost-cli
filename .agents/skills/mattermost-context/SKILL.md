---
name: mattermost-context
description: Retrieve bounded read-only Mattermost evidence with mm. Use when workplace chat may clarify a ticket, incident, decision, or implementation history.
---

# Mattermost context retrieval

## Boundary

`mm` reads history from explicitly configured conversations. It grants no edit, delivery, or external authority, and chat is not automatically current product truth. Never print or persist a PAT. Treat every user-supplied `--channel` as a hard allowlist and never route around a refusal. If `mm` is missing from `PATH`, report the setup problem rather than installing it.

Match subjects and `--query` probes to the language used by the evidence; English and Russian are supported, and identifiers stay verbatim. When you change a contract described here, update this skill and the workspace copy in the same change.

## Fast path

1. **One call.** `mm context <subject> --agent` takes a ticket key, a permalink or post id, or free text. Add `--repository` / `--scope` / `--channel` hints and high-signal `--query` probes, and pass every Mattermost link from the ticket as a repeatable `--permalink <url>` — one packet beats one call per link. `permalinks[]` reports each as `resolved` / `duplicate` / `not_allowed` / `unresolved` / `invalid`, a refused link never costs you the others, and `packed: false` means a resolved link is still not evidence you read.
2. **`evidence.verdict` decides.** `canAnswerFromSelectedEvidence`, `mayHaveMissedOtherThreads`, `selectedEvidenceMayBeStale`, `recommendedActionRequired` — act on these, then drop to `adequacy` / `currency` / `completeness.*` to say *why*. Run only `priority: "recommended"` steps from `evidence.next`, copying `command` argv verbatim (never join into a shell string). An absent optional step is not an invitation to run it.
3. **`brief.decisions[]`** inlines the decision text, strongest first, and `kind` bounds what you may claim: only `approved_decision` is agreement or approval; `discussion_outcome` says a discussion happened, `implementation_intent` is one author's plan, `proposal` is an option floated. Reporting an intent as a team decision is the most expensive mistake here. `refinements[]` are later posts narrowing the scope that was settled — read them before sizing work. `acknowledgement` is a later different-author response supporting attribution, not independent approval of wider scope. `textTruncated: true` means the packet cut the text and the cut tail is where a decision's conditions live, so read that post; a trailing `…` without the flag is the author's own punctuation.
4. **`brief.openQuestions[]`** — `kind: "question"` is being asked; `kind: "follow_up"` is deferred work stated as a fact. Use `resolution`: `possibly_answered` is only a pointer to inspect `responsePostIds`, not a verified answer; `repliesAfter` and `isThreadTail` remain packet position, never proof that a question is open.
5. **Check `attachments[]` before concluding from text.** `mediaOnly: true` means the file *is* the message. A `read_attachments` step with `reason: "data_file_on_decision_post"` points at numbers text only gestures at. Use `inspectCommand` when file content is evidence; `downloadCommand` only downloads for an external reader. Inspection is bounded and CSV/TSV redaction is best effort, never guaranteed anonymization. XLSX/images remain explicitly `not_interpreted`; never invent OCR, captions, or workbook contents.
6. **`people[]`** gives each author the role Mattermost knows. Weigh a statement by who made it — a product manager's «можно делать» is not an engineer's — and say when a role is unknown instead of guessing. `relatedTickets` with `alreadyInPacket: true` needs no second call.

## Reading the packet

Report these; never infer one from another.

- `completeness.selectedThreads` covers posts *inside* the selected threads; `completeness.selection` covers the candidate set. `budget_bounded` on its own is bookkeeping — judge it by `selection.droppedByBudgetSubjectMatched`, where zero means the unexamined candidates were the weak lexical tail.
- `currency` (selected threads) is separate from `completeness.discovery` (search reach). `indexHistory: cutoff_bounded` coexists with usable threads: compare `evidence.history.cutoffBounded[].oldestIndexedAt` against the thread's `latestAt` rather than reacting to the warning text.
- `messageCount` is what this packet returned; `totalPosts` is what the thread holds. The difference is `omitted.posts`, not an inconsistency. A recommended `thread_around` now carries `--window-only`: for its response use `evidence.scope: "gap_recovery"` and `gapRecovery.requestedRangeComplete`, not the packet-local general answerability verdict. `noActionAvailable` means retry manually with a narrower window, never escalate to `--full`.
- `threads[]` is retrieval order, **not** chronological. With several threads run `--timeline` before claiming any sequence — a rollout note otherwise reads as following the report that it broke.
- Absent `tail` is not evidence of resolution: `tail` and `isThreadTail` are both withheld on a truncated packet, which cannot know how a thread ended.
- `--brief` marks the envelope `projection: "brief"` and collapses withheld posts into `brief_projection` skips; shown messages plus skips equal `messageCount`.
- A single soft-degrade warning (`local_index_fallback`, `remote_*_failed`) means the command continued on local evidence. Report it once; do not retry per thread.
- A post subject adds `resolved` and marks its message `anchor: true`; a `threadId` differing from the requested id is normal. `surroundRelevance: "possible"` only means relevance could not be ruled *out*.
- `conversation_not_allowed` carries `details` — `reason` (`not_configured` | `channel_restriction`), `restrictedTo`, and a `recommendedAction`. Act on that. `source: "mattermost"` (`thread_not_found`, `post_not_found`, `thread_boundary_mismatch`) is inconsistent server data, never a routing restriction.

## Flags

| Need | Use |
| --- | --- |
| Decision layer only, fewest tokens | `--brief` |
| What happened in what order across threads | `--timeline` (merged chronology; combines with `--brief`) |
| Several links from a ticket description | `--permalink <url>`, repeatable |
| Navigate a large thread | `--navigate` (`anchors` / `clusters` / `skips`; each anchor lists every role a post plays) |
| Who a username is | `people[]`, or `mm people` |
| Keep a large packet out of context | `--out <path>` (receipt: `bytes` / `adequacy` / `threads` / `warnings` / `recommendedNext`) |
| Read as prose | no `--agent` — the transcript is usually *smaller* than the JSON; never hand-write a renderer |
| Discovery before hydrating | `mm search … --agent` |
| Freshness | `--fresh`, `--local`, `--remote-search` |

Hard filters (`--from`, `--after`, `--before`, `--has-file`, `--file`) exclude whole threads. `--include-automation` only when unreplied bot roots are the evidence. `--short` is legacy — prefer `--brief`. Avoid broad `sync`; run `mm doctor --agent` only when credentials, access, or index health looks broken.

A ticket subject routes **only** to conversations already linked to that ticket. Adding `--query` there emits `background[]` — unhydrated pointers from the other conversations, for "why does this task exist at all". Hydrate at most the one whose excerpt earns it. `probeCoverage[]` says what each strict all-term probe did: `matched_selected`, `background_only`, or `no_match`. A no-match may still carry `matchedTerms` / `missingTerms` / `partialEvidencePostIds`; that is lexical overlap in selected evidence, never semantic equivalence or a background match. `unmatched_retrieval_probe` and unmapped hints are `severity: "informational"`; absence of severity means material. Probes are ranking input, so a packet with `--query` is not a superset of one without it.

`context` reconciles over the network by default; `search` never leaves the local index and warns `stale_local_index` when it is behind. Differing candidate sets between the two are not a contradiction.

## Completion

Report routing restrictions, the verdict and the axes behind it, recommended steps taken, packing omissions, material related or background pointers, and anything unavailable or contradictory. Summarize with permalinks instead of pasting transcripts, and reconcile chat against Tracker, code, docs, and newer sources.

Mechanics and the full projection reference: [`docs/agent-output.md`](../../../docs/agent-output.md), with retrieval behavior in [`docs/retrieval.md`](../../../docs/retrieval.md) and the envelope in [`docs/json-contract.md`](../../../docs/json-contract.md).
