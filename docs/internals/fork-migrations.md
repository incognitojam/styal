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

Review enforces this rule: a fork PR must not touch `apps/server/src/persistence/Migrations.ts` or
anything under `apps/server/src/persistence/Migrations/`. Only a PR that deliberately brings an
upstream migration in may change those paths, and it should carry upstream's change verbatim.
The server test job and Fork Nightly also build disposable databases with the migration source from
the released `nightly` branch, then run the candidate's full migration pass. This checks both the
split upstream/fork histories and the legacy pre-split composer-draft history.

The fork previously shipped `39_ComposerDrafts` in the upstream history. Before either migration
pass, the server recognizes that exact ID and name, applies upstream migration 39's guarded schema
change, records the composer migration as fork migration `1_ComposerDrafts`, and rewrites migration
39's name to its canonical upstream value. Applying the schema change directly also repairs users
who briefly switched to an upstream build and already recorded migration 40. Keep this compatibility
repair until installations from before the split no longer need a direct upgrade.

Review removal on or after **October 9, 2026**, two months after the first fixed nightly on
August 9, 2026, as tracked in [issue #62](https://github.com/incognitojam/styal/issues/62).
This is a review date, not an automatic expiry. Before removal, give known fork users a reasonable
opportunity to update through a fixed release, confirm with them where practical, preserve a
documented recovery path for legacy migration 39 databases, and run the focused fork migration and
startup migration tests. Remove only the one-time repair and its specific tests and documentation;
keep `yngatech_sql_migrations` and fork migration `1_ComposerDrafts` permanently.
