#!/usr/bin/env bash

is_ci_release_commit() {
  local subject="$1"
  local revert_subject='^[rR][eE][vV][eE][rR][tT][[:space:]]+"(.*)"([[:space:]]+\(#[0-9]+\))?$'
  local conventional_subject='^([[:alpha:]][[:alnum:]-]*)(\(([^)]*)\))?!?:'
  local ci_type='^[cC][iI]$'
  local ci_scope='(^|[[:space:]]*,[[:space:]]*)[cC][iI]([_-][[:alnum:]_-]+)?([[:space:]]*,[[:space:]]*|$)'

  while [[ "$subject" =~ $revert_subject ]]; do
    subject="${BASH_REMATCH[1]}"
  done

  if [[ ! "$subject" =~ $conventional_subject ]]; then
    return 1
  fi

  local commit_type="${BASH_REMATCH[1]}"
  local commit_scope="${BASH_REMATCH[3]}"
  [[ "$commit_type" =~ $ci_type || "$commit_scope" =~ $ci_scope ]]
}

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
