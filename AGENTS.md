# mattermost-cli

- Use Bun instead of npm.
- Preserve the read-only boundary: do not add Mattermost write operations or export a generic HTTP request helper.
- Never print, log, snapshot, or commit a Mattermost personal access token.
- Keep runtime configuration and database files under the Git-ignored `.mattermost/` directory.
- Prefer `bun --bun run check` on Apple Silicon when Rosetta breaks Biome under plain `bun run check`.

## Source map

| Directory | Role |
| --- | --- |
| `src/cli/` | `mm` entry, Commander program, command execution |
| `src/config/` | Config load/validation |
| `src/contracts/` | V1 JSON schemas + ranking regression |
| `src/context/` | Context/search/thread orchestration |
| `src/evidence/` | Packing, ticket windows, coverage trust |
| `src/mattermost/` | Read-only client (`http.ts` + resources) |
| `src/output/` | Human + `--agent` formatting |
| `src/search/` | Subject, routing, lexical, fusion, ranking |
| `src/store/` | SQLite index (schema, reads, writes, FTS) |
| `src/sync/` | Sync, doctor/setup, file download, allowlist |
| `src/shared/` | Errors, locks, limits, paths |
| `src/benchmark/` | Retrieval benchmark tooling |

Public package exports stay narrow in `src/index.ts`; prefer local module imports inside the repo.
