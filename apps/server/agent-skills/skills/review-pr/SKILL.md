---
name: review-pr
description: Review a pull request and, when asked, keep its checks and reviews green.
---

Read the PR, linked issue, repository instructions and diff. Check correctness against the
requested behavior and the repository's rules. Run its fast checks and exercise affected behavior.
Report concrete findings ranked by severity, with file and line references; say what could not
be verified. A review request alone does not authorize edits or posting a GitHub review.

Use `pull_request_read` for PR state, checks, comments and review threads, or GitHub CLI:
`gh pr view`, `gh pr diff`, `gh pr checks`, `gh issue view` and `gh api` for inline review comments.
Confirm the repository and PR before acting. Use the repository's existing review tooling when
available. `read_pull_request_guide` reads an existing reading tour; `write_pull_request_guides` starts one.
Neither is a correctness verdict.

When asked to work on the PR and keep it green:

- Handle existing failures and review comments first. Verify each bot finding against the source,
  fix real ones, and explain false positives in writing on the authorized PR. Follow repository
  instructions for checks and pushing. After a push, inspect the latest head's checks and reviews.
- Call `watch_pull_request` and end your turn. It wakes you on failed checks, passed required
  checks, new comments or reviews, conflicts, and merge or close (unless you did it via CLI). The watch stays on; do not
  register it again on each wake. Existing comments do not trigger a wake. Do not poll or sleep.
- On a wake, read the current state and act on new findings. Stay quiet when nothing is new.
  Stop when checks and bots are green on the latest commit and no blocking review remains;
  call `unwatch_pull_request` and report readiness. Stop if the PR merges or closes.

Delegated children cannot watch PRs: return findings and remaining work to the parent.
If the watch tool is unavailable, `gh pr checks --watch` can wait for checks, but it polls and
cannot wake on reviews or comments. It is not a substitute for this workflow; report the missing
watch capability rather than starting a polling loop.

Never merge, close, or reopen a PR without an explicit request for that action. Do not push,
comment, submit reviews or resolve threads on a PR the user did not authorize you to work on.
