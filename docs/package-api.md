# Package API

Documented package surface (see `src/index.ts`):

- `getMattermostContext` / `searchMattermost` / `getMattermostThread` and their
  input and result types
- V1 Zod schemas (`contextResultV1Schema`, `commandResultV1Schema`, …)
- `projectAgentResult` for `--agent` projection
- `MattermostClient` / connection helpers and Mattermost schemas
- `loadMattermostConfig` / config types

```ts
import {
  contextResultV1Schema,
  getMattermostContext,
} from "mattermost-cli";

const data = await getMattermostContext({
  subject: "PROJ-123",
  repositories: ["example-service"],
  probes: [
    { kind: "ticket_title", value: "Payment reconciliation timeout" },
    { kind: "file_path", value: "src/payments/reconcile.ts" },
    { kind: "symbol", value: "reconcilePayment" },
    { kind: "error_message", value: "upstream request timed out" },
  ],
  from: "alice",
  after: "2026-01-01",
  hasFile: true,
  file: ".log",
  remoteSearch: true,
});

contextResultV1Schema.parse({
  command: "context",
  schemaVersion: 5,
  success: true,
  data,
  warnings: [],
});
```

## Source layout

```text
src/
  cli/           Commander program, command handlers, bin entry
  config/        Local config load + validation
  contracts/     V1 Zod schemas and golden fixtures
  context/       Orchestration: prepare, freshen, hydrate, selection, filters
  evidence/      Packing, ticket segments, evidence status summary
  mattermost/    Read-only HTTP client (`http.ts` transport + resource methods)
  output/        Human format, `--agent` projection, cross-thread timeline, shared labels
  search/        Subject/probes, routing, lexical retrieval, fusion, ranking
  store/         SQLite schema, reads/writes, FTS/trigram helpers
  sync/          Sync, setup/doctor, file download, conversation allowlist
  shared/        Errors, locks, limits, paths, concurrency
  benchmark/     Retrieval benchmark + compare CLIs
```

Internal modules under those directories are not part of the documented package
API.
