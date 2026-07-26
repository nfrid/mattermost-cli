# mattermost-cli documentation

| Document | Covers |
| --- | --- |
| [Security model](security.md) | Read-only boundary, tokens, transport, local file modes |
| [Configuration](configuration.md) | Requirements, setup, `config.json`, synonyms and concepts, paths and env overrides |
| [Operations](operations.md) | `whoami` / `channels` / `doctor`, sync, concurrency, migrations and recovery |
| [Retrieval](retrieval.md) | Commands, probes, filters, allowlist, freshness, packing, ranking internals |
| [JSON contract](json-contract.md) | `--json` envelope, evidence axes, schema policy and history |
| [Agent output](agent-output.md) | The `--agent` projection reference: threads, decision layer, attachments, `evidence.next` |
| [Agent workflow](agent-workflow.md) | Recommended order of calls when retrieving evidence |
| [Package API](package-api.md) | Exported surface, usage example, source layout |
| [Development](development.md) | Release gate, smoke gate, benchmarks, experiments |
| [Ideas backlog](ideas.md) | Deferred notes; not a roadmap |
