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
allow_missing="${4:-false}"

for ref in "$main_ref" "$candidate_ref" "$upstream_ref"; do
  git rev-parse --verify "${ref}^{commit}" >/dev/null
done

cherry_output=$(git cherry "$candidate_ref" "$main_ref" "$upstream_ref")

missing_commits=()
while read -r status commit; do
  if [[ "$status" == "+" ]]; then
    missing_commits+=("$commit")
  fi
done <<< "$cherry_output"

if (( ${#missing_commits[@]} == 0 )); then
  echo "source_ref contains every patch currently carried by main."
  exit 0
fi

{
  echo "source_ref is missing patch-id-equivalent commits currently carried by main:"
  echo
  for commit in "${missing_commits[@]}"; do
    printf '  %s %s\n' \
      "$(git rev-parse --short=12 "$commit")" \
      "$(git show -s --format=%s "$commit")"
  done
  echo
} >&2

if [[ "$allow_missing" == "true" ]]; then
  echo "Conflict resolution may intentionally reshape patches; continuing after the explicit override." >&2
  echo "::warning title=Missing main patches explicitly allowed::Continuing because allow_missing_main_patches was enabled." >&2
  exit 0
fi

echo "Refresh the resolution from current main before dispatching it." >&2
echo "If conflict resolution intentionally reshaped these patches, re-dispatch" >&2
echo "with allow_missing_main_patches enabled after reviewing this list." >&2
echo "::error title=source_ref is missing patches from main::Refresh the stack or explicitly allow the reported patch-id differences." >&2
exit 1
