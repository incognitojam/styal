# Upstream intake

Bring upstream changes into the fork in their landing order. `.github/upstream-intake.json` records the last reconciled upstream commit (`baseline`), the fixed catch-up destination (`target`), and reasoned exceptions keyed by full upstream commit SHA. Nothing automatically syncs or writes to `main`.

## Inspect the gap

Use Git, an authenticated GitHub CLI (`gh`), and the repository's Node version. No additional dependency or service is needed. Refresh the local remote refs explicitly:

```bash
git fetch --no-tags origin main
git fetch --no-tags https://github.com/pingdotgg/t3code.git main:refs/remotes/upstream/main
node scripts/upstream-queue.ts status
node scripts/upstream-queue.ts next --count 20
node scripts/upstream-queue.ts explain 8321
```

Run the commands from the worktree root. `status` reports both fetched tips, the pinned baseline and target, the contiguous reconciled prefix, outstanding PR and commit counts, recorded imports, exceptions, and the number of upstream integrations beyond the target. `next` lists outstanding commits in first-parent order, taking the next 20 distinct PRs plus direct/unassociated commits before the next PR. A multi-commit PR keeps all of its outstanding commits. With fewer than 20 outstanding PRs, the remainder of the range is returned. With only direct commits remaining, all are returned.

`explain` accepts a PR number (with or without `#`) or an unambiguous commit prefix of at least seven characters within the current baseline..target range. It shows every matching source commit and its import evidence or exception reason. Add `--json` to any read command for structured output; `next --count 100000 --json` exports the full outstanding queue. The output includes full source SHAs for review and provenance. The commands do not fetch, check out branches, apply changes, or write to GitHub.

Git's first-parent history is the ordering authority, including non-PR merges and direct commits. Commit dates and PR titles are not used to infer order or ownership. GitHub's merged PR associations label each commit. Incomplete or ambiguous associations, a target inside a PR, and boundaries outside the first-parent chain stop the command rather than silently omit work. Non-PR merges represent the diff against their first parent. Empty diffs are labelled for inspection: never assume an adjacent commit implements an empty PR merge.

The first run reads PR associations in batches and caches them in ignored `.scratch/upstream-queue-*-prs.json` files, separately for each target. Later runs reuse them. Use `--refresh-metadata` to rebuild the cache when investigating changed GitHub metadata. `.scratch/` must be ignored; if necessary add it to `.git/info/exclude`, not the tracked `.gitignore`. `--state`, `--fork-ref`, and `--upstream-ref` support alternate local state files and refs. Normal use compares against `origin/main`, never unmerged work on the current branch.

## Reconcile the initial range

The initial baseline is the common ancestor `4c51b4c9b6a85d96a22e0df41d5cfd2d8fc9901d` (August 28, 2026). The initial target is `8dd02470b1e7603b8d36a21ae27c510480351f18`. This pins the catch-up range while upstream continues moving.

Recorded imports come from literal ancestry, `Upstream-PR:` and `Upstream-Commit:` trailers, escaped references beneath a `Source PRs:` heading, and exact `git cherry-pick -x` references in fork history. PR provenance covers that PR's associated commits; an explicit SHA or cherry-pick reference covers only that commit. These are evidence of an import, not proof of current patch equivalence. Review partial or adapted historical imports before advancing the baseline. A later revert does not erase provenance, so use the source and fork diffs when verifying such cases.

The old tracking issue, `incognitojam/styal#261`, remains available as historical evidence. The scheduled writer and rolling window have been removed. Read its visible reasons and notes during reconciliation. Its compacted terminal markers lost the distinction between imported and skipped sources, and sometimes their reasons; they are not imported as completion evidence. `UPSTREAM_TRACKING_ISSUE` and `UPSTREAM_TRACKING_WINDOW_DAYS` are no longer used. No issue edit or closure is needed to run the new tool.

If a source was incorporated without provenance, or must intentionally remain excluded, add an exception to the state file:

```json
"exceptions": {
  "<full upstream commit SHA>": {
    "disposition": "already present",
    "reason": "Implemented by fork commit <SHA>; verified the source behavior."
  }
}
```

Use `skip` for intentional exclusions, or `pending` to reopen an incomplete or reverted historical import despite its recorded provenance. Record the concrete fork invariant or maintainer decision and its reason. Decisions apply to individual commits, not ambiguous PR titles. Exceptions remain in the tracked file when the baseline advances. A skip may require adaptation of later upstream changes; chronological order only removes prerequisite selection when preceding changes are accounted for. Correct or remove an exception to undo a decision before advancing. Remove a `pending` exception after the missing work lands so its new provenance can reconcile normally.

