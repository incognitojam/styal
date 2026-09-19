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
intake commits both count. Each source-section list item must contain only its escaped reference.
Other upstream references in commit prose do not. When provenance names a listed pull request, the
tracker checks it and adds `— promoted \`abcdef0\``. Promotion overrides a non-terminal disposition
when its state is `review needed`. It leaves terminal dispositions unchanged. This recognizes
rebased, cherry-picked, modified, and squashed ports without guessing from patch similarity. Work
promoted before provenance tracking does not reconcile automatically; mark its source rows
`already present` once.

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

For an initial catch-up, set the repository variable or manually dispatch a window wide enough to
reach the known divergence boundary. The 14-day default may no longer reach that boundary. Keep the
window wide enough during triage, and tick unresolved items that must survive the eventual narrower
window. Zero deferred candidates means all candidates fit in the issue, not that they have all been
triaged. Once catch-up and triage are complete, set `UPSTREAM_TRACKING_WINDOW_DAYS` to the desired
steady-state window. Seven days is a practical starting point; it is an operating choice rather than
a completeness boundary.

The upstream scan stops after at most 20 pages. If it cannot reach the requested boundary within that
limit, the run fails before updating the issue or clearing catch-up state. Resolve the scan limit
before retrying; narrowing the window would omit part of the requested catch-up.

A gap longer than the scan window can miss upstream merges. Recover by manually dispatching the
workflow with a temporarily wider `since_days` value. If that scan defers candidates, its boundary
remains pinned across subsequent daily runs until catch-up finishes. A recovery scan can briefly
relist old unqueued or terminal items because the bounded issue does not retain permanent tombstones.
To intentionally abandon a pinned catch-up, delete the hidden `upstream-tracking-catchup-since`
marker from the issue body; the next run uses the configured window again.

The issue update is a full-body write. Avoid editing it during a running tracker job; a manual edit in
the short interval between the workflow's read and write can be overwritten.

Nothing the workflow writes links to upstream or mentions anyone: numbers and titles are wrapped in
backticks and no URLs are rendered. Keep that property when annotating, so the issue never creates
cross-references or notifications on upstream's side.

## Commits outside the PR inventory

The same workflow walks upstream `main`'s first-parent history. The first run starts at the common
ancestor of fork `main` and upstream `main`; subsequent runs start at the hidden
`upstream-tracking-commit-scan-head` SHA in the issue body. This scan follows ancestry, not commit
dates: a commit made months ago and pushed today must still be considered. The saved SHA advances
only when the complete scan and issue update succeed. A history rewrite or a saved SHA outside the
first-parent chain stops the run for maintainer review.

PR merge commits are represented by the PR inventory. For other commits, the tracker checks GitHub's
PR associations and suppresses an extra entry only when a merged PR is represented in that same
inventory. Anything still unaccounted for gets a `commit:<full SHA>` row, initially marked
`review needed`. These rows are observations of missing PR coverage, not proof that a maintainer
pushed directly. Release bumps and automation changes are included for explicit triage.

Unresolved commit entries neither expire nor defer during compaction, even if their review label is
removed. Resolve them with `skip`, `already present`, or a promoted port. If durable entries exceed
the issue budget, the update fails and the saved scan head does not advance. Once resolved, rows may
compact normally; the saved head prevents rediscovery. Resetting that head can rediscover older
decisions whose compact state has already been discarded, so review a proposed reset first.

An empty PR merge diff is marked `review needed` as well. Inspect the PR's source changes and the
surrounding upstream history rather than assuming its recorded merge SHA contains the implementation.
The tracker never assigns preceding commits to a PR based on proximity or a PR number in a subject.
For a non-PR merge, the commit row represents the diff against its first parent; commits reachable
only through its other parents are not individually listed.

Commit entries reconcile from full `Upstream-Commit:` trailers in fork `main`, literal ancestry, or
the exact SHA recorded by `git cherry-pick -x`. A PR trailer alone does not resolve a separate commit
entry. Commit discovery follows the saved SHA, while classification needs the PR inventory to cover
the scanned range. After a long outage or an initial scan with a narrow PR window, a reachable merged
PR outside that inventory stops the run with its number and merge date. Widen `since_days` to include
that date and retry; the issue and commit scan head remain unchanged on failure. Narrowing the PR
window never expires unresolved commit entries.

## Preparing an intake candidate

