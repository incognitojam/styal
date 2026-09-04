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
and conservatively identifies changes that need a maintainer decision. Automation, dependencies,
migrations, contracts, authentication, user-facing clients, and ledger overlap all require manual
review. A candidate outside those categories is reported as eligible for eventual automatic
promotion.

The audit is currently report-only: it never writes to `main`. Until the dedicated intake App,
independent model review, protected approval environment, and split rulesets are configured, finish a
candidate through an ordinary fork pull request. Name any routine upstream pull requests or issues it
carries in backticks. The reviewer must also inspect upstream source changes that the resulting diff
intentionally leaves out. Upstream migration files may only change in a reviewed intake, carried
verbatim.
