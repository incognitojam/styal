# Fork database migrations

Upstream and fork migrations use separate append-only histories. Upstream migrations remain in
`effect_sql_migrations` with their original IDs. Fork-only migrations start at ID 1 in
`yngatech_sql_migrations` and run after the upstream migration pass.

The `yngatech_` prefix is a frozen identifier, not a stale one. It predates the move to
`incognitojam/t3code` and is deliberately left alone: the migrator reads this table to decide what
has already run, so renaming it would make every existing database look unmigrated. Leave it in
place through any future rebrand.

Do not add fork migrations to the upstream manifest or reserve a high range in the upstream table.
The SQL migrator treats the highest recorded ID as a watermark, so a high fork ID would cause later
upstream migrations with lower IDs to be skipped.

Fork migrations live in `apps/server/src/persistence/ForkMigrations/`. They must be append-only and
idempotent so upgrades remain safe across rebases and interrupted starts.

A fork PR must not touch `apps/server/src/persistence/Migrations.ts` or anything under
`apps/server/src/persistence/Migrations/`. Only a PR that deliberately brings an upstream migration
in may change those paths, and it should carry upstream's change verbatim. The server test job and
Fork Nightly upgrade disposable databases built from the released `nightly` branch to check that the
two histories stay separate and composer drafts survive.

## Retired pre-split repair

The one-time repair for `39_ComposerDrafts` in the upstream history has been removed. Supported
in-place upgrades assume the installation has already run a fixed release from August 9, 2026 or
later. A database that still records `ComposerDrafts` as upstream migration 39 must pass through
an intermediate release containing the repair before starting this version. Otherwise, migration
39's required `default_thread_env_mode` column is absent and server startup fails.

For recovery, stop the server and back up the affected data directory. Run a known fixed release
against that directory, such as
[the first fixed nightly](https://github.com/incognitojam/styal/releases/tag/v0.0.33-nightly.20260809.126),
and let it finish startup before returning to the current version. The repair canonicalizes upstream
migration 39 and records `1_ComposerDrafts` in the fork history. Do not merely rename the ledger entry:
that leaves the required schema change unapplied.

The `yngatech_sql_migrations` ledger and fork migration `1_ComposerDrafts` remain permanent.
Read-only import from legacy T3 Code databases does not run startup migrations on the source.
