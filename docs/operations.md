# Validate, synchronize, recover

## Validate

```bash
mm whoami
mm channels
mm channels validate
mm doctor
```

`channels validate` checks remote identity and type without rewriting config.

`doctor` checks authentication, team and conversation access, FTS5, index
integrity and migrations, writable directories, and private `.env` / config /
database permissions. Run it after setup and after credential, server, or path
changes.

## Synchronize

```bash
mm sync
mm sync --channel engineering
mm sync --full
```

Initial sync is bounded by `historyDays`. It traverses stable post cursors and
records whether the indexed history is complete or cutoff-bounded. Incremental
sync reconciles an overlap window and advances freshness only after durable
success. Use the explicit, potentially expensive `--full` rebuild only when
needed.

## Concurrency

Concurrent freshen/sync processes take a database-adjacent lockfile; a waiter
that cannot acquire it emits `freshen_lock_busy` and continues with local
evidence. SQLite opens with `busy_timeout`, retries open/migrate while another
process holds the write lock, and uses WAL `synchronous=NORMAL`.

Context freshen is targeted — the ticket-related, matched, and capped stale set
— rather than refreshing the entire allowlist on every call.

## Migrations, backup, and recovery

Database migrations run automatically and transactionally whenever a
database-using command opens the store. Applied versions are recorded in
`schema_migrations`; no manual migration command is required.

SQLite is a disposable retrieval index, not the source of truth. A backup is
optional and useful only to avoid another backfill. Concurrent `mm` processes
wait on SQLite locks (`busy_timeout` plus open retries) instead of treating a
busy index as corrupt.

If `doctor` reports a corrupt or incompatible index — after other `mm` processes
have stopped — optionally copy the database for diagnosis, then rebuild:

```bash
rm -f .mattermost/mattermost.sqlite3 \
      .mattermost/mattermost.sqlite3-shm \
      .mattermost/mattermost.sqlite3-wal
mm sync
```

A failed sync or migration does not advance a successful freshness checkpoint.
Timeouts, inaccessible conversations, missing roots, and partial reconciliation
produce explicit errors or incomplete warnings rather than current-looking
evidence.
