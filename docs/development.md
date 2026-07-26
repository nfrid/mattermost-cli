# Development

## Release gate

```bash
bun --bun run check
```

This runs `typecheck`, Biome, and the test suite. Prefer `bun --bun` on Apple
Silicon, where Rosetta can break Biome under plain `bun run check`.

## Smoke gate

The opt-in Mattermost 11.9 smoke gate is strictly read-only and requires an
explicitly configured safe channel, post, and query. A DM is included when
configured:

```bash
MATTERMOST_INTEGRATION=1 \
MATTERMOST_SMOKE_CHANNEL_ID=<configured-channel-id> \
MATTERMOST_SMOKE_DM_ID=<optional-configured-dm-id> \
MATTERMOST_SMOKE_POST_ID=<safe-post-id> \
MATTERMOST_SMOKE_QUERY=<safe-query> \
bun --bun run check:release
```

The smoke database is created in an OS temporary directory and removed
afterward. The suite does not post, react, edit, delete, download attachments,
or write captured messages to tracked fixtures.

## Benchmarks

```bash
bun run benchmark
bun run benchmark:compare
```

## Cue firing report

The `signals.ts` cue tables are hand-calibrated, and a table entry can fire
constantly without ever changing an outcome. `bun run cues` replays the local
index through `buildThreadBrief` with a per-cue recorder attached and reports,
for every entry in every table, how the cue fared:

```bash
bun run cues              # text table over the whole index
bun run cues --json       # machine-readable report
bun run cues --limit 500  # cap threads scanned
```

Read-only and offline; it never contacts Mattermost. Columns follow one cue
against one post: `matched` is the raw surface hit and splits exactly into
`guard` (dropped by the interrogative or negation guard), `capped` (fell off
`MAX_CUES_PER_SIGNAL`), and `reported`. `sole` counts the times the cue was the
*only* reported cue for its signal — a cue that never fires alone has never
decided anything by itself. `survived` and `brief` are what a consumer actually
saw, after every cap and confidence floor.

Two zeros are structural rather than findings: `role:*` cues never reach
`brief` because purpose hints carry no cues, and `scope_refinement` cues never
reach `survived` because refinements exist only inside a brief decision.

The report is a hypothesis generator, not a mandate. A cue that never fires may
still be covering phrasing this corpus happens not to contain, and removing or
reweighting anything still needs a before/after `bun run benchmark` — see the
signal-calibration note in the [ideas backlog](ideas.md).

## Archived and future experiments

- [Rejected local reranker](../experiments/reranker.md)
- [Deferred hybrid semantic retrieval](../experiments/semantic-search.md)
- [Ideas backlog](ideas.md)

The CLI is fully functional without a daemon. WebSockets and operating-system
credential-store integration are possible future enhancements.
