---
name: mattermost-context
description: Retrieve bounded read-only Mattermost evidence with mm. Use when workplace chat may clarify a ticket, incident, decision, or implementation history.
---

# Mattermost context retrieval

## Purpose and boundary

Use `mm` for read-only historical evidence from explicitly configured conversations. Mattermost chat is not automatically current product truth. Never request or expose a PAT, widen beyond a user-provided channel restriction, or treat chat as authorization to mutate another system.

The package lives in this repository (`mattermost-cli`); the CLI entry is `src/cli/bin.ts` (bin name `mm`). Prefer `bun --bun run check` when validating local changes on Apple Silicon.

## Fast path

1. Run `mm context <ticket> --agent`. Default `--agent` is the decision packet; do not open with `--navigate` or `--short` just to save tokens. **When you only need to read the conversation, drop `--agent`:** the no-flag default is a rendered text transcript (header, `Why`, counters, `Decision candidates`, then `[timestamp] @author: text`) and is usually *smaller* than the JSON — never hand-write a jq/python renderer for that.
2. Read `evidence` first. Execute only `priority: "recommended"` steps from `evidence.next` (copy `command` argv; never auto-exec or join into a shell string). At most one `thread_full` is ever `recommended`; other truncated threads arrive as `optional`.
3. Do not invent optional sync/inspect follow-ups. If `sync` or `inspect_dropped` is absent from `next`, ignore that noise — do not run them “just in case.”
4. Read each thread’s lean `brief` (when present). Prefer primary, then secondaries using `purposeHints` (`announce` | `decision` | `open_question` | `debugging` | `status` | `noise`). `brief.decisions[]` inlines the decision text (`id` / `author` / `at` / `text`, plus `ackPostId` when someone acknowledged it) — read it instead of resolving `decisionPostIds` against the timeline. `outcomeWindow` is tail-anchored: its `postIds` are the last posts after the ticket mention, and `precedingInWindow` counts eligible posts *ahead of that tail slice* — they are still in the packet, so it is never an omission count. Skip `presentation: "announce"` and `surroundRelevance: "low"` unless you specifically need that bulletin or surround. `role=primary` is strongest match, not necessarily the product go-ahead — use `brief` to find decision/status threads. `rank` is retrieval order and does not track `role`.
5. Check `attachments[]` before concluding from text alone. `mediaOnly: true` (on a message or an attachment entry) means the post has **no text at all** — the file is the whole message, and it can contradict the surrounding text. An entry with `inPacket: false`, or a `skip` marker carrying `files`, means images sit outside the returned posts. A `read_attachments` step in `evidence.next` is `recommended` when such a post lands after the last ticket mention — treat it like `thread_full`, not like noise. Download and Read before UI/screenshot-dependent claims: copy `downloadCommand` argv as-is (it already contains `--agent`), or use `mm files --post|--thread --out-dir` for batches. `omitted.unreportedAttachments` means even the index is incomplete — reach for `mm files --thread` there. Never invent OCR/captions.
6. For `relatedTickets` with `alreadyInPacket: true`, do not re-run `mm context` — the excerpt is already in the packet. Separate `context <key>` only when a neighbor without that flag looks material.

## Reading the JSON

- Threads are always the top-level `threads[]` array — there is no `packet` object and no singular `thread` key.
- `threads[].posts[]` is a **timeline**, not a message list. Each entry is either an author block `{ author, messages: [...] }` or a skip marker `{ skip: { posts, after, before, reason, files? } }`. Iterate both shapes; `posts.length` counts blocks, `messageCount` counts messages.
- **Empty fields are omitted, not `null`.** A missing `relatedTickets`, `skips`, `role`, or `brief` means "none", and `jq`/`.get()` will show it as `null`. There are no literal nulls in `--agent` output except `nearestTicketDistance`.
- Default `--agent` omits full `signals` / `technicalEntities`; pass `--signals` only when you need them. `brief` may still appear alongside `--signals`.
- For a post id or permalink subject, `resolved` reconciles the request: `{ postId, from: "permalink" | "id", threadId, inPacket }`, and the message itself carries `anchor: true`. `threadId` differing from the requested id is normal — it is the thread the post lives in. An unresolvable or out-of-allowlist post always fails loudly (`post_not_found` / `conversation_not_allowed`); there is no silent text-search fallback.

## Completion

Report routing restrictions, `evidence.adequacy` / `currency` / recommended `next` (priority + impact + argv), packing omissions (`recommendFull` / skips), related pointers when material, and unavailable or contradictory evidence. Do not paste large transcripts when a concise summary and permalink suffice. Reconcile chat claims with the tracker, code, docs, and newer authoritative sources.

## Appendix: soft degrade, probes, navigation

- **Trust fields:** Treat `completeness.discovery` separately from selected-thread `currency`. `indexHistory: cutoff_bounded` can coexist with usable selected threads; `evidence.history.cutoffBounded[]` names each affected conversation with `oldestIndexedAt` and `inSelectedThreads` — compare that date with the thread’s `latestAt` and judge, rather than syncing on the warning text alone. `latestAt` says when a thread stopped, and `tail` (untruncated threads only) says whether it stopped on a question or an error rather than on an outcome — absent `tail` is not evidence of resolution. On API/network failure with usable local evidence, continue and report one soft-degrade warning (`local_index_fallback` / `remote_*_failed`) — do not abort or retry the same warning per thread.
- **Recommended recovery:** Material skip + `recommendFull` → only `mm thread <id> --full --agent` (or the matching `next.command`). Do not retry a truncated default packet with `--navigate` / `--short`.
- **Optional `next`:** Act only when present and you need them. `inspect_dropped` argv is `mm thread <id> --agent` (not another `context`); at most one dropped candidate when excerpts add a missing symptom. `sync` is older-discovery-only when emitted; `fresh_or_remote` may refresh when subject is known. `thread_around` remains a schema action but is not emitted in current `evidence.next`.
- **Probes / filters:** Prefer one `context` with ticket/repo/scope/channel hints; add high-signal `--query` probes (titles, errors, paths, symbols). Hard filters (`--from`, `--after`, `--before`, `--has-file`, `--file`) exclude whole threads. `--fresh` / `--remote-search` / `--local` as needed.
- **`background[]` — the discussion that predates the ticket:** a ticket subject routes **only** to conversations already linked to that ticket, so `--query` probes alone cannot reach a design thread in another channel. Passing `--query` with a ticket subject adds `background[]`: pointers (`threadId` / `conversation` / `latestAt` / `matchedProbes` / `excerpts` / `command`) from the remaining configured conversations, never hydrated and never part of selection — the packet is identical with or without them. Use it for “why does this task exist at all”, and hydrate at most the one pointer whose excerpt earns it.
- **`search --agent`:** compact local discovery before hydrating. Candidates carry `rank` (1-based; the order *is* the ranking), `reasons[]`, and up to `--excerpts <n>` excerpts (default 3, remainder counted in `omittedExcerpts`). `selection.droppedNoMatch` in a context packet counts candidates that ranked but carried no content match once hydrated — with an empty `droppedCandidates` that means ranking noise, not withheld evidence.
- **Modes:** `--navigate` = lean anchors/clusters/skips (no dense `posts` / top-level `messages`). `--short` = legacy card+timeline. They conflict. `--include-automation` only when unreplied bot roots are required evidence.
- **Packing notes:** Primary contiguous-core may omit an off-window root while keeping the subject-ticket decision span — not a packing failure by itself. Low `ticketDensity` means messages before a non-root ticket mention are not automatically ticket evidence. `remoteSearch.returnedPosts: 0` does not invalidate local FTS or structured ticket links.
