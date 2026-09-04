# Upstream tracking

`main` is not synced with `pingdotgg/t3code`. Upstream changes are brought in deliberately, one or
more at a time, as ordinary pull requests. The `Upstream tracking` workflow keeps the list of
candidates current; deciding what to take, and dispatching the work, stays with a maintainer.

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

## Bringing a change in

Tick the boxes you want and add direction beneath each — what to keep of the fork's behaviour, which
related changes to take together, or why to skip. Then dispatch an agent with the ticked items and
those notes as its brief. The resulting pull request should name the upstream numbers it carries in
backticks. Fork CI reports when the resulting pull request touches paths watched by the fork feature
ledger, regardless of whether the upstream work was merged, cherry-picked, squashed, or ported by
hand. The reviewer must also inspect upstream source changes that the resulting diff intentionally
leaves out. Upstream migration files may only change in such a pull request, carried verbatim.