## Prepare and land a batch

Start an `intake/<batch>` branch from current fork `main`, using `next --count 20` as the source list. Apply the listed first-parent changes in order. Inspect the upstream diff for each source; apply non-PR and PR merge commits against their first parent. Preserve upstream commits, authors, and implementation choices wherever possible. Keep fork adaptations small and identify the incompatibility or maintained fork invariant in their commit messages. Do not rebrand internals, refactor unchanged upstream code, or introduce unrelated fixes during intake.

For a complete chronological range, prerequisite selection comes from the range itself. Concentrate review on source completeness, fork conflicts, explicit exceptions, and the maintained fork feature ledger. If a prior source was skipped, inspect its effect on the dependent change. If a batch ends before a needed upstream correction, extend the chronological batch through that correction. Do not silently drop source behavior or write a substitute for an available upstream fix.

Every intake commit records a comma-separated `Upstream-PR: 1234, 5678` trailer, an `Upstream-Commit: <full lowercase SHA>` trailer, or both. Prefer recording exact commit sources as well as PRs for partial or multi-commit imports. Fork PR bodies retain these trailers in the squash commit. An exact `Source PRs:` section with one escaped `pingdotgg/t3code#1234` reference per list item is supported too. Keep upstream issue/PR references in backticks in GitHub prose to avoid cross-reference notifications.

Pushing an intake branch runs Fork CI on the full `main...candidate` diff. The existing intake audit checks provenance, fast-forward ancestry, absence of merge commits, and overlap with maintained fork features. Validate actual behavior where conflict resolution or adaptations change it, and at fork-specific integration boundaries such as migrations. Do not repeat upstream's full manual test plan for unchanged source code. Upstream migration files must be carried verbatim in a reviewed intake.

Use an ordinary reviewed fork PR, or the existing manual promotion lane below. Rebase standalone candidates when fork `main` advances; use `gh stack` for any actual stack. Never merge upstream into fork `main`, rebase fork `main` onto upstream, or force-push it.

After the batch lands, fetch `origin/main`, inspect `status` and `explain`, then advance to the reviewed batch boundary:

```bash
node scripts/upstream-queue.ts advance <full upstream commit SHA>
```

This edits only the local state file. It rejects unresolved preceding commits, out-of-range SHAs, and boundaries inside a multi-commit PR. Commit the state change through the normal review path. The baseline is an explicit record of reconciliation; it does not move merely because commits were discovered or a candidate branch exists. The command can verify recorded evidence, but human review must establish the completeness of historical adaptations and exceptions.

Once baseline equals target, pin a new target from fetched upstream `main`:

```bash
node scripts/upstream-queue.ts target <full upstream commit SHA>
node scripts/upstream-queue.ts next --count 20
```

`target` rejects backward movement, requires the previous target to be fully advanced, and verifies the new range's PR associations before writing. Commit the new target too. For a mistaken historical decision behind the baseline, deliberately move the baseline back in the reviewed state file and reconcile the reopened range; the routine `advance` command only moves forward.

## Existing manual promotion lane

The `Promote upstream intake` workflow remains available with its existing review and approval boundary. Give an independent model the candidate's complete diff, audit, and upstream source changes. Review source correspondence, omissions, fork compatibility, and adaptations. Resolve findings, rerun Fork CI if bytes change, and dispatch from `main` with the intake branch, exact independently reviewed `reviewed_sha`, and source PR/commit lists matching candidate provenance. Every candidate commit must name a source; explicit commit sources require source-diff review. Set `prerequisites_reviewed` after verifying chronological coverage and any exceptions affecting the batch.

Trusted validation runs from current `main`, repeats the audit, and requires the expected successful Fork CI jobs for that exact branch and SHA. Candidates changing `.github/workflows/fork-ci.yml` must use a PR. The `upstream-intake-manual` environment requires maintainer approval before the Styal Porter credential becomes available. After approval, promotion rechecks that `main` and the candidate have not moved, then fast-forwards without force. Movement stops promotion; rebase, rerun checks and review, and dispatch again. After landing, use the local queue to reconcile and advance the baseline.

Repository configuration for this lane remains:

- The private Styal Porter app is installed only on this fork with read access to Actions, checks and statuses, and read/write access to contents.
- The `upstream-intake-manual` environment is restricted to `main`, requires maintainer review, and holds `STYAL_INTAKE_APP_ID` and `STYAL_INTAKE_APP_PRIVATE_KEY`.
- Porter may bypass the PR rule, but not required Fork CI checks. Force pushes remain blocked with no bypass actors.

There is no automatic promotion lane.
