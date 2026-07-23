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
4. Before using the evidence, inspect top-level `warnings` (including `search_deadline` / `freshen_lock_busy`), aggregate `status.freshness`, `status.searchComplete`, `status.threadsComplete`, each thread's `why`, grouped `posts` (`messages[]` with stable ids), optional DM `surround`, and `omitted` counts. When present, inspect `remoteSearch`, including its reason, per-probe accepted posts, candidate threads, and failures. Treat `--query` values as ranking signals rather than required filters, and account for unmatched-probe or unmapped-hint warnings.
5. Normal context may use bounded Mattermost server search when local coverage is stale or incomplete. Add `--remote-search` when server-side fallback is explicitly needed; it remains within routed configured conversations and conflicts with `--local`. Use `--fresh` when current server evidence matters. Use `--local` only when zero network calls are required, and report stale or incomplete evidence.
6. Expand only selected evidence when necessary with `mm thread <post-id-or-link> --more --agent`; use `--full` deliberately when the complete selected thread is necessary. Use `mm search <subject> --agent` only for compact local discovery, then hydrate a chosen candidate with `context` or `thread` before relying on it.
7. Unreplied bot/automation roots are omitted by default; pass `--include-automation` only when those pings are themselves required evidence.
8. Reconcile conclusions with the issue tracker, code, documentation, and newer authoritative evidence. Cite the returned Mattermost URL when reporting chat-derived claims.

Reserve `--json` for retrieval or contract diagnostics that specifically need the full internal packet, such as probes and expansions, structured matches, routing internals, per-conversation freshness, lexical or rank-fusion evidence, remote-search diagnostics, packing budgets, or surround posts. Use `--pretty` only to inspect that full diagnostic JSON visually. Do not choose either merely because the caller is an agent.

## Completion

Report the applied routing restrictions, freshness/completeness, important omissions, and any unavailable or contradictory evidence. Do not copy large chat transcripts when a concise evidence summary and link suffice.
