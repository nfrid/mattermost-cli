# mattermost-cli

- Use Bun instead of npm.
- Preserve the read-only boundary: do not add Mattermost write operations or export a generic HTTP request helper.
- Never print, log, snapshot, or commit a Mattermost personal access token.
- Keep runtime configuration and database files under the Git-ignored `.mattermost/` directory.
