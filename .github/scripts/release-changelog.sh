#!/usr/bin/env bash

# Succeeds when the commit changes a file that ships in the server, web,
# desktop, or mobile builds, including dependency patches. Docs, CI, repository
# tooling, the separately deployed relay, tests, and their fixtures do not
# count, whatever the commit subject says.
changes_shipped_code() {
  local sha="$1" shipped
  shipped=$(
    git diff-tree --no-commit-id --name-only -r --root "$sha" \
      | grep -E '^(apps/(web|desktop|mobile|server)|packages/[^/]+|patches)/' \
      | grep -vE '\.md$|\.(test|spec)\.[cm]?[jt]sx?$|/(__tests__|tests?|testing|testUtils|testFixtures|fixtures|integration|scripts)/' \
      || true
  )
  [[ -n "$shipped" ]]
}

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

# Prints the newest plain vX.Y.Z tag, or the newest one older than $1 when it
# is given. Prints nothing when there is none.
latest_stable_tag() {
  local before="${1:-}"
  local tags
  tags=$(git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)

  if [[ -z "$before" ]]; then
    printf '%s\n' "$tags" | sed '/^$/d' | sort -V | tail -n 1
    return
  fi

  { printf '%s\n' "$tags"; printf '%s\n' "$before"; } \
    | sed '/^$/d' \
    | sort -uV \
    | grep -B1 -xF -- "$before" \
    | grep -vxF -- "$before" \
    || true
}

# Prints the "What's Changed" release notes for the commits between
# previous_tag and fork_source_ref: fork changes first, then the upstream
# changes brought in over the same range. Commits that change no shipped code
# are counted but not listed. previous_tag may be empty.
render_release_notes() {
  local repository="$1"
  local previous_tag="$2"
  local new_tag="$3"
  local fork_source_ref="$4"
  local upstream_ref="$5"

  local previous_upstream_ref
  if [[ -n "$previous_tag" ]]; then
    git rev-parse --verify "${previous_tag}^{commit}" >/dev/null
    previous_upstream_ref=$(git merge-base "$previous_tag" "$upstream_ref")
  else
    previous_upstream_ref=$(git merge-base "$fork_source_ref" "$upstream_ref")
  fi

  local upstream_changes=() fork_changes=() commit_count=0 sha
  while IFS= read -r sha; do
    commit_count=$((commit_count + 1))
    if changes_shipped_code "$sha"; then
      upstream_changes+=("$sha")
    fi
  done < <(git rev-list --reverse "${previous_upstream_ref}..${upstream_ref}")

  while IFS= read -r sha; do
    commit_count=$((commit_count + 1))
    if changes_shipped_code "$sha"; then
      fork_changes+=("$sha")
    fi
  done < <(list_fork_release_commits "$previous_tag" "$fork_source_ref" "$upstream_ref")

  local omitted_count=$((commit_count - ${#fork_changes[@]} - ${#upstream_changes[@]}))

  printf "## What's Changed\n\n"
  if (( ${#fork_changes[@]} > 0 )); then
    append_release_changes "$repository" "${fork_changes[@]}"
  fi
  if (( ${#upstream_changes[@]} > 0 )); then
    append_release_changes pingdotgg/t3code "${upstream_changes[@]}"
  fi
  if (( ${#fork_changes[@]} + ${#upstream_changes[@]} == 0 )); then
    printf 'No user-facing changes.\n'
  fi
  # Compare the fork's own release tags. Comparing upstream refs named the
  # wrong repository, and collapsed to an empty range whenever the release
  # carried no upstream changes. The omitted count goes on this line because
  # the desktop updater skips it when listing changes.
  if [[ -n "$previous_tag" ]]; then
    printf '\n**Full Changelog**: https://github.com/%s/compare/%s...%s' \
      "$repository" "$previous_tag" "$new_tag"
    if (( omitted_count == 1 )); then
      printf ' (includes 1 docs, CI, test, or tooling change not listed above)'
    elif (( omitted_count > 1 )); then
      printf ' (includes %s docs, CI, test, and tooling changes not listed above)' \
        "$omitted_count"
    fi
    printf '\n'
  fi
}
