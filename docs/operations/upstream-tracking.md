# Upstream tracking

`main` is not synced with `pingdotgg/t3code`. Upstream changes are brought in deliberately, one or
more at a time. The `Upstream tracking` workflow keeps the list of candidates current; deciding what
to take, and dispatching the work, stays with a maintainer.

## The tracking issue

Once a day the workflow appends every upstream pull request merged in the last 45 days whose merge
commit is not an ancestor of `main` to the issue named by the `UPSTREAM_TRACKING_ISSUE` repository
variable. Each line is a checkbox, the merge date, the title, and the top-level areas it touched.
Lines already present are never rewritten, so ticked boxes and notes survive every run.

Ancestry is the only state. A pull request that was cherry-picked rather than merged keeps a
different commit id and would be listed again; leaving its line in the issue is what stops that, so
do not delete lines for work that has landed — tick them.

Nothing the workflow writes links to upstream or mentions anyone: numbers and titles are wrapped in
backticks and no URLs are rendered. Keep that property when annotating, so the issue never creates
cross-references or notifications on upstream's side.

## Preparing an intake candidate

Tick the boxes you want and add direction beneath each — what to keep of the fork's behaviour, which
related changes to take together, or why to skip. Then dispatch an agent with the ticked items and
those notes as its brief.

Routine candidates use an `intake/<batch>` branch based on the current `main`. Preserve the individual
upstream commits and their authors where they apply cleanly; a port may use fork-authored commits when
the implementation must differ. Do not merge `main` into the branch. If `main` moves, rebase the
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
`intake/<batch>` branch and that exact commit id as `reviewed_sha`.

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

The promotion lane requires these repository settings:

- The private `styal-porter` GitHub App is installed only on this repository with read access to
  Actions, checks, and commit statuses, plus read and write access to contents.
- The `upstream-intake-manual` environment is restricted to `main`, requires a maintainer review, and
  holds `STYAL_INTAKE_APP_ID` as a variable and `STYAL_INTAKE_APP_PRIVATE_KEY` as a secret.
- Pull-request and required-check rules are separate. Styal Porter may bypass the pull-request rule
  but not the required Fork CI checks. A separate rule blocks force pushes and has no bypass actors.

Do not create an automatic environment or promotion path until several manual promotions have shown
that the classifier, audit, review evidence, and operational recovery are sufficient.
