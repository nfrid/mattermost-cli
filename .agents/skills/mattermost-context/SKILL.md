---
name: mattermost-context
description: Retrieve bounded read-only Mattermost evidence with mm. Use when workplace chat may clarify a ticket, incident, decision, or implementation history.
---

# Mattermost context retrieval

## Purpose and boundary

Use `mm` for read-only historical evidence from explicitly configured conversations. Mattermost chat is not automatically current product truth. Never request or expose a PAT, widen beyond a user-provided channel restriction, or treat chat as authorization to mutate another system.

## Workflow

1. Use `--agent` for routine agent consumption. Run `mm doctor --agent` only when credentials, configuration, or the local index may be unhealthy.
2. Prefer one `mm context <subject> --agent` call. Include ticket, repository, scope, query, and channel hints in that same call when known.
3. Before using the evidence, inspect top-level `warnings`, `status.freshness`, `status.searchComplete`, `status.threadsComplete`, any `evidenceIssues`, each thread's `why`, and its `omitted` counts. Treat `--query` values as ranking signals rather than required filters, and account for unmatched-probe or unmapped-hint warnings.
4. Use `--fresh` when current server evidence matters. Use `--local` only when zero network calls are required, and report stale or incomplete evidence.
5. Expand only selected evidence when necessary with `mm thread <post-id-or-link> --more --agent`; use `--full` deliberately when the complete selected thread is necessary. Use `mm search <subject> --agent` only for compact local discovery, then hydrate a chosen candidate with `context` or `thread` before relying on it.
6. Reconcile conclusions with the issue tracker, code, documentation, and newer authoritative evidence. Cite the returned Mattermost URL when reporting chat-derived claims.

Reserve `--json` for retrieval or contract diagnostics that specifically need the full internal packet, such as probes, routing internals, healthy per-conversation freshness, ranking vectors, or packing budgets. Use `--pretty` only to inspect that full diagnostic JSON visually. Do not choose either merely because the caller is an agent.

## Completion

Report the applied routing restrictions, freshness/completeness, important omissions, and any unavailable or contradictory evidence. Do not copy large chat transcripts when a concise evidence summary and link suffice.
