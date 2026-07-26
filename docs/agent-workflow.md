# Recommended retrieval workflow

1. Run `doctor` when local health or credentials are uncertain.

2. Prefer one constrained `context … --agent` call with ticket, repository,
   scope, and channel hints. Do not open with `--navigate` just to save tokens.

3. Read `evidence` first, and execute only `priority: "recommended"` entries
   from `next`. Do not invent optional sync or inspect follow-ups when absent.
   Use top-level `brief` under the ticket `--agent` brief default or explicit
   `--brief`, or `threads[].brief` on the primary thread and then the
   secondaries — `decisions[]` carries the decision text inline, so resolving
   ids against the timeline is rarely needed. Skip `presentation: "announce"`
   and `surroundRelevance: "low"` unless needed. Pass `--full-posts` when a
   ticket packet needs the dense transcript.

4. For an incomplete selected thread, copy the provided bounded
   `thread --around … --agent` argv. Use `thread --full --agent` only as an
   explicit last resort when no range command is available; for
   `inspect_dropped`, copy the provided `thread … --agent` argv.

   Consult `attachments[]` before concluding from text alone: an entry with
   `inPacket: false`, or a `skip` marker carrying `files`, means decisive
   evidence may sit outside the packet. Download with the `downloadCommand`
   argv or `files --thread … --out-dir` and read the file before making any
   UI- or screenshot-dependent claim.

   Do not re-`context` related tickets marked `alreadyInPacket`. Treat
   `unresolvableTracker: true` as a bare key mention (no Mattermost hop and no
   tracker URL in the text); follow `trackerUrl` when present without treating
   it as a Mattermost `url`.

5. Treat chat as historical evidence and reconcile it with the issue tracker,
   code, and newer sources.

See [Agent output](agent-output.md) for the full projection reference.
