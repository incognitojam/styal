# Upstream intake

**Queue → apply in order → validate the batch → promote without a PR → advance the baseline.**

Use an `intake/<batch>` branch based on fork `main`. Preserve upstream authorship, commit messages, and chronological order, adding provenance and the smallest necessary fork adaptations. Publish the branch for CI, then fast-forward `main` to its reviewed tip through **Promote upstream intake**. Do not open a PR for the batch or squash merged upstream history: retaining that history is valuable, and attaching those commits to a PR creates unwanted upstream cross-references and participants. An explicitly requested import of an open PR uses one provisional snapshot commit, as described under [early imports](#early-imports).

Nothing automatically syncs upstream. Pushing an intake branch starts promotion once Fork CI passes, and a candidate that clears every automatic gate lands without approval (see [step 4](#4-promote-without-a-pr)), so push a candidate only when it is ready to land. A candidate with a `Fork adaptation:` note always waits for approval, which is what lets its review finish while Fork CI runs (see [step 4](#4-promote-without-a-pr)).

While an intake branch runs Fork CI or waits for promotion, the **Intake landing hold** workflow sets a pending `Intake landing hold` status on every open pull request, including the upper layers of a stack, which GitHub checks against `main`'s rules. The status is one of `main`'s required checks, so those pull requests cannot merge and move `main` under the candidate; pull requests set to auto-merge land once the hold lifts. The hold lifts when the promotion run finishes, however it ends, or 10 minutes after the branch's newest Fork CI run fails, so a fixed push can start before queued auto-merges move `main`. To lift it for a candidate you will not land, cancel its Fork CI run or reject its waiting promotion. The workflow can wait minutes for a runner, so push candidates with `intake-run.ts push` (or `auto --push`), which sets the hold as soon as the candidate's Fork CI run exists and prints that run's link. If a merge still moves `main` before the hold starts, Fork CI fails within a minute, naming the commits `main` gained. Each run of the workflow recomputes the hold from workflow runs; dispatch it if a status looks stale. Pushes that bypass pull requests, such as the nightly mobile version bump, are not held.

## 1. Choose the next batch

From the worktree root:

```bash
git fetch --no-tags origin main
git fetch --no-tags https://github.com/pingdotgg/t3code.git main:refs/remotes/upstream/main
node scripts/upstream/queue.ts status
node scripts/upstream/queue.ts next --count 20
```

The state in `.github/upstream-intake.json` has three parts:

- **Baseline:** the upstream commit through which reconciliation has been completed. Initially the common ancestor; subsequently an explicitly reviewed boundary.
- **Target:** the fixed upstream destination for this catch-up. It does not move when upstream receives new commits.
- **Exceptions:** specific commits already present, intentionally skipped, or reopened as pending, with reasons.

For upstream changes worth watching, add an entry to `.github/upstream-tracked-prs.json` with the PR number and a `reason`: what the fork is waiting on it for, such as a blocked fork change or a bug users hit. Write a fork PR as "fork #123"; a bare number is an upstream PR. Both reports show the reason next to the PR. `status` reads current upstream PR metadata and reports each tracked change as open, closed, pending, recorded, skipped, or awaiting a fresh upstream fetch. A provisional import also records a `snapshot` with its reviewed upstream base and head SHAs; a closed PR with a snapshot is reported as "review closed import". Pending entries show how many days their upstream merge is ahead of the fork's last reconciled upstream integration, and whether they fall beyond the fixed target. A recorded import is evidence of intake, not proof that the behavior still works. Remove an ordinary watch entry once recorded or no longer relevant; remove a snapshot only after reviewing its final outcome as described below. Snapshot markers keep the eventual upstream integration pending despite PR provenance. The list does not change queue order or authorize early intake.

The daily **Upstream lag report** workflow includes the tracked PR table in its run summary. **Promote upstream intake** also writes a projected lag report, divergence comparison, and tracked PR table during candidate validation, using the exact candidate SHA. These reports are informational and do not gate promotion. To print the table locally, run `node scripts/upstream/tracked-prs-report.ts` after fetching both repositories.

Normal commands compare against fetched `origin/main`, not the current branch. `next --count 20` selects the next 20 distinct outstanding PRs, plus intervening direct commits, in upstream first-parent order. Multi-commit PRs stay together. Twenty is a starting point, not a quota: inspect nearby reverts, corrections, and refactors before choosing a coherent boundary. Extend through a needed correction; stop before an independently substantial integration when appropriate.

During initial catch-up, later upstream changes may already be present in the fork. Chronological intake removes prerequisite selection only when earlier changes are accounted for; it does not eliminate conflicts with those later imports or maintained fork differences.

To see how far fork `main` trails upstream over time, run `node scripts/upstream/lag-report.ts`. It prints a Markdown report with Mermaid charts of upstream merges against the in-order tip reported by `status`, separates in-order imports from early ones, and estimates a catch-up date from the last three days of progress. The **Upstream lag report** workflow publishes the same report to its run summary daily and on manual dispatch.

To see how much the fork differs from upstream, run `node scripts/upstream/divergence-report.ts`. It compares fork `main` with upstream at the in-order tip, so upstream work not yet taken in does not count, and excludes `.repos/` and `pnpm-lock.yaml`. It separates upstream files the fork changes or removes from fork-only files, and charts both daily. In-order intake leaves the numbers flat unless a conflict drops a fork change; fork pull requests and early imports raise them. The lag report workflow publishes it daily, promotion validation writes a projected comparison of `main` with the candidate, and the **Upstream divergence comment** workflow posts the change on each fork pull request. Pass `--base <ref> --head <ref>` to compare two fork commits locally.

Early imports are covered [below](#early-imports).

## 2. Apply in order

Create the candidate from current `origin/main`, then apply the selected commits:

```bash
git switch -c intake/<batch> origin/main
git cherry-pick -x <upstream-commit>
```

`scripts/upstream/intake-run.ts` applies a selection in queue order and does the mechanical work, so review starts from what needs judgment:

```bash
node scripts/upstream/intake-run.ts apply --through <full-upstream-SHA> --branch intake/<batch>
node scripts/upstream/intake-run.ts continue --note "<what differs and why>" --feature <ledger-id>
node scripts/upstream/intake-run.ts fix-references
node scripts/upstream/intake-run.ts fix-trailers
node scripts/upstream/intake-run.ts verify
```

`apply` cherry-picks each commit with diff3 conflict markers and its provenance trailer. It resolves a hunk only when the fork's side is explained: the fork's text is upstream's base with styal renames, upstream's side only renames identifiers the fork's side also uses, or one or both sides only add lines around an unchanged base. It also regenerates and pins the lockfile, pins each package upstream starts patching in `pnpm-workspace.yaml` `overrides` (the fork pins every patched package so lockfile-free release installs keep the patch; upstream does not), gives new service keys the fork's package name, points ledger paths at files the pick moves, and drafts the `Fork adaptation:` note and `Fork-Feature` trailer for those changes. A hunk that combines both sides' added lines is reported for review, because about one in seven combines two versions of the same change. `apply` stops on any other hunk with the conflict in place; resolve and stage it, then `continue` with the note and features it needs. It gives upstream's names in the pick's new strings the fork's names (`T3 Connect` to `styal Link`, `T3 Code` and `T3` to `styal`), along with the pick's test assertions that quote them, and lists what it cannot rename: t3.codes links, user guide text, and strings that identify something rather than say something (compared values, keys, keychain and channel names such as `T3 Code (Beta)`). When a hunk still conflicts and upstream's commit renames identifiers in that file, `apply` merges the file again with those renames applied to the fork's version and the base, and keeps the result if fewer hunks remain. `fix-references` typechecks the packages the batch touches and fixes fork references to names and modules the batch's upstream commits renamed or moved, committing each fix into the pick that made it necessary and noting the files; renames to a bare `layer` without an import, and names the file already declares, stay for a person. `fix-trailers` drops `Fork-Feature` from commits that turn out to match upstream and lists differing commits without a note. `verify` installs once, then typechecks every package the batch touches, lints and format-checks changed files, runs the test files the batch changes and the test files that import a changed file directly, and checks the ledger, without the server settings a styal session passes to its agents. `verify --quick` skips the tests. Whole suites, which catch fork tests that an upstream change breaks without editing them, run in Fork CI, which promotion requires; `verify --all-tests` runs them locally. `fingerprint [--base <ref>]` compares the mobile native fingerprint before and after the batch, and the batch's fingerprint with the newest Android release's runtime version; Fork CI runs it on every intake push. When the batch differs from that release, OTA updates from main stop reaching installed apps after promotion, even if an earlier batch moved the fingerprint, until Mobile EAS Production finishes the builds it starts for the new fingerprint.

`intake-run.ts auto --branch intake/<batch> [--max <n>] [--push]` picks the batch itself: it applies the queue in order from `origin/main` and ends the batch before the first commit that needs a person, or once it holds `--max` commits (30 by default). A commit needs a person when `apply` would stop on it or ask to review it, when it adds an upstream name the driver cannot rename, or when it differs from upstream without a fork note. A batch never ends inside a pull request. It then runs `fix-references`, `fix-trailers`, and `verify`, and with `--push` pushes the branch as `push` does. When the first commit already needs a person, it is left staged for `continue`, as `apply` leaves a stop.

`intake-run.ts survey [--base <ref>] [--count <n>]` applies the next queue entries from `--base` (default `HEAD`, such as the top of an unpromoted stack) in a scratch worktree and lists the commits that will need a person, with the reasons `auto` would stop for and the fork features each touches. A stopped pick takes upstream's side so the survey continues, and rerere stays off so none of those guesses is recorded. Use it to start conflict work on later commits, for example in separate worktrees, before the batch reaches them. It also lists commits that change lint rules or their configuration: lint the whole repository on the batch's clean picks as soon as they are applied, and treat violations in fork-only code as conflict work, rather than finding them after assembly.

`survey` also lists later fix and revert commits, up to fetched `upstream/main`, whose commit message or PR description names a surveyed commit by PR number or reverted SHA, and quotes the sentence that names it. Check each one before the batch lands. When it fixes a regression the batch introduces, extend the batch through it if it is close, [import it early](#early-imports) (inside the batch, with an `Early-Import` trailer), or port it by hand in a fork pull request and track the upstream PR with a reason saying so. A flagged follow-up that fixes no regression needs nothing.

`intake-run.ts replay <promoted-SHA> --dump <dir>` reruns a promoted batch from each commit's real parent, without recorded resolutions, and compares the result with what was committed; `intake-run.ts score <dir>` scores the current resolvers against those dumps. Use both before changing a resolver.

Apply upstream merge commits against their first parent (`git cherry-pick -m 1 -x`), rather than introducing merge commits into the candidate. Preserve each source commit where possible. Keep conflict adaptations small and explain the fork invariant they preserve. Do not replace upstream implementations, rename unchanged internals, or squash the batch for publication.

Follow upstream behavior by default. General guidance inherited from upstream is not a separate fork requirement or a reason to redesign an upstream change during intake. Record deliberate styal-specific policies and maintained divergences in the fork feature ledger (with supporting documentation where needed); do not invent new differences while resolving conflicts.

A conflict is a prompt to reconsider the fork's side, not a reason to keep it. Before resolving one, find where the fork's lines came from with `git log -S` or `git blame` on `origin/main`:

- From an upstream import, carrying an `Upstream-PR` or `Upstream-Commit` trailer: resolve to the code upstream has once both changes are applied.
- From a fork change the [fork feature ledger](../internals/fork-feature-ledger.md) records: keep it while its invariants still require it, rebuilt on upstream's new code, or retire it as the ledger guide describes.
- From a fork change the ledger does not record: read its pull request to decide whether the difference was deliberate. Add a ledger entry with a `rationale` for a difference worth keeping; otherwise take upstream's code.
- Formatting, import order, or other incidental differences: take upstream's code.

Decide when the evidence is clear. Ask the maintainer when the intent remains unclear or the choice changes what users see.

Rebuilding a recorded capability can leave part of it behind, for example when upstream deletes the code that part lived in. Dropping that part is retirement only when upstream's code satisfies the invariant, as the entry's existing tests show. Otherwise, do not narrow the invariant or delete or weaken its tests yourself: raise the gap in the batch's decision list (see [Running a batch with agents](#running-a-batch-with-agents)), not only in the `Fork adaptation:` note, and hold that commit until the maintainer answers. If they accept it, narrow the invariant and tests in that commit, open a fork issue to restore the part, and link the issue from the note. An invariant about code upstream removed, with no remaining behavior to keep, needs neither.

A commit whose change differs from upstream's needs a `Fork adaptation:` paragraph saying what differs and why, and a `Fork-Feature: <ledger-id>, <ledger-id>` trailer naming the ledger entries it preserves. The intake audit blocks a differing commit without a note, a commit that matches upstream but cites a feature, and a feature ID the ledger does not list. A differing commit without `Fork-Feature`, such as one shaped by an early import, requires manual review. A note on a matching commit remains useful when it records that a fork change was dropped in favor of upstream's.

Every candidate commit needs an `Upstream-PR: 1234, 5678` and/or `Upstream-Commit: <full lowercase SHA>` trailer. `Upstream-PR` identifies a PR's change, including a provisional open-PR snapshot; it does not complete reconciliation while a snapshot marker remains. Never repeat that PR's own SHAs in `Upstream-Commit`; the intake audit looks up each `Upstream-Commit` beside `Upstream-PR` on GitHub and blocks repeats. Use `Upstream-Commit` for direct upstream commits and commits from other PRs folded into the same change. A verified empty import may use a provenance-only commit; do not infer completeness merely because a cherry-pick is empty.

The intake audit blocks a candidate that records a queue source while an earlier entry stays pending, and lists the skipped entries and the commits that record later sources. Recorded, `skip`, and `already present` entries count as accounted for; an entry behind a snapshot marker or a `pending` exception does not. Sources after the state file's target are outside the queue and are not checked. Declare an intentional [early import](#early-imports) with an `Early-Import: <reason>` trailer on each commit that imports the early source, on its own `intake/upstream-<PR>` branch or inside a batch, such as a later upstream fix for a regression the batch introduces.

Read the actual source diffs when reconciling reverts or already-present work; never assume an adjacent commit implements a source. If an exact change/revert pair is accounted for together, verify its net effect and record both sources; do not silently skip either. Existing provenance proves an import was recorded, not that today's tree still has equivalent behavior.

A conflict can show that an earlier import, often an early one, took a different revision of a PR than the one upstream merged, while its provenance marks the PR as recorded. When the incoming change builds on the missing parts, reconcile them in a separate commit placed before it. Give that commit the PR's `Upstream-PR` trailer and a `Fork adaptation:` note naming the earlier import, and limit it to what the incoming change needs.

Upstream's direct release commits (`chore(release): prepare vX.Y.Z`) bump package versions and can touch the lockfile. Take the version bumps, keep the fork's package names and lockfile, and cite `fork-distribution-identity`.

When an upstream change adds, removes, or bumps dependencies and the lockfile conflicts, keep the fork's lockfile and regenerate it with `pnpm install --lockfile-only`. In the `Fork adaptation:` note, name any package that resolves to a different version than upstream's.

Keep upstream files the fork does not use identical to upstream, such as `.github/workflows/release.yml`, which is disabled in favour of the fork's own release workflows. When an import adapts an upstream change into a fork-owned file instead of the file upstream changed, apply upstream's change to its own file too. Otherwise that file drifts, and later upstream commits to it conflict. The disabled `.github/workflows/ci.yml` is the exception: Fork CI (`fork-ci.yml`) runs its checks, and promotion rejects candidates that change `fork-ci.yml`. When a batch changes a check in `ci.yml`, port it to `fork-ci.yml` in a separate maintainer pull request after promotion.

## 3. Validate the final batch

Do not run the full validation loop after every cherry-pick. Test intermediate states only when needed to diagnose a problem or bisect.

Review `origin/main...candidate` against the upstream sources and the fork feature ledger. Focus local tests and real-client checks on conflict resolutions, changed behavior, and fork integration boundaries. In particular, preserve styal's runtime homes, environment variables, browser storage, installed-app identity, and maintained capabilities. These are behavioral invariants, not a reason to mechanically replace every upstream name. Carry upstream migration files verbatim.

A cherry-pick that applies cleanly can still break fork code it does not touch: upstream may rename an export that a fork-only file still calls, or add a lint rule that fork-only files break. Before pushing, typecheck and lint each package the batch changes as a whole, not only the changed files; `intake-run.ts verify --quick` does this. Fork CI runs the related tests and the whole suites, so push once the quick checks pass and review while it runs; run `verify` locally only to diagnose a failure.

New upstream strings often name T3 Code, T3 Connect, t3.codes, or just T3 ("the T3 server", "T3's browser"). `verify` and Fork Lint run `naming:check`, which fails on those names in application and package strings outside tests. The driver renames them as it applies each pick; `naming:check --fix` does the same for a tree. Read the renamed wording in review, since a mechanical rename can read oddly. When the upstream name is correct (such as importing from T3 Code), add the file to `UPSTREAM_NAMING_EXCEPTIONS` in `scripts/upstream-naming.ts` with the reason.

Upstream's new tests describe upstream's behavior, so a failure can show a fork difference that no conflict touched; trace it as you would a conflict before choosing between the fork's code and the test. Fold each fix into the commit that introduced the break, with a `Fork adaptation:` note, rather than adding a commit of its own.

When a batch changes MCP toolkits, provider tool identity, or `t3McpToolPresentation`, run `vp test run apps/server/src/mcp/toolkits/core.test.ts apps/server/src/mcp/toolkits/toolPresentation.test.ts`. These checks start from the published catalog, exercise provider mappings for both session namespaces, and compare web and mobile wording through completed, running, failed, declined, and stopped states. A new preview tool requires a short label in `styalToolWording`; retired wording and argument customizations fail the guard.

Also inspect the catalog in real clients. Start an isolated dev server once to run migrations, then stop it and seed synthetic projection data:

```bash
mkdir -p .scratch/tool-wording-workspace
node apps/server/scripts/seed-tool-presentation-fixture.ts --base-dir .styal --workspace-root .scratch/tool-wording-workspace
vp run dev
```

Open the **Tool wording fixtures** project using `test-styal-app` and `test-styal-mobile`. Compare the provider and namespace threads, expanded tool rows, collapsed summaries, browser/device icons, interaction arguments, and failed/stopped examples. Retain screenshots with the intake evidence. The fixture never executes tools and is for visual verification only; its projection writes do not establish backend behavior.

```bash
node scripts/upstream/queue.ts status --fork-ref intake/<batch>
vp run --filter @t3tools/scripts intake:check -- --base origin/main --head intake/<batch>
```

The successful local audit inspects the remote branch and reports the next action: push the candidate, watch Fork CI, address a failed run, or approve the promotion that Fork CI started. Rerun the audit after completing the reported step. Review the combined batch once, including source completeness, relevant exceptions, fork compatibility, and observed behavior. The audit's Commits section lists each candidate commit under its upstream PR with its `Fork adaptation` note, and shows how its change differs from the upstream commits it imports; a commit reported as matching upstream changes exactly the lines upstream changed, or leaves each file it changes identical to upstream's version. Do not repeat upstream's entire manual test plan for unchanged code.

## 4. Promote without a PR

**Promote upstream intake** is the landing path. It starts by itself when Fork CI passes on an `intake/**` push, and always runs from `main`, so a candidate cannot change the checks that promote it.

1. Push the candidate with `intake-run.ts push` once `verify --quick` passes, then finish the combined-batch review described above and any real-client checks while Fork CI runs; approve only after both. A candidate eligible for the automatic lane lands without approval, so finish its real-client checks before pushing.

   `push` first lists open pull requests set to auto-merge that can still land on their own and stops, so they land before the hold starts; push again once they have, or pass `--hold-queued` to hold them behind the batch. When `main` has moved, it rebases the candidate onto it and reruns `verify --quick`, and stops only on a conflict or a failure. Pull requests can therefore merge at any time: set auto-merge and they land before the next push or after the current promotion. Fork CI runs the full suite, the intake audit, a check that `pnpm-lock.yaml` matches the manifests, and a native fingerprint comparison with `main`.

2. When Fork CI passes, the workflow audits the exact candidate SHA again with `main`'s code and chooses a lane:
   - **Automatic**: the audit reports "Eligible for automatic promotion" (every commit matches upstream, none carries a `Fork adaptation:` note, and no sensitive path, dependency, or tracked fork feature changes) and the native fingerprint is unchanged. The promote job runs in the `upstream-intake-automatic` environment without approval.
   - **Manual**: everything else, including a moved or unknown fingerprint. The promote job waits in `upstream-intake-manual`. Its name says when the fingerprint moved, and the run summary shows the audit, the fingerprint report, and the lane. Review it, then approve.
3. The promote job rechecks both tips, then fast-forwards `main` without force. Verify the resulting SHA and ensuing CI.

After pushing, watch the Fork CI run, then the promotion run it starts. A promotion waiting for approval is not done: watch it until it lands or fails, then check Fork CI on `main`.

Production mobile builds use a fingerprint runtime version, so an OTA from **Mobile EAS Production** reaches installed builds only when the Expo fingerprint is unchanged. Dependency changes can move it without any native code change. Intake batches land without a pull request, so the Mobile Fingerprint Check never labels them; Fork CI's fingerprint job compares it the same way. If it moved, the batch's JavaScript changes reach users only through new production builds, which Mobile EAS Production starts on the push that lands it. Approving such a batch spends those builds.

If `main` moves before the promote job runs, it fails without changing anything. Rebase the standalone intake branch, rerun affected validation, and push with `intake-run.ts push`; the new Fork CI run starts a new promotion, which replaces any older one still waiting for approval on that branch. Never rebase `main` onto upstream or force-push it.

To retry a promotion, re-run Fork CI for the candidate; a successful run starts a new one.

**Current exception:** promotion rejects candidates changing `.github/workflows/fork-ci.yml`. Stop and arrange a separately authorized maintainer change; do not open a PR containing the upstream batch as a workaround.

Styal Porter's write credential lives only in the two environments, which accept deployments from `main` alone. `upstream-intake-manual` requires a reviewer; `upstream-intake-automatic` has no reviewer and holds the same `STYAL_INTAKE_APP_PRIVATE_KEY` secret. Without that secret the automatic lane fails before it can push.

## Running a batch with agents

Intake runs well as one coordinating agent thread with delegated tracks:

- **Survey, then split by conflict size.** Run `survey`, apply the clean picks with the driver on their own branch, and delegate the commits that need a person as tracks in separate worktrees. Group by files touched, and keep tracks of similar size, since the largest track decides when assembly can start. Start every track with `delegate_task` and `wake: "all"`, with a `wakeAfterMs` of about 45 minutes, so the coordinating thread wakes once when the last track finishes, or at the timeout if one stalls, instead of once per track.
- **Pipeline batches.** Once batch N is pushed, survey batch N+1 with `survey --base intake/<batch-N>` and start its tracks while N runs Fork CI and waits for promotion. After N lands, rebase N+1 onto `main` and push it with `push`, which waits for queued auto-merges first. Do not wait for the maintainer between batches; collect the decisions that need them in one list and continue on the most conservative choice (usually upstream's code, or the fork's where the ledger requires it) until they answer. On a batch stacked on an unlanded one, pass `--base intake/<batch-N>` to `fix-references`, `fix-trailers`, and `review-brief`; from `origin/main` they also rewrite or review batch N's commits.
- **Settle decisions before raising them.** A track's report and the coordinating agent's research turn most open questions into answers: read the upstream PR description, the fork PR or ledger entry behind the fork's side, the release tags or queue position involved, and decide where the evidence is clear. Raise only what remains. Each decision for the maintainer links the upstream PR and says what it changes and why, what the fork does instead and why (linking the fork PR or ledger entry), and what you recommend (keep the fork's version, update it, retire it in favour of upstream's, or skip upstream's change) with the evidence for that recommendation. A later upstream revert is a decision only when the reverted change is harmful to ship meanwhile, such as one that breaks existing installs; then skip the change and its revert as a pair through a state-only PR before the batch reaches it.
- **Review the adaptations.** `intake-run.ts review-brief --out <file>` writes a review prompt scoped to the commits with a `Fork adaptation:` note, with each note, its fork features, and how it differs from upstream. Give that file to a reviewer from another provider at high effort while Fork CI runs.
- **Land state changes separately.** Promotion rejects a batch commit without upstream provenance, so an exception change in `.github/upstream-intake.json` or a watch entry in `.github/upstream-tracked-prs.json` that the batch turns up goes on its own branch from `main` as a state-only PR. Open it without waiting to be asked, and say in the batch report whether it must merge before the next survey.
- **Start each batch in a fresh thread.** A long-lived intake thread reloads its whole history on every wake. Hand the next batch to a new thread with the queue position and the decisions and unchecked items still open.
- **Keep other work out of the intake thread.** Fixes the batch depends on, such as driver, runbook, or CI changes needed to land it, can be delegated from the intake thread. Product follow-ups and investigations an intake turns up start as their own top-level threads (`t3_thread_launch` in their own worktree), so their progress does not wake the intake thread or grow its context.

## 5. Record progress and repeat

After promotion, fetch `origin/main`, verify the batch is accounted for, and advance to the reviewed upstream boundary:

```bash
git fetch --no-tags origin main
node scripts/upstream/queue.ts status
node scripts/upstream/queue.ts advance <full-upstream-boundary-SHA>
```

`advance` edits only the local state file and rejects unresolved preceding commits or a boundary inside a multi-commit PR. Commit that state change through the normal maintainer review path, separately from the preserved upstream batch. A state-only PR must not include the intake commit history.

Once baseline equals target, choose a new destination from fetched upstream and repeat:

```bash
node scripts/upstream/queue.ts target <full-new-target-SHA>
node scripts/upstream/queue.ts next --count 20
```

Commit the target change too. Neither command promotes code.

## Early imports

Intake stays chronological by default. Import a change ahead of the queue only when a maintainer asks for it.

For a PR already merged into upstream `main`, plan the import first:

```bash
node scripts/upstream/queue.ts early <PR-number> [<PR-number> ...] --through upstream/main --json
```

`--through` sets the upstream commit to plan against for this run, in place of the target in the state file. Without it, a PR merged after the target fails with "not pending after the reconciled boundary". The command applies the selected patches at the reconciled upstream boundary, replays intervening upstream integrations in order, and adds PRs or direct commits only when that replay encounters a textual conflict. It then checks whether the resulting selection applies to fetched fork `main`. When a selected PR does not apply at the boundary itself, because it builds on upstream work the fork has not taken in, the command lists the conflicting files and the earlier pending upstream PRs that change them; `--json` includes every one. `early --count 20 --through upstream/main` without PR numbers provides a quick file-overlap screen without replay. A clean replay establishes that moving the selected patches earlier does not change the upstream result under Git's merge rules; review semantic dependencies and validate behavior before importing. The check changes no refs or working-tree files.

Import a clean plan on its own `intake/upstream-<PR>` branch, including every PR and direct commit the plan added, and follow steps 2 to 4 with the usual `Upstream-PR` trailers and an `Early-Import: <reason>` trailer on each commit. The queue then shows those sources as recorded when chronological intake reaches them.

`early` only accepts PRs merged into upstream `main`. For an explicitly requested open-PR import:

1. Fetch the PR head and record the exact head and its merge base with the PR's upstream target branch. Review that aggregate diff, including dependencies; importing the whole upstream branch would also import unrelated target-branch changes.
2. Apply that diff on `intake/upstream-<PR>` as one commit, simulating a squash merge. Preserve the principal upstream author's attribution and credit other contributors with `Co-authored-by` trailers where applicable. Use a concise subject for the complete change and an `Upstream-PR` trailer. Do not list its constituent commits in `Upstream-Commit` or cherry-pick notes. Explain fork adaptations as in step 2.
3. In a separate commit on the same candidate, update the tracked PR entry with `snapshot: { "base": "<full lowercase base SHA>", "head": "<full lowercase head SHA>" }`. Its `reason` must explain what was imported, any fork adaptations or known gaps, and how to reconcile if the PR merges or closes. Give this tracking commit the same `Upstream-PR` trailer and a `Fork adaptation:` note explaining the provisional tracking metadata. Publish and promote both commits together; the marker must land with the snapshot.
4. Follow the same final validation, exact-SHA CI, and promotion approval process. The audit compares the implementation with the frozen base-to-head diff, so later upstream amendments or rebases do not change what was reviewed. Fetching a missing snapshot head is read-only upstream access.

When upstream merges the PR, the queue keeps its integrations pending while the marker remains, even if the final patch matches the snapshot. At chronological intake, compare the frozen diff with the final upstream change, reconcile missing or changed behavior and fork adaptations, and validate the result. Remove the marker (or the entire entry when no longer needed) in a separate tracking commit with the same PR provenance, recording the reviewed outcome. Promote that cleanup with the reconciliation; the lag history counts completion at cleanup rather than retroactively at the snapshot import. An identical final change still needs this explicit review and cleanup.

If the PR closes without merging, the report calls for review. Decide whether to remove the imported change or retain it as maintained fork behavior, updating the ledger where appropriate. Record that decision before clearing its tracking marker. If a retained PR reopens, restore the marker so a later merge is reconciled. Closure alone never means that the imported code was reconciled or reverted. Legacy early imports with `Upstream-Commit` trailers keep their existing provenance; they do not need rewriting.

## T3 Code import check

The daily `T3 Code import check` workflow starts upstream `main`'s server with a fake Codex CLI, builds projects and threads through its HTTP API with `apps/server/scripts/generate-t3-import-fixture.ts`, and imports the result with styal's T3 Code import. A failure means data from current T3 Code does not import into styal, usually because upstream stores an event, field, or value that the fork has not taken in yet. A failed run uploads the generated data and the server log. Scheduled runs post to the CI Discord channel when the result changes: when the check starts failing, and when it passes again. Dispatch the workflow with `upstream_ref` to check another upstream branch, tag, or commit; dispatched runs do not post.

Fork CI runs the same test against `apps/server/src/dataImport/testFixtures/t3-code`, generated from the intake boundary. After advancing the baseline, regenerate it from an upstream checkout of the new boundary with dependencies installed, review any new differences the test reports, and commit it through the normal maintainer review path:

```bash
node apps/server/scripts/generate-t3-import-fixture.ts --server <upstream-checkout> --out apps/server/src/dataImport/testFixtures/t3-code
```

## Queue reference and exceptions

- `explain <PR-number-or-SHA-prefix>` shows sources and import evidence. SHA prefixes must be unambiguous and at least seven characters.
- `--fork-ref intake/<batch>` inspects a candidate, including its committed tracked PR list; draft working-tree tracking edits do not change the queue for `origin/main`. `--state` and `--upstream-ref` select alternate local inputs.
- `node scripts/upstream/queue.ts --help` lists every command. Modules under `scripts/upstream/lib/` are libraries and do nothing when run directly.
- `--json` provides structured output for queue commands.
- PR associations are cached in the primary checkout's ignored `.scratch/`, shared across worktrees and saved incrementally. New targets reuse settled associations from a previous cache and recheck direct or unmerged commits. Use `--refresh-metadata` to rebuild them.
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
