#!/usr/bin/env bash

append_release_changes() {
  local repository="$1"
  shift

  local sha subject title pull_number pull_repository upstream_prs author
  for sha in "$@"; do
    subject=$(git show -s --format=%s "$sha")
    if [[ "$subject" =~ ^(.+)\ \(#([0-9]+)\)$ ]]; then
      title="${BASH_REMATCH[1]}"
      pull_number="${BASH_REMATCH[2]}"
      pull_repository="$repository"
      # Cherry-picked subjects keep their upstream PR number. A fork squash
      # with a different PR suffix still links to the fork's review.
      upstream_prs=$(git show -s --format='%(trailers:key=Upstream-PR,valueonly,separator=%x2C)' "$sha")
      upstream_prs="${upstream_prs//[[:space:]]/}"
      if [[ ",$upstream_prs," == *",$pull_number,"* ]]; then
        pull_repository="pingdotgg/t3code"
      fi

      # gh writes error JSON to stdout on failure, even with --jq. Only use
      # successful lookups; otherwise link to the known commit in this repo.
      if author=$(gh api "repos/${pull_repository}/pulls/${pull_number}" \
        --jq '.user.login // empty' 2>/dev/null); then
        printf -- '- %s ([%s#%s](https://github.com/%s/pull/%s))' \
          "$title" "$pull_repository" "$pull_number" "$pull_repository" "$pull_number"
        if [[ "$author" =~ ^[a-zA-Z0-9-]+(\[bot\])?$ ]]; then
          printf ' by @%s' "$author"
        fi
        printf '\n'
        continue
      fi
    fi

    # shellcheck disable=SC2016 # Markdown backticks must remain literal.
    printf -- '- %s ([`%s`](https://github.com/%s/commit/%s))\n' \
      "$subject" "${sha:0:7}" "$repository" "$sha"
  done
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
