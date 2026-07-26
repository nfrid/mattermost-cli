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

Layered lowest-first: a module imports from its own layer or a lower one, never
a higher one. `src/architecture.test.ts` enforces that, plus a no-cycles rule.

```text
src/
  text/          Text kernel: normalization, morphology, excerpts, entity and
                 ticket extraction, concept tokens. Imports nothing else here
  shared/        Errors, locks, limits, paths, concurrency
  config/        Local config load + validation
  mattermost/    Read-only HTTP client (`http.ts` transport + resource methods)
  store/         SQLite schema, reads/writes, FTS/trigram helpers
  search/        Subject/probes, routing, lexical retrieval, fusion, ranking/
  evidence/      packing/, ticket segments, signals/, status/ coverage trust
  sync/          Sync, setup/doctor, file download, conversation allowlist
  context/       Orchestration: prepare, retrieve, freshen, hydrate, selection
  output/        human/ formatting, agent/ projection, cross-thread timeline
  cli/           Commander program, command handlers, bin entry

  contracts/     V1 Zod schemas and golden fixtures (leaf consumer)
  benchmark/     Retrieval benchmark + compare CLIs (leaf consumer)
```

Where a module sits beside a same-named folder — `signals.ts` + `signals/`,
`packing.ts` + `packing/`, `ranking.ts` + `ranking/`, `contracts.ts` +
`schema/`, `agent-view.ts` + `agent/` — the module is the import site and the
folder is its internal split.

Internal modules under those directories are not part of the documented package
API.