Tick the boxes you want and add direction beneath each — what to keep of the fork's behaviour, which
related changes to take together, or why to skip. Then dispatch an agent with the ticked items and
those notes as its brief.

Routine candidates use an `intake/<batch>` branch based on the current `main`. Inspect each source and
its direct upstream prerequisites, corrections, and follow-ups before preparing the candidate. Take a
coherent group when upstream has already supplied the correction instead of recreating that fix in the
fork.

For every source, inspect its actual merge or squash commit against its first parent, not only the pull
request description. Treat identifiers, files, and behavior that its patch changes or removes as
possible prerequisites. If any are absent from the fork, trace their introduction with upstream history
and blame, then check the tracker for that source. Intake the prerequisite first, or stop and cite its
recorded skip decision; do not silently resolve the conflict by deleting the dependent change or by
writing a compensating fork adaptation. Repeat this check after conflict resolution by comparing the
candidate with every source diff and accounting for anything the candidate leaves out.

Apply upstream commits unchanged whenever they apply. Preserve their individual commits and authors,
including internal names and implementation choices that do not affect a documented fork difference.
Do not use routine intake to rebrand internals, refactor the upstream implementation, add speculative
coverage or documentation, or fix unrelated defects. Upstream has already reviewed and tested this
code; Fork CI establishes whether those unchanged commits integrate with the fork.

A fork-authored adaptation is appropriate only when the upstream change cannot apply, build, or run
against the fork, or when it would break an explicit maintainer direction or an invariant recorded in
the fork feature ledger. Keep the adaptation as small as possible and in a separate commit after the
upstream commits. Its commit message must identify the concrete incompatibility or preserved invariant.
If a direct upstream follow-up supplies the needed fix, intake that source rather than writing a local
substitute. Product naming alone does not justify changing internal or otherwise non-user-facing details.

Every intake commit records its source in commit metadata with a comma-separated trailer such as
`Upstream-PR: 1234, 5678`, `Upstream-Commit: <full SHA>, <full SHA>`, or both. Commit SHAs must be
complete, lowercase, 40-character values. Fork pull requests may list escaped
`pingdotgg/t3code#1234` references beneath an exact `Source PRs:` section because this repository
retains the body in the squash commit; retain `Upstream-Commit:` lines there for commit sources. Do not
merge `main` into the branch. If `main` moves, rebase the candidate and validate it again before
promotion.

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

Review and validation should concentrate on source completeness, direct upstream fixes, conflicts with
the current fork, ledger invariants, and any fork-authored adaptation. Do not repeat upstream's full
manual or platform test plan for unchanged commits. Add targeted local validation only when a conflict
resolution or fork adaptation changes behavior, or when the candidate touches a migration or another
fork-specific integration boundary that Fork CI cannot establish.

## Manual promotion

Before dispatching promotion, give an independent model the candidate's complete `main...candidate`
diff, its audit report, and the upstream changes it is meant to carry. The review verifies source
correspondence, intentional omissions, fork compatibility, and the necessity and scope of every
fork-authored adaptation. It does not re-review unchanged upstream implementation choices. Resolve
findings within that boundary, rerun Fork CI when the candidate bytes change, and copy the full
candidate commit id. Dispatch `Promote upstream intake` from `main` with the `intake/<batch>` branch,
that exact commit id as `reviewed_sha`, and the comma-separated source pull request numbers as
`source_prs` and/or full commit SHAs as `source_commits`. At least one source is required. Trusted
validation requires both lists to exactly match the candidate's commit provenance; leaving an input
empty asserts that it has no sources of that kind. Every candidate commit must name a PR, a commit SHA,
or both. Explicit commit sources always require manual source-diff review. This is durable bookkeeping,
not proof that the candidate implements those sources; the independent review must verify that
correspondence.

Set `prerequisites_reviewed` only after the source-assumption and post-conflict checks above are
complete. Promotion rejects a dispatch without that explicit attestation.

The validation job runs from the current trusted `main`, treats the candidate as data, repeats the
ledger and structural audit, and requires a successful Fork CI push run with the complete expected
job set for the exact branch and commit. Supplying `reviewed_sha` is the dispatcher's attestation that
the scoped independent review covered those exact bytes. A successful validation requests approval
through the `upstream-intake-manual` environment; the Styal Porter credential is unavailable before
approval.
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
