# Upstream intake

**Queue → apply in order → validate the batch → promote without a PR → advance the baseline.**

Use an `intake/<batch>` branch based on fork `main`. Preserve upstream authorship, commit messages, and chronological order, adding provenance and the smallest necessary fork adaptations. Publish the branch for CI, then fast-forward `main` to its reviewed tip through **Promote upstream intake**. Do not open a PR for the batch or squash it: retaining upstream history is valuable, and attaching those commits to a PR creates unwanted upstream cross-references and participants.

Nothing automatically syncs upstream or authorizes a promotion. Dispatch only when the maintainer explicitly requests it.

## 1. Choose the next batch

From the worktree root:

```bash
git fetch --no-tags origin main
git fetch --no-tags https://github.com/pingdotgg/t3code.git main:refs/remotes/upstream/main
node scripts/upstream-queue.ts status
node scripts/upstream-queue.ts next --count 20
```

The state in `.github/upstream-intake.json` has three parts:

- **Baseline:** the upstream commit through which reconciliation has been completed. Initially the common ancestor; subsequently an explicitly reviewed boundary.
- **Target:** the fixed upstream destination for this catch-up. It does not move when upstream receives new commits.
- **Exceptions:** specific commits already present, intentionally skipped, or reopened as pending, with reasons.

Normal commands compare against fetched `origin/main`, not the current branch. `next --count 20` selects the next 20 distinct outstanding PRs, plus intervening direct commits, in upstream first-parent order. Multi-commit PRs stay together. Twenty is a starting point, not a quota: inspect nearby reverts, corrections, and refactors before choosing a coherent boundary. Extend through a needed correction; stop before an independently substantial integration when appropriate.

During initial catch-up, later upstream changes may already be present in the fork. Chronological intake removes prerequisite selection only when earlier changes are accounted for; it does not eliminate conflicts with those later imports or maintained fork differences.

## 2. Apply in order

Create the candidate from current `origin/main`, then apply the selected commits:

```bash
git switch -c intake/<batch> origin/main
git cherry-pick -x <upstream-commit>
```

Apply upstream merge commits against their first parent (`git cherry-pick -m 1 -x`), rather than introducing merge commits into the candidate. Preserve each source commit where possible. Keep conflict adaptations small and explain the fork invariant they preserve. Do not replace upstream implementations, rename unchanged internals, or squash the batch for publication.

Follow upstream behavior by default. General guidance inherited from upstream is not a separate fork requirement or a reason to redesign an upstream change during intake. Record deliberate styal-specific policies and maintained divergences in the fork feature ledger (with supporting documentation where needed); do not invent new differences while resolving conflicts.

Every candidate commit needs an `Upstream-PR: 1234, 5678` and/or `Upstream-Commit: <full lowercase SHA>` trailer. Record exact SHAs for partial or multi-commit imports, including alongside PR provenance when the commit identity matters. `Upstream-Commit` is therefore not limited to direct commits. A verified empty import may use a provenance-only commit; do not infer completeness merely because a cherry-pick is empty.

Read the actual source diffs when reconciling reverts or already-present work. If an exact change/revert pair is accounted for together, verify its net effect and record both sources; do not silently skip either. Existing provenance proves an import was recorded, not that today's tree still has equivalent behavior.

## 3. Validate the final batch

Do not run the full validation loop after every cherry-pick. Test intermediate states only when needed to diagnose a problem or bisect.

Review `origin/main...candidate` against the upstream sources and the fork feature ledger. Focus local tests and real-client checks on conflict resolutions, changed behavior, and fork integration boundaries. In particular, preserve styal's runtime homes, environment variables, browser storage, installed-app identity, and maintained capabilities. These are behavioral invariants, not a reason to mechanically replace every upstream name. Carry upstream migration files verbatim.

```bash
node scripts/upstream-queue.ts status --fork-ref intake/<batch>
vp run --filter @t3tools/scripts intake:check -- --base origin/main --head intake/<batch>
git push -u origin intake/<batch>
```

The successful local audit prints the candidate's promotion command. Pushing the branch runs Fork CI. Review the combined batch once, including source completeness, relevant exceptions, fork compatibility, and observed behavior. Do not repeat upstream's entire manual test plan for unchanged code.

## 4. Promote without a PR

The existing `Promote upstream intake` workflow is the landing path. Its current safeguards remain in force:

1. Finish the combined-batch review described above and require successful Fork CI for the exact candidate SHA.
2. When authorized, run the promotion command printed by the final local audit. It dispatches the workflow **from main** with the candidate branch and exact SHA.
3. Set `prerequisites_reviewed` after checking chronological coverage and exceptions. Approve the `upstream-intake-manual` environment when requested.
4. The workflow rechecks both tips, then fast-forwards `main` without force. Verify the resulting SHA and ensuing CI.

If `main` or the candidate moves, rebase the standalone intake branch as needed, rerun affected validation and CI, and review the new SHA before dispatching again. Never rebase `main` onto upstream or force-push it.

**Current exception:** promotion rejects candidates changing `.github/workflows/fork-ci.yml`. Stop and arrange a separately authorized maintainer change; do not open a PR containing the upstream batch as a workaround.

These instructions simplify the working flow, not the workflow's permissions. Candidate review, exact-SHA CI, and environment approval still apply. Styal Porter receives its write credential only after approval.

## 5. Record progress and repeat

After promotion, fetch `origin/main`, verify the batch is accounted for, and advance to the reviewed upstream boundary:

```bash
git fetch --no-tags origin main
node scripts/upstream-queue.ts status
node scripts/upstream-queue.ts advance <full-upstream-boundary-SHA>
```

`advance` edits only the local state file and rejects unresolved preceding commits or a boundary inside a multi-commit PR. Commit that state change through the normal maintainer review path, separately from the preserved upstream batch. A state-only PR must not include the intake commit history.

Once baseline equals target, choose a new destination from fetched upstream and repeat:

```bash
node scripts/upstream-queue.ts target <full-new-target-SHA>
node scripts/upstream-queue.ts next --count 20
```

Commit the target change too. Neither command promotes code.

## Queue reference and exceptions

- `explain <PR-number-or-SHA-prefix>` shows sources and import evidence. SHA prefixes must be unambiguous and at least seven characters.
- `--fork-ref intake/<batch>` inspects a candidate; `--state` and `--upstream-ref` select alternate local inputs.
- `--json` provides structured output for queue commands.
- PR associations are cached in the primary checkout's ignored `.scratch/`, shared across worktrees and saved incrementally. Use `--refresh-metadata` to rebuild them.
- Recorded evidence includes ancestry, provenance trailers, cherry-pick references, and historical `Source PRs:` sections. Incomplete or ambiguous associations stop the queue.
- The old tracking issue is historical context only; its terminal markers are not completion evidence. The queue does not write to GitHub.

Exceptions are keyed by full source SHA:

```json
"exceptions": {
  "<full upstream commit SHA>": {
    "disposition": "already present",
    "reason": "Implemented by fork commit <SHA>; verified the source behavior."
  }
}
```

Use `skip` for an intentional exclusion or `pending` to reopen an incomplete or reverted import. Explain the specific reason, review effects on subsequent sources, and remove a `pending` exception after the missing work lands. Exceptions survive baseline advancement. Reopening a decision behind the baseline requires deliberately moving the baseline back in the reviewed state file.
