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
