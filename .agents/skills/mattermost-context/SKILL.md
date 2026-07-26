---
name: mattermost-context
description: Retrieve bounded read-only Mattermost evidence with mm. Use when workplace chat may clarify a ticket, incident, decision, or implementation history.
---

# Mattermost context retrieval

## Boundary

`mm` reads history from explicitly configured conversations. No edit, delivery, or external authority. Never print or persist a PAT. Treat `--channel` as a hard allowlist. If `mm` is missing from `PATH`, report the setup problem rather than installing it. Match subjects/`--query` to the evidence language (EN/RU); identifiers stay verbatim.

For work outside this repo, prefer the workspace copy under `job/.agents/skills/mattermost-context` (authority + reading guide). Keep both copies' procedure in sync when changing agent UX.

## Procedure

1. **One call.** Prefer `bun run src/cli/bin.ts` (or `mm` on `PATH`). `mm context KEY --agent` (ticket → brief default + top-level `brief`). Add `--repository` / `--scope` / `--channel` and high-signal `--query` probes. Pass every Tracker Mattermost link as repeatable `--permalink <url>`. Use `--follow-recommended` to run `priority: "recommended"` next steps once and get one merged packet + `followLog[]` (always present when the flag ran; empty `[]` means noop / optional-only — check `followExhausted`). Follow runs gap recovery, inspect_dropped, attachment inspect/OCR, and a subject-matched `review_candidates` `--max-threads` bump; it **skips** broad `sync` and optional `fresh_or_remote`. External-reader / failed OCR inspects are **skipped and remaining steps continue** — no sync, no session store. `--full-posts` keeps dense posts **and** top-level brief for tickets; `--timeline` for cross-thread order; `--navigate` for lean anchors (ticket `--agent` still keeps top-level brief). Raise `--max-threads` when `droppedByBudgetSubjectMatched > 0` or when `evidence.next` recommends a context re-run with a higher cap (default remains config `3`) — or just pass `--follow-recommended` so the bump runs once.
2. **Read `hints.readOrder`, then `evidence.verdict`.** Act on `canAnswerFromSelectedEvidence` / `mayHaveMissedOtherThreads` (+ `mayHaveMissedReason`) / `selectedEvidenceMayBeStale` / `recommendedActionRequired`. A true uncovered flag with no covering `next` sets `noActionAvailable` — but never together with `recommendedActionRequired` (run recommended first). Copy `command` argv verbatim; run only `recommended` unless you chose optional on purpose. Pending media-only / decision-adjacent image outcomes keep `canAnswerFromSelectedEvidence: false` until inspect/follow yields `preview` or `text_extracted`. `timelineComplete: false` means brief/packing omitted chronology. `--agent` also prints a one-line **stderr** summary (`canAnswer` / `mayMiss=…` / `noActionAvailable` / `recommended=N`).
3. **Orient with `researchSummary.primaryThreadId`** — agent `threads[].role` is aligned to that id; `rank` stays retrieval order. `researchSummary` is a thin roll-up, never a narrative substitute.
4. **`brief.decisions[]`** — only `approved_decision` is team settlement; `discussion_outcome` / `implementation_intent` / `proposal` are weaker (architectural approach cues are always `proposal`). **`canAnswer: true` with only `implementation_intent` / soft ack is not settlement** — say what kind you have. Read `refinements[]`, `supportingPostIds` / `supportingExcerpt` for short cues, `offlineOrVoiceApproval` (soft — not an upgrade), and `brief.lateAcknowledgement` / `threads[].brief.lateAcknowledgement` (late-thread ack, lower confidence — not adjacency). `textTruncated: true` → read the post. Top-level `openQuestions[]` keeps every unresolved item and may add `possibly_answered` fillers up to the merge cap; only the unresolved count aligns with `researchSummary.unresolvedOpenQuestions`. `responseExcerpts` are pointers, not verified answers.
5. **Attachments.** `mediaOnly: true` means the file *is* the message. Images on decision/question posts (even with caption text) and media-only outcome images stay `recommended` until OCR/preview succeeds; legacy `.xls`/`.ods` stay `optional`. `.xlsx` can preview via `--inspect` (including large OOXML members) but quantities stay unverified. On macOS, Vision OCR runs when `MATTERMOST_OCR_MODULE` is unset (disable with `MATTERMOST_OCR_DISABLE_MACOS=1`); treat `text_extracted` as low trust. After `--follow-recommended`, read `threads[].attachments[].inspection` / `followedAttachments[].inspection` — do not re-fetch blindly. Use `inspectCommand` when text/workbook preview is evidence. **`mm file --inspect --agent --out ….json` is rejected** — `--out` writes binary bytes; metadata stays on stdout.
6. **`people[]`** for author weight. Nested `messages[].author` matches the group author — never invent `@None`. `relatedTickets` with `alreadyInPacket: true` needs no hop; `unresolvableTracker: true` is not a Mattermost hop (use `trackerUrl` when present).

## Pitfalls

- **`stale_discovery`:** selected threads can look current while discovery is stale. Prefer the optional `fresh_or_remote` argv (`mm context KEY --fresh --agent`) yourself — follow will not run it. Empty `next` + `noActionAvailable` for this reason alone is a bug; the packet should always offer `--fresh` when discovery is `possibly_stale`.
- **`--follow-recommended` ≠ every suggested lever:** it runs recommended steps (including `--max-threads` bump). Optional freshness / sync stay manual. Empty `followLog[]` with `followExhausted` often means only optional steps remained.
- **`--query` probes are not supersets:** probed packets can demote secondaries; subject/permalink threads are pinned, but order still shifts. Prefer a clean ticket call first; add probes only when needed.
- **`mm thread --around <id>` is wrong:** `--around` needs `<target>` first — `mm thread <thread-or-post-id> --around <post-id> …`. Gap-recovery argv from `next[]` already has the correct shape; copy it verbatim. An `--around` post missing from the thread errors instead of returning 0 posts.
- **`historicalNeighbor: true`:** secondary / related-ticket packing, not “this is the primary decision thread”.
- **Brief skips:** large `brief_projection` skips hide the decision path — use `--full-posts` when you need dense posts with the brief still present.

## Flags (short)

| Need | Flag |
| --- | --- |
| Ticket research | `mm context KEY --agent` |
| Auto-run recommended next | `--follow-recommended` |
| More thread slots | `--max-threads <n>` (default 3) |
| Dense posts + ticket brief | `--full-posts` |
| Cross-thread order | `--timeline` |
| Lean navigation | `--navigate` |
| Large packet off-chat | `--out <path>` |
| Discovery only | `mm search … --agent` |

Hard filters (`--from` / `--after` / `--before` / `--has-file` / `--file`) drop whole threads. Avoid broad `sync`. Non-ticket `--query` may emit `probe_reranked_packet` — **probed packets are not supersets** of unprobed ones (subject/permalink threads are pinned, but ranking still shifts). A truncated Russian stem hint is informational; full forms like «месяц» are not flagged. Prefer `--fresh` when `selectedEvidenceMayBeStale` / `stale_discovery` is lit and optional freshness is the only remaining lever (follow will not run optional-only steps).

## Completion

Report routing restrictions, verdict (+ axes), recommended steps taken / `followLog` / `followExhausted`, packing omissions (`timelineComplete`), material related/background pointers, and anything unavailable. Prefer permalinks over pasting transcripts; reconcile chat against Tracker, code, and docs.

Reference: [`docs/agent-output.md`](../../../docs/agent-output.md), [`docs/retrieval.md`](../../../docs/retrieval.md), [`docs/json-contract.md`](../../../docs/json-contract.md).
