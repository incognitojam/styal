#!/usr/bin/env bash
# Rebase the checked-out patch stack onto the tip of upstream main. Sourced by
# Fork CI's upstream-rebase job and Fork Nightly's prepare step so both use
# the same upstream remote and rebase mechanics.
set -euo pipefail

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch --no-tags upstream main
# shellcheck disable=SC2034 # Consumed by scripts that source this file.
UPSTREAM_REF=$(git rev-parse FETCH_HEAD)
git rebase "$UPSTREAM_REF"

# The patch stack must never touch upstream's migration manifest or migration
# files. A fork commit in upstream's numbered sequence collides silently on a
# later rebase: the SQL migrator treats the highest recorded ID as a watermark,
# so existing installs skip the upstream migration that lands on the same slot.
offending_migration_files=$(git diff --name-only "$UPSTREAM_REF" HEAD -- \
  'apps/server/src/persistence/Migrations.ts' \
  'apps/server/src/persistence/Migrations/')
if [[ -n "$offending_migration_files" ]]; then
  {
    echo "Error: the fork patch stack modifies upstream migration files:"
    echo
    echo "$offending_migration_files"
    echo
    echo "Fork migrations belong in apps/server/src/persistence/ForkMigrations/"
    echo "with their own append-only history. See docs/internals/fork-migrations.md."
  } >&2
  exit 1
fi
