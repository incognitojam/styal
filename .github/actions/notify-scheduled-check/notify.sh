#!/usr/bin/env bash
set -euo pipefail
if [ "$GITHUB_EVENT_NAME" != schedule ]; then
  echo 'Manual runs do not post.'
  exit 0
fi
previous=''
previous_run=''
run_ids=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow "$WORKFLOW" \
  --event schedule --status completed --limit 20 --json databaseId --jq '.[].databaseId')
for run_id in $run_ids; do
  [ "$run_id" != "$GITHUB_RUN_ID" ] || continue
  conclusion=$(gh run view "$run_id" --repo "$GITHUB_REPOSITORY" --json jobs \
    --jq ".jobs[] | select(.name == \"$CHECK_JOB\") | .conclusion")
  if [ "$conclusion" = success ] || [ "$conclusion" = failure ]; then
    previous=$conclusion
    previous_run=$run_id
    break
  fi
done
previous_summary=''
summary_dir=$(mktemp -d "$RUNNER_TEMP/previous-check.XXXXXX")
trap 'rm -rf "$summary_dir"' EXIT
if [ "$previous" = failure ]; then
  if gh run download "$previous_run" --repo "$GITHUB_REPOSITORY" \
    --name scheduled-check-summary --dir "$summary_dir"; then
    previous_summary=$(cat "$summary_dir/summary.txt" 2>/dev/null || true)
  fi
fi
if [ "$RESULT" = failure ] && { [ "$previous" != failure ] || [ -z "$previous_summary" ] || [ -z "$FAILURE_SUMMARY" ] || [ "$previous_summary" != "$FAILURE_SUMMARY" ]; }; then
  title=$FAILURE_TITLE
  color=15158332
  detail=$(printf '%s\n\n%s' "$FAILURE_MESSAGE" "${FAILURE_SUMMARY:-Failure details unavailable; see the check job.}")
elif [ "$RESULT" = success ] && [ "$previous" = failure ]; then
  title=$RECOVERY_TITLE
  color=3066993
  detail=$RECOVERY_MESSAGE
else
  echo 'Check result and failure summary unchanged; not posting.'
  exit 0
fi
payload=$(jq -n --arg title "$title" \
  --arg url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --arg description "$detail" --arg context "$MESSAGE_CONTEXT" --argjson color "$color" \
  '{embeds: [{title: $title, url: $url, description: (($description[:1800]) + "\n\n" + ($context[:300])), color: $color}]}')
curl --fail-with-body --retry 3 --retry-all-errors \
  --header 'Content-Type: application/json' --data "$payload" "$DISCORD_WEBHOOK_URL"
