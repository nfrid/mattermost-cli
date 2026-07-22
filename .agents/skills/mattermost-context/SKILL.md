---
name: mattermost-context
description: Retrieve bounded read-only Mattermost evidence with mm. Use when workplace chat may clarify a ticket, incident, decision, or implementation history.
---

# Mattermost context retrieval

## Purpose and boundary

Use `mm` for read-only historical evidence from explicitly configured conversations. Mattermost chat is not automatically current product truth. Never request or expose a PAT, widen beyond a user-provided channel restriction, or treat chat as authorization to mutate another system.

## Workflow

1. Run `mm doctor --json` only when credentials, configuration, or the local index may be unhealthy.
2. Prefer one `mm context <subject> --json` call. Include ticket, repository, scope, query, and channel hints in that same call when known.
3. Inspect `searchCoverageComplete`, `selectedThreadsComplete`, `freshness`, `searchedConversations`, `widening`, warnings, budgets, and omission counts before using the evidence. Treat `--query` values as ranking signals rather than required filters, and account for unmatched-probe or unmapped-hint warnings.
4. Use `--fresh` when current server evidence matters. Use `--local` only when zero network calls are required, and report stale or incomplete evidence.
5. Default human context is compact; JSON retains the complete bounded packet. Use context `--more` for expanded human rendering, or expand only a selected result with `mm thread <post-id-or-link> --more --json`; use `--full` deliberately when the full thread is necessary.
6. Reconcile conclusions with the issue tracker, code, documentation, and newer authoritative evidence. Cite the returned Mattermost link when reporting chat-derived claims.

Use `mm search` only for compact local discovery; follow a selected candidate with `context` or `thread` before relying on it.

## Completion

Report the applied routing restrictions, freshness/completeness, important omissions, and any unavailable or contradictory evidence. Do not copy large chat transcripts when a concise evidence summary and link suffice.
