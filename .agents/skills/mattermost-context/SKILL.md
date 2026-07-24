---
name: mattermost-context
description: Retrieve bounded read-only Mattermost evidence with mm. Use when workplace chat may clarify a ticket, incident, decision, or implementation history.
---

# Mattermost context retrieval

## Purpose and boundary

Use `mm` for read-only historical evidence from explicitly configured conversations. Mattermost chat is not automatically current product truth. Never request or expose a PAT, widen beyond a user-provided channel restriction, or treat chat as authorization to mutate another system.

The package lives in this repository (`mattermost-cli`); the CLI entry is `src/cli/bin.ts` (bin name `mm`). Prefer `bun --bun run check` when validating local changes on Apple Silicon.

## Fast path

1. Run `mm context <ticket> --agent`. Default `--agent` is the decision packet; do not open with `--navigate` or `--short` just to save tokens.
2. Read `evidence` first. Execute only `priority: "recommended"` steps from `evidence.next` (copy `command` argv; never auto-exec or join into a shell string).
3. Do not invent optional sync/inspect follow-ups. If `sync` or `inspect_dropped` is absent from `next`, ignore that noise — do not run them “just in case.”
4. Read each thread’s lean `brief` (when present). Prefer primary, then secondaries using `purposeHints` (`announce` | `decision` | `debugging` | `status` | `noise`). Skip `presentation: "announce"` and `surroundRelevance: "low"` unless you specifically need that bulletin or surround. `role=primary` is strongest match, not necessarily the product go-ahead — use `brief` to find decision/status threads.
5. If `filesPresent` or message `files[]` is set, download and Read attachments **before** UI/screenshot-dependent claims. Prefer `files[].downloadCommand` + `--agent`, or `mm files --post|--thread|--out-dir` for batches. Never invent OCR/captions.
6. For `relatedTickets` with `alreadyInPacket: true`, do not re-run `mm context` — the excerpt is already in the packet. Separate `context <key>` only when a neighbor without that flag looks material.

Normalize shapes with `const threads = packet.threads ?? (packet.thread ? [packet.thread] : [])`. Default `--agent` omits full `signals` / `technicalEntities`; pass `--signals` only when you need them. `brief` may still appear alongside `--signals`.

## Completion

Report routing restrictions, `evidence.adequacy` / `currency` / recommended `next` (priority + impact + argv), packing omissions (`recommendFull` / skips), related pointers when material, and unavailable or contradictory evidence. Do not paste large transcripts when a concise summary and permalink suffice. Reconcile chat claims with the tracker, code, docs, and newer authoritative sources.

## Appendix: soft degrade, probes, navigation

- **Trust fields:** Treat `completeness.discovery` separately from selected-thread `currency`. `indexHistory: cutoff_bounded` can coexist with usable selected threads. On API/network failure with usable local evidence, continue and report one soft-degrade warning (`local_index_fallback` / `remote_*_failed`) — do not abort or retry the same warning per thread.
- **Recommended recovery:** Material skip + `recommendFull` → only `mm thread <id> --full --agent` (or the matching `next.command`). Do not retry a truncated default packet with `--navigate` / `--short`.
- **Optional `next`:** Act only when present and you need them. `inspect_dropped` argv is `mm thread <id> --agent` (not another `context`); at most one dropped candidate when excerpts add a missing symptom. `sync` is older-discovery-only when emitted; `fresh_or_remote` may refresh when subject is known. `thread_around` remains a schema action but is not emitted in current `evidence.next`.
- **Probes / filters:** Prefer one `context` with ticket/repo/scope/channel hints; add high-signal `--query` probes (titles, errors, paths, symbols). Hard filters (`--from`, `--after`, `--before`, `--has-file`, `--file`) exclude whole threads. `--fresh` / `--remote-search` / `--local` as needed; `search --agent` only for compact local discovery before hydrating.
- **Modes:** `--navigate` = lean anchors/clusters/skips (no dense `posts` / top-level `messages`). `--short` = legacy card+timeline. They conflict. `--include-automation` only when unreplied bot roots are required evidence.
- **Packing notes:** Primary contiguous-core may omit an off-window root while keeping the subject-ticket decision span — not a packing failure by itself. Low `ticketDensity` means messages before a non-root ticket mention are not automatically ticket evidence. `remoteSearch.returnedPosts: 0` does not invalidate local FTS or structured ticket links.
