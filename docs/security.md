# Security model

## Read-only boundary

The HTTP client exposes named read operations only: bounded `GET` requests, one
bounded Mattermost post-search `POST`, and an explicit attachment download used
by `mm file` / `mm files`. It cannot post messages, edit, react, or delete, and
it does not export a generic HTTP helper.

Explicitly configured channels and DMs are enforced again at every boundary:
sync, local search, routing, thread hydration, and file download. `mm` never
widens its own allowlist.

## Tokens

Mattermost PATs inherit the permissions of their user; they do not provide
fine-grained scopes. Create a PAT under the Mattermost profile security settings
only if PATs are enabled, use the least-privileged suitable account, and
configure only the conversations this tool needs.

Never put a PAT in command arguments, committed files, logs, or issue text.

The preferred source is the `MATTERMOST_TOKEN` environment variable. An ignored
local config token is supported but is plaintext, not encrypted secret storage.
Git ignore rules reduce accidental tracking but do not protect against another
process or user that can read the file. Operating-system credential-store
integration is not currently available.

## Transport and local files

- Mattermost URLs must use HTTPS. Plain HTTP is accepted only for loopback
  development.
- API success and error bodies are bounded.
- Known tokens are redacted before displayed error truncation.
- Local database files are set to mode `0600`.
- `.mattermost` directories created by the tool use mode `0700`.

## Evidence, not truth

Historical chat is evidence, not automatically current product truth. Reconcile
it with the issue tracker, code, documentation, and newer authoritative sources.
