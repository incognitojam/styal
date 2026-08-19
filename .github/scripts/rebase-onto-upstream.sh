#!/usr/bin/env bash
# Rebase the checked-out patch stack onto the tip of upstream main. Sourced by
# Fork CI's upstream-rebase job and Fork Nightly's prepare step so both use
# the same upstream remote and rebase mechanics.
set -euo pipefail

FORK_REF=$(git rev-parse HEAD)

# Tests pass an already-fetched ref so they exercise the production rebase
# policy without reaching GitHub. Workflow callers fetch upstream here.
if [[ -n "${1:-}" ]]; then
  UPSTREAM_REF=$(git rev-parse --verify "${1}^{commit}")
else
  git remote add upstream https://github.com/pingdotgg/t3code.git
  git fetch --no-tags upstream main
  UPSTREAM_REF=$(git rev-parse FETCH_HEAD)
fi

OLD_UPSTREAM_REF=$(git merge-base "$FORK_REF" "$UPSTREAM_REF")

# Reapply patches already found upstream so they become explicit empty-patch
# stops. Retiring a fork patch is a maintainer decision, even when upstream has
# accepted an identical change.
if ! git \
  -c user.name="github-actions[bot]" \
  -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  rebase --reapply-cherry-picks --empty=stop "$UPSTREAM_REF"; then
  echo "::error title=Fork patch rebase needs review::Resolve conflicts or explicitly retire any fork patch that became empty, then use a source_ref run." >&2
  exit 1
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  if ! range_diff=$(git range-diff --no-color --no-patch \
    "$OLD_UPSTREAM_REF..$FORK_REF" \
    "$UPSTREAM_REF..HEAD"); then
    echo "::warning title=Fork patch range-diff unavailable::The rebase succeeded, but its patch mapping could not be generated." >&2
  elif ! {
    echo "## Fork patch range-diff"
    echo
    echo '```text'
    echo "$range_diff"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"; then
    echo "::warning title=Fork patch range-diff unavailable::The rebase succeeded, but its patch mapping could not be added to the workflow summary." >&2
  fi
fi

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
