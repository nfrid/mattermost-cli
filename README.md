# mattermost-cli

Standalone, read-only Mattermost retrieval and indexing. V1 provides
authentication checks, curated conversation allowlists, a disposable SQLite/FTS5
index, deterministic thread retrieval, and bounded context packets — without a
daemon.

`mm` cannot post, edit, react, or delete. It reads only from explicitly
configured channels and DMs, and it never widens that allowlist itself. See the
[security model](docs/security.md).

## Requirements

- Bun 1.3.3 or a compatible current Bun release
- a self-hosted Mattermost 11.9-compatible server
- a Mattermost PAT
- access to one configured Mattermost team

## Quick start

```bash
bun install --frozen-lockfile
mkdir -p .mattermost && chmod 700 .mattermost
cp config.example.json .mattermost/config.json && chmod 600 .mattermost/config.json
cp .env.example .env && chmod 600 .env
```

Put your PAT in `MATTERMOST_TOKEN`, list the conversations you want in
`.mattermost/config.json`, then validate and index:

```bash
mm doctor
mm sync
```

Retrieve:

```bash
mm context PROJ-123 --agent
mm search 'deployment timeout'
mm thread <post-id-or-permalink>
```

Full setup detail is in [Configuration](docs/configuration.md); `mm` is the
package `bin`, equivalent to `bun run src/cli/bin.ts`.

## Commands

| Command | Purpose |
| --- | --- |
| `whoami` | confirm authentication |
| `channels` / `channels validate` | list configured conversations; check remote identity and type |
| `doctor` | auth, access, FTS5, index integrity, permissions |
| `sync` | index configured history (`--channel`, `--full`) |
| `context <subject>` | bounded evidence packet for a ticket, permalink, or free text |
| `search <query>` | local ranked discovery |
| `thread <post-id\|permalink>` | one thread (`--full` for the complete thread) |
| `people` | indexed authors with roles and activity |
| `file` / `files` | explicit attachment download |

Shared output modes: `--agent` (agent projection), `--json` / `--pretty`,
`--brief`, `--timeline`, `--navigate`, `--out <path>`.

## Documentation

- [Security model](docs/security.md)
- [Configuration](docs/configuration.md)
- [Operations](docs/operations.md) — sync, doctor, recovery
- [Retrieval](docs/retrieval.md) — commands, filters, packing, ranking
- [JSON contract](docs/json-contract.md)
- [Agent output](docs/agent-output.md) — the `--agent` projection reference
- [Agent workflow](docs/agent-workflow.md)
- [Package API](docs/package-api.md)
- [Development](docs/development.md)

Full index: [`docs/`](docs/README.md).

## Caveat

Historical chat is evidence, not automatically current product truth. Reconcile
it with the issue tracker, code, documentation, and newer authoritative sources.
