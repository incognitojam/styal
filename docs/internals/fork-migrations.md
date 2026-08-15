# Fork database migrations

Upstream and fork migrations use separate append-only histories. Upstream migrations remain in
`effect_sql_migrations` with their original IDs. Fork-only migrations start at ID 1 in
`yngatech_sql_migrations` and run after the upstream migration pass.

Do not add fork migrations to the upstream manifest or reserve a high range in the upstream table.
The SQL migrator treats the highest recorded ID as a watermark, so a high fork ID would cause later
upstream migrations with lower IDs to be skipped.

Fork migrations live in `apps/server/src/persistence/ForkMigrations/`. They must be append-only and
idempotent so upgrades remain safe across rebases and interrupted starts.

CI enforces this rule: `.github/scripts/rebase-onto-upstream.sh` (used by Fork CI's upstream-rebase
job and Fork Nightly's prepare step) fails when the rebased patch stack touches
`apps/server/src/persistence/Migrations.ts` or anything under `apps/server/src/persistence/Migrations/`.
The server test job and Fork Nightly also build disposable databases with the migration source from
the released `nightly` branch, then run the candidate's full migration pass. This checks both the
split upstream/fork histories and the legacy pre-split composer-draft history.

The fork previously shipped `39_ComposerDrafts` in the upstream history. Before either migration
pass, the server recognizes that exact ID and name, applies upstream migration 39's guarded schema
change, records the composer migration as fork migration `1_ComposerDrafts`, and rewrites migration
39's name to its canonical upstream value. Applying the schema change directly also repairs users
who briefly switched to an upstream build and already recorded migration 40. Keep this compatibility
repair until installations from before the split no longer need a direct upgrade.
