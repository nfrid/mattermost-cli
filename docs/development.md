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

## Archived and future experiments

- [Rejected local reranker](../experiments/reranker.md)
- [Deferred hybrid semantic retrieval](../experiments/semantic-search.md)
- [Ideas backlog](ideas.md)

The CLI is fully functional without a daemon. WebSockets and operating-system
credential-store integration are possible future enhancements.
