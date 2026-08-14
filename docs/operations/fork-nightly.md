# Fork nightly releases

The `Fork Nightly` workflow rebases the `yngatech/t3code` patch stack onto the current
`pingdotgg/t3code` main branch, validates the candidate, builds the supported desktop targets, and
publishes a GitHub prerelease.

## Keeping `main` current

`main` is the fork patch stack, rebased onto upstream. Two paths move it:

- **Automated promotion (mechanical rebases only).** Every green run promotes the verified rebased
  stack to `main`; when upstream has not advanced, the push is skipped as a no-op. When the run has
  new changes, promotion happens after the release publishes. When it has none (the candidate tree
  matches `origin/nightly`), the prepare job instead aligns `main` to the already-released
  `origin/nightly` commit — same tree, already fully verified — skipping as a no-op when `main`
  already matches it. The day's first actual promotion snapshots the pre-promotion `main` to
  `backup/main-YYYYMMDD`; later promotions that day leave the snapshot alone. If `main` moved while
  the run was in flight (a PR merge, say), promotion is skipped as expected and the next run's
  candidate includes the change; a `source_ref` run fails loudly at that point instead, since its
  purpose was promoting the resolution — refresh it from current `main` and re-dispatch (an already
  published release stands). The final push carries a lease pinned to the commit the run
  started from, so a push landing in the last seconds still fails the step loudly (and the Discord
  failure notification fires), as does any other failure checking or pushing refs. Dry runs never
  promote.
- **Maintainer-reviewed manual rebases.** When the rebase onto upstream conflicts, the nightly fails
  in prepare before promoting anything. A human resolves the conflict locally and pushes the
  resolved stack to a scratch branch on origin, then dispatches the workflow with `source_ref` set to
  that branch: the run rebases it onto upstream (a no-op when nothing moved since, a loud failure
  when it did), verifies it, publishes the release, and promotes it to `main` through the same backup
  and lease mechanics as an automated run. The ruleset blocks force-pushing `main` from the CLI, so
  this dispatch is how a resolved stack reaches `main`. Pair `source_ref` with `dry_run` first to
  verify a resolution without publishing or promoting anything. Prepare compares the supplied
  stack's patch IDs with every fork patch currently carried by `main` and fails with the missing
  commit subjects before rebasing or verifying a stale stack. Refresh the resolution from current
  `main` immediately before dispatching it. Conflict resolution can intentionally reshape a patch
  enough to change its patch ID; after reviewing every reported commit, re-dispatch with those
  commits listed in `waived_main_patches`. Waivers name the reviewed commits, so any other missing
  patch — including one that merged to `main` after the review — still fails the dispatch.

## Fork features summary

Each published nightly can include model-generated highlights for changes since the previous nightly.
A separate rolling summary updates the pinned `yngatech/t3code fork features and improvements` issue,
which is the stable view of the fork's current differences from upstream.

Configure the `OPENAI_FORK_CHANGELOG_API_KEY` Actions secret to enable summary generation. The
workflow maps that purpose-specific secret to `OPENAI_API_KEY` only for the generator process. It uses
`gpt-5.6-terra` with low reasoning for evidence extraction and medium reasoning for synthesis. Set the
`OPENAI_CHANGELOG_MODEL` environment variable in the workflow to override the model deliberately;
because the model is part of the cache fingerprint, changing it re-extracts every change once.

The generator resolves pull request numbers from commit subjects and loads each PR title and body,
falling back to commit metadata when PR evidence is unavailable. It first extracts chronological,
user-visible change records without combining PRs. A synthesis pass then reconciles additions,
improvements, replacements, and reverts into the current rolling feature set. A second synthesis pass
uses only records delivered since the previous nightly to produce release highlights. Because those
highlights appear in the desktop updater, the workflow excludes changes classified as mobile-only;
shared changes remain eligible, and the complete GitHub release commit list still includes mobile
changes.

Extraction also flags changes that only alter how this build identifies itself — application names,
icons, artwork, release channels, and screens reporting versions or source repositories. Those changes
stay in release highlights, which announce what shipped, and are left out of the rolling issue, which
answers how the fork differs from upstream. The release commit list is rendered from git and always
lists them.

Extraction covers every commit the fork carries, so it runs in chronological batches, and its results
are cached per pull request in the Actions cache so only new evidence reaches the model. Batch size is
set by the records a response may hold rather than by prompt length: the schema caps records per
response, and a batch that could exceed the cap would lose changes with no error to report. The prompt
budget is a ceiling on one request that splits a batch early when its changes run unusually large.

Batches run in order rather than concurrently: each is given the capability names every earlier change
already used, cached or extracted moments ago, which keeps one feature under one name across batch
boundaries. The cache is written after each batch, so a failed batch resumes from that point on the
next run instead of re-reading every change.

Each entry is keyed by a hash of the evidence the model reads — PR title, body, and touched files,
with the patch ID standing in for the diff — combined with a hash of the extraction request, which
covers the prompt, schema, model, reasoning effort, output limits, and how much of each diff the model
is shown. The nightly rebase therefore keeps its hits, while an edited PR body, an amended patch, or an edited prompt re-extracts the
affected changes. Commits without a pull request number are keyed by commit SHA and are re-extracted
after every rebase. A change large enough to exceed the budget on its own still loses its diff to the
budget fitter, and is then left uncached so a future run can read it whole.

A cold or unreadable cache costs one full extraction and nothing else, and the cache is written
before synthesis so a failed summary does not discard it. Because a cached record is reused until its
pull request changes, a wrong summary line outlives the run that produced it: delete the cache
(`gh cache list --key changelog-records-` then `gh cache delete <id>`) to force a full re-extraction
on the next nightly.

Generated labels are short, action-oriented capability descriptions. The model writes the `Added`,
`Improved`, and nightly `Removed` sections. Divergence counts, comparison links, supported targets,
signing status, and artifact formats are rendered deterministically by
`scripts/generate-fork-features-summary.ts`.

If the OpenAI secret is absent or generation fails, the release continues with its existing
commit-based notes and the rolling issue remains unchanged.

## Supported targets

- macOS arm64: signed and Apple-notarized DMG, with ZIP and updater artifacts
- Linux x64: unsigned AppImage
- Windows x64: unsigned NSIS installer with bundled WSL support
