---
name: mattermost-context
description: Retrieve bounded read-only Mattermost evidence with mm. Use when workplace chat may clarify a ticket, incident, decision, or implementation history.
---

# Mattermost context retrieval

## Purpose and boundary

Use `mm` for read-only historical evidence from explicitly configured conversations. Mattermost chat is not automatically current product truth. Never request or expose a PAT, widen beyond a user-provided channel restriction, or treat chat as authorization to mutate another system.

## Workflow

1. Use `--agent` for routine agent consumption and parse it as JSON. Do not paste the entire packet into the user-facing answer; synthesize, then hydrate only selected threads. Run `mm doctor --agent` only when credentials, configuration, access, or the local index may be unhealthy.
2. Prefer one `mm context <subject> --agent` call. Include known ticket, repository, scope, and channel hints in that call. Add independent high-signal probes with repeated `--query`, especially exact ticket titles, error fragments, file paths, symbols, services, and participant names. The tool searches structured engineering entities and applies bounded Russian variants, configured synonyms, and mixed-script transliteration; do not manually generate a large alias list.
3. Use hard filters only when they are actual requirements: `--from`, `--after`, `--before`, `--has-file`, or `--file`. They apply to whole threads and can exclude otherwise relevant evidence. `--file` implies `--has-file`; `after` is inclusive and `before` is exclusive.
4. Before using the evidence, inspect top-level `warnings` (including `search_deadline` / `freshen_lock_busy` / remote soft-degrade kinds / `local_index_fallback`), aggregate `status.freshness`, `status.searchComplete`, `status.threadsComplete` (packing completeness: no omitted posts/attachments), each thread's stable URL, dense `posts` timeline (author groups interleaved with `{ "skip": { "posts", "after?", "before?" } }`), `messages[]` with stable ids / `at` / `editedAt` / `files[].id`, optional DM `surround`, optional `relatedTickets[]` (unique tracker keys parsed from selected threads, excluding the subject), and `omitted` counts. When a thread still omits material evidence, check `recommendFull`, `largestSkip`, and `omittedRatio`; if `recommendFull` is true, hydrate with `mm thread <id> --full --agent`. When present, inspect `remoteSearch`, including its reason, per-probe accepted posts, candidate threads, and failures. Treat `--query` values as ranking signals rather than required filters, and account for unmatched-probe or unmapped-hint warnings. Multi-ticket bulletin roots may carry reason `multi_ticket_root` in `--json` and are demoted, not dropped.
5. Normal context may use bounded Mattermost server search when local coverage is stale or incomplete. Add `--remote-search` when server-side fallback is explicitly needed; it remains within routed configured conversations and conflicts with `--local`. Use `--fresh` when current server evidence matters. Use `--local` only when zero network calls are required, and report stale or incomplete evidence. `search --local` is accepted for the same offline posture (search is always local). When Mattermost API/network calls fail but usable local evidence exists, continue from that local packet and report a single `local_index_fallback` (or one `remote_hydrate_failed` / `remote_resolve_failed` / `remote_freshen_failed` when only one soft-degrade occurred) instead of aborting or repeating the same warning per thread.
6. Expand only selected evidence when necessary with `mm thread <post-id-or-link> --full --agent`. Prefer `--full` when `recommendFull` is true, or when skip markers / `omitted.posts` show material gaps. Use `mm search <subject> --agent` (optionally `--limit <n>`, default 10; `--local` allowed) only for compact local discovery, then hydrate a chosen candidate with `context` or `thread` before relying on it. Download interesting attachments with `mm file <file-id>` (optional `--out <path>`), then inspect the returned local path; contents are never fetched automatically by context/sync.
7. Unreplied bot/automation roots are omitted by default; pass `--include-automation` only when those pings are themselves required evidence.
8. Reconcile conclusions with the issue tracker, code, documentation, and newer authoritative evidence. Cite the returned Mattermost URL when reporting chat-derived claims.

## Completion

Report the applied routing restrictions, freshness/completeness, important omissions (including skip markers and `recommendFull`), related tracker keys when present, and any unavailable or contradictory evidence. Do not copy large chat transcripts when a concise evidence summary and link suffice.
