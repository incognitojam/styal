# Upstream tracking

`main` is not synced with `pingdotgg/t3code`. Upstream changes are brought in deliberately, one or
more at a time. The `Upstream tracking` workflow keeps the list of candidates current; deciding what
to take, and dispatching the work, stays with a maintainer.

## The tracking issue

Once a day the workflow reconciles upstream pull requests merged inside the configured window into
the issue named by the `UPSTREAM_TRACKING_ISSUE` repository variable. The repository variable
`UPSTREAM_TRACKING_WINDOW_DAYS` controls scheduled and post-promotion runs; an unset variable falls
back to 14 days, and a manual workflow input overrides it. Each line is a checkbox, the merge date,
the title, and the top-level areas it touched. New candidates are inserted by merge date. Existing
lines and their indented notes are preserved.

The tracker reads source provenance from `main` commit messages. Escaped references listed beneath a
`Source PRs:` section in fork squash commit bodies and case-insensitive `Upstream-PR:` trailers on
intake commits both count. Other upstream references in commit prose do not. When provenance names a
listed pull request, the tracker checks it and adds `— promoted \`abcdef0\``. Promotion overrides a
non-terminal `review needed`disposition but not`already present`or`skip`. This recognizes rebased,
cherry-picked, modified, and squashed ports without guessing from patch similarity.

A checked item without a disposition is queued for intake. Terminal dispositions are `promoted`,
`already present`, and `skip`; use `review needed` for a non-terminal decision. Maintainers may add a
reason using the exact form `— skip: reason` or `— review needed: reason`, and may keep direction as
indented lines beneath the item. Notes on an unticked item expire with it. Unticked items expire after
the configured UTC scan window. Checked items and `review needed` decisions remain as the durable
backlog and are reported when they are outside the window. Terminal entries are pruned on the same
schedule.

The tracker keeps the issue below a 55,000-character operating budget by removing the oldest terminal
entries and deferring the newest unqueued entries when necessary. Compact hidden terminal markers
keep `promoted`, `already present`, and `skip` decisions from being relisted while their sources remain
inside the scan window. Compaction retains the source number, but discards its displayed disposition
reason and indented notes. The oldest unresolved slice therefore stays visible during catch-up. When
newer candidates are deferred, a hidden marker pins the current scan boundary until all of them have
returned as triage makes room; narrowing the configured window does not age them out. The tracker
never compacts queued or `review needed` entries; if those alone exceed the budget, the workflow fails
with a request to split or resolve the backlog. The run summary reports the effective scan boundary,
body size, durable backlog count, and deferred count.

For an initial catch-up, leave the repository variable unset or manually dispatch a window wide
enough to reach the known divergence boundary. When a run reports zero deferred catch-up candidates,
set `UPSTREAM_TRACKING_WINDOW_DAYS` to the desired steady-state window. Seven days is a practical
starting point; it is an operating choice rather than a completeness boundary.

A gap longer than the scan window can miss upstream merges. Recover by manually dispatching the
workflow with a temporarily wider `since_days` value. If that scan defers candidates, its boundary
remains pinned across subsequent daily runs until catch-up finishes. A recovery scan can briefly
relist old unqueued or terminal items because the bounded issue does not retain permanent tombstones.

The issue update is a full-body write. Avoid editing it during a running tracker job; a manual edit in
the short interval between the workflow's read and write can be overwritten.

Nothing the workflow writes links to upstream or mentions anyone: numbers and titles are wrapped in
backticks and no URLs are rendered. Keep that property when annotating, so the issue never creates
cross-references or notifications on upstream's side.

## Preparing an intake candidate

Tick the boxes you want and add direction beneath each — what to keep of the fork's behaviour, which
related changes to take together, or why to skip. Then dispatch an agent with the ticked items and
those notes as its brief.

Routine candidates use an `intake/<batch>` branch based on the current `main`. Preserve the individual
upstream commits and their authors where they apply cleanly; a port may use fork-authored commits when
the implementation must differ. Every intake commit records its source in commit metadata with a
comma-separated trailer such as `Upstream-PR: 1234, 5678`. Fork pull requests may instead list escaped
`pingdotgg/t3code#1234` references beneath an exact `Source PRs:` section because this repository
retains the body in the squash commit. Do not merge `main` into the branch. If `main` moves, rebase the
candidate and validate it again before promotion.

Pushing an intake branch runs the same Fork CI jobs as a pull request, comparing the complete
`main...candidate` diff rather than only the latest push. `Fork Intake Audit` also verifies that the
branch can fast-forward from `main`, rejects merge commits, reports exact fork feature ledger overlap,
and conservatively identifies changes that need a maintainer decision. Automation and scripts,
dependencies, migrations, contracts, authentication, user-facing clients, and ledger overlap all
require manual review. A candidate outside those categories is reported as eligible for eventual
automatic promotion.

The intake audit is report-only: it never writes to `main`. A valid candidate can be promoted with the
`Promote upstream intake` workflow once the repository configuration below is in place. Routine
upstream pull requests or issues carried by the candidate stay in backticks. The reviewer must also
inspect upstream source changes that the resulting diff intentionally leaves out. Upstream migration
files may only change in a reviewed intake, carried verbatim.

## Manual promotion

Before dispatching promotion, give an independent model the candidate's complete `main...candidate`
diff, its audit report, and the upstream changes it is meant to carry. Resolve its findings, rerun Fork
CI, and copy the full candidate commit id. Dispatch `Promote upstream intake` from `main` with the
`intake/<batch>` branch, that exact commit id as `reviewed_sha`, and the comma-separated source pull
request numbers as `source_prs`. Trusted validation requires that list to exactly match the candidate's
commit provenance. This is durable bookkeeping, not proof that the candidate implements those pull
requests; the independent review must verify that correspondence.

The validation job runs from the current trusted `main`, treats the candidate as data, repeats the
ledger and structural audit, and requires a successful Fork CI push run with the complete expected
job set for the exact branch and commit. Supplying `reviewed_sha` is the dispatcher's attestation that
the independent review covered those exact bytes. A successful validation requests approval through
the `upstream-intake-manual` environment; the Styal Porter credential is unavailable before approval.
Candidates that modify the fork-owned Fork CI workflow remain pull-request-only so they cannot define
the evidence used to promote themselves.

After approval, Styal Porter checks that neither `main` nor the candidate branch moved, checks
fast-forward ancestry again, and pushes the reviewed commit to `main` without force. Any movement
ends the run without updating `main`; rebase the candidate, rerun CI and review, then dispatch again.
After a successful push it requests an immediate `Upstream tracking` run. If that request fails, the
daily run provides the same idempotent reconciliation from `main` history.

The promotion lane requires these repository settings:

- The private `styal-porter` GitHub App is installed only on this repository with read access to
  Actions, checks, and commit statuses, plus read and write access to contents.
- The `upstream-intake-manual` environment is restricted to `main`, requires a maintainer review, and
  holds `STYAL_INTAKE_APP_ID` as a variable and `STYAL_INTAKE_APP_PRIVATE_KEY` as a secret.
- Pull-request and required-check rules are separate. Styal Porter may bypass the pull-request rule
  but not the required Fork CI checks. A separate rule blocks force pushes and has no bypass actors.

Do not create an automatic environment or promotion path until several manual promotions have shown
that the classifier, audit, review evidence, and operational recovery are sufficient.
