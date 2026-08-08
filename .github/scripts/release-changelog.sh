#!/usr/bin/env bash

list_fork_release_commits() {
  local previous_release_ref="$1"
  local fork_source_ref="$2"
  local upstream_ref="$3"

  if [[ -n "$previous_release_ref" ]]; then
    git rev-list --reverse --cherry-pick --right-only \
      "${previous_release_ref}...${fork_source_ref}" \
      --not "$upstream_ref"
    return
  fi

  local fork_base
  fork_base=$(git merge-base "$fork_source_ref" "$upstream_ref")
  git rev-list --reverse "${fork_base}..${fork_source_ref}" --not "$upstream_ref"
}
