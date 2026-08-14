#!/usr/bin/env bash
# Verify that a manually supplied nightly source contains every fork patch
# present on main. This catches accidentally stale stacks; it is not a
# security boundary or a net-tree comparison (a later revert can still retain
# an earlier commit's patch-id). The refs must already exist locally, and the
# fork's squash-merged patch stack is expected to have linear history.
set -euo pipefail

main_ref="${1:?main ref is required}"
candidate_ref="${2:?candidate ref is required}"
upstream_ref="${3:?upstream ref is required}"
waived_input="${4:-}"

for ref in "$main_ref" "$candidate_ref" "$upstream_ref"; do
  git rev-parse --verify "${ref}^{commit}" >/dev/null
done

# Waivers are the reviewed commits themselves, not a blanket override: a
# patch that merges to main after the review is not on the list and still
# fails the dispatch. The former allow_missing_main_patches boolean waived
# every missing patch at once, so it could not make that distinction.
if [[ "$waived_input" == "true" ]]; then
  echo "The allow_missing_main_patches boolean was replaced by waived_main_patches; list each reviewed commit instead." >&2
  exit 1
fi
if [[ "$waived_input" == "false" ]]; then
  waived_input=""
fi

waived_entries=()
normalized_waivers="${waived_input//[$'\n',]/ }"
read -r -a waived_entries <<< "$normalized_waivers" || true

waived_commits=()
if (( ${#waived_entries[@]} > 0 )); then
  for entry in "${waived_entries[@]}"; do
    if ! commit=$(git rev-parse --verify --quiet "${entry}^{commit}"); then
      echo "waived_main_patches entry '${entry}' does not resolve to a commit." >&2
      exit 1
    fi
    waived_commits+=("$commit")
  done
fi

is_waived() {
  local wanted="$1" waived
  (( ${#waived_commits[@]} > 0 )) || return 1
  for waived in "${waived_commits[@]}"; do
    if [[ "$waived" == "$wanted" ]]; then
      return 0
    fi
  done
  return 1
}

describe_commit() {
  printf '  %s %s\n' \
    "$(git rev-parse --short=12 "$1")" \
    "$(git show -s --format=%s "$1")"
}

cherry_output=$(git cherry "$candidate_ref" "$main_ref" "$upstream_ref")

missing_commits=()
while read -r status commit; do
  if [[ "$status" == "+" ]]; then
    missing_commits+=("$commit")
  fi
done <<< "$cherry_output"

if (( ${#missing_commits[@]} == 0 )); then
  echo "source_ref contains every patch currently carried by main."
  if (( ${#waived_commits[@]} > 0 )); then
    echo "Every waived_main_patches entry is present after all; the waivers were not needed." >&2
  fi
  exit 0
fi

waived_missing=()
unwaived_commits=()
for commit in "${missing_commits[@]}"; do
  if is_waived "$commit"; then
    waived_missing+=("$commit")
  else
    unwaived_commits+=("$commit")
  fi
done

if (( ${#waived_missing[@]} > 0 )); then
  {
    echo "Waived main patches missing from source_ref (reviewed as intentionally reshaped):"
    echo
    for commit in "${waived_missing[@]}"; do
      describe_commit "$commit"
    done
    echo
  } >&2
  echo "::warning title=Waived missing main patches::Continuing past ${#waived_missing[@]} reviewed patch-id difference(s) listed in the log." >&2
fi

if (( ${#unwaived_commits[@]} == 0 )); then
  exit 0
fi

{
  echo "source_ref is missing patch-id-equivalent commits currently carried by main:"
  echo
  for commit in "${unwaived_commits[@]}"; do
    describe_commit "$commit"
  done
  echo
} >&2

echo "Refresh the resolution from current main before dispatching it." >&2
echo "If conflict resolution intentionally reshaped these patches, re-dispatch" >&2
echo "listing each reviewed commit in waived_main_patches." >&2
echo "::error title=source_ref is missing patches from main::Refresh the stack or waive each reviewed patch-id difference explicitly." >&2
exit 1
