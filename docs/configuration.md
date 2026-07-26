# Configuration

## Requirements

- Bun 1.3.3 or a compatible current Bun release
- a self-hosted Mattermost 11.9-compatible server
- a Mattermost PAT
- access to one configured Mattermost team

## Setup

```bash
bun install --frozen-lockfile
mkdir -p .mattermost
chmod 700 .mattermost
cp config.example.json .mattermost/config.json
chmod 600 .mattermost/config.json
cp .env.example .env
chmod 600 .env
```

## Config file

Edit `.mattermost/config.json`. Channels and direct messages are separate
allowlists: a DM or group message is eligible only when its channel ID appears
explicitly under `directMessages`.

```json
{
  "schemaVersion": 1,
  "url": "https://mattermost.example.test",
  "teamId": "team-id",
  "historyDays": 365,
  "synonyms": {
    "репликация": ["replication", "data replication"]
  },
  "concepts": {
    "duplicate-charge": [
      "повторное списание",
      "списали дважды",
      "duplicate charge"
    ]
  },
  "suppressAuthors": ["legacy-integration"],
  "people": {
    "alice": "Product manager"
  },
  "budgets": {
    "defaultMaxCharacters": 16000,
    "defaultPerThreadCharacters": 6000,
    "defaultMaxThreads": 3,
    "matchNeighborhoodRadius": 2,
    "ticketNeighborhoodRadius": 8,
    "clusterMergeGap": 2,
    "conversationSurroundRoots": 5,
    "shortThreadMaxReplies": 2
  },
  "channels": {
    "engineering": {
      "id": "channel-id",
      "name": "engineering",
      "description": "Engineering discussion",
      "repositories": ["example-service"],
      "scopes": ["backend"]
    }
  },
  "directMessages": {
    "leads": {
      "channelId": "dm-or-group-channel-id",
      "description": "Explicitly allowed project coordination conversation",
      "participants": ["alice", "bob"]
    }
  }
}
```

`context` may override `defaultMaxThreads` / `defaultMaxCharacters` /
`defaultPerThreadCharacters` for one request via `--max-threads`,
`--max-characters`, and `--per-thread-characters`. Defaults stay config-backed
when those flags are omitted.

### Synonyms and concepts

Project-specific synonym groups go in the top-level `synonyms` object. Groups
are symmetric, limited to 32 keys and eight aliases per key, and reported in
each probe's `expansions` diagnostics.

Bounded multi-phrase domain concepts use the separate `concepts` object. A
concept has a stable lowercase ID and two to eight explicit aliases; aliases
cannot be shared between concepts. Matching aliases add an opaque token to the
separate `concept_fts` index, while probe diagnostics expose only the concept ID
and the triggering phrase. Changing concept configuration automatically rebuilds
this disposable index.

## Paths

Default paths are tied to this repository rather than the caller's current
directory:

```text
.mattermost/config.json
.mattermost/mattermost.sqlite3
```

Environment overrides are available for controlled local use:

```text
MATTERMOST_URL
MATTERMOST_TOKEN
MATTERMOST_CONFIG
MATTERMOST_DATABASE
MATTERMOST_OCR_MODULE
MATTERMOST_OCR_DISABLE_MACOS
```

`MATTERMOST_OCR_MODULE` is an optional path to a JS module exporting
`extractImageText` for image OCR during `file --inspect` (see
[retrieval.md](./retrieval.md#opt-in-ocr)). When unset on macOS, mm tries the
built-in Vision helper unless `MATTERMOST_OCR_DISABLE_MACOS=1`. OCR text is
always low-trust; failure leaves images `not_interpreted`.

Overrides for config/database paths may select alternate files only under this
repository's `.mattermost/` directory; paths outside that private, ignored
runtime boundary are rejected.
