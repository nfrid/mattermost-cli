# mattermost-cli

- Use Bun instead of npm.
- Preserve the read-only boundary: do not add Mattermost write operations or export a generic HTTP request helper.
- Never print, log, snapshot, or commit a Mattermost personal access token.
- Keep runtime configuration and database files under the Git-ignored `.mattermost/` directory.
- Prefer `bun --bun run check` on Apple Silicon when Rosetta breaks Biome under plain `bun run check`.
- Reference documentation lives in `docs/` (see `docs/README.md`); `README.md` is the entry point only. Contract changes belong in `docs/json-contract.md` and `docs/agent-output.md`.

## Source map

Directories are layered lowest-first. A module may import from its own layer or
a lower one, never a higher one; `src/architecture.test.ts` enforces this along
with a no-import-cycles rule, and holds the short allowlist of deliberate
exceptions.

| Layer | Directory | Role |
| --- | --- | --- |
| 1 | `src/text/` | Text kernel: normalization, morphology, excerpts, entity and ticket extraction, concept tokens. Imports nothing else under `src/` |
| 2 | `src/shared/` | Errors, locks, limits, paths |
| 3 | `src/config/`, `src/mattermost/` | Config load/validation; read-only client (`http.ts` + resources) |
| 4 | `src/store/` | SQLite index (schema, reads, writes, FTS) |
| 5 | `src/search/` | Subject, routing, lexical, fusion, `ranking/` |
| 6 | `src/evidence/` | `packing/`, ticket windows, `signals/`, `status/` coverage trust |
| 7 | `src/sync/` | Sync, doctor/setup, file download, allowlist |
| 8 | `src/context/` | Context/search/thread orchestration |
| 9 | `src/output/` | `human/` formatting + `agent/` projection |
| 10 | `src/cli/` | `mm` entry, Commander program, command execution |

`src/contracts/` (V1 JSON schemas + ranking regression) and `src/benchmark/`
(retrieval benchmark and cue calibration) are leaf consumers outside the
layering.

Several directories pair a module with a same-named folder — `signals.ts` +
`signals/`, `packing.ts` + `packing/`, `ranking.ts` + `ranking/`,
`contracts.ts` + `schema/`, `agent-view.ts` + `agent/`. The module is the
stable import site; the folder is internal. Import the module, not its parts.

Public package exports stay narrow in `src/index.ts`; prefer local module imports inside the repo.

## Verifying a change

`bun --bun run check` is the gate. For anything that touches retrieval,
packing, evidence, or output, also run the packet harness, which compares the
emitted packets against another revision byte for byte across nine projections:

```bash
bun run packet-diff --baseline <git-ref> TECHSUPP-109 BTB-2113
```

Read-only and offline; it never contacts Mattermost.
