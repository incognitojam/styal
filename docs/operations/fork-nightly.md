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
  candidate includes the change. The final push carries a lease pinned to the commit the run
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
  enough to change its patch ID; after reviewing every reported commit, set
  `allow_missing_main_patches` to acknowledge those differences explicitly.

## Fork features summary

Each published nightly can include model-generated highlights for changes since the previous nightly.
A separate rolling summary updates the pinned `yngatech/t3code fork features and improvements` issue,
which is the stable view of the fork's current differences from upstream.

Configure the `OPENAI_FORK_CHANGELOG_API_KEY` Actions secret to enable summary generation. The
workflow maps that purpose-specific secret to `OPENAI_API_KEY` only for the generator process. It uses
`gpt-5.6-sol` with low reasoning for evidence extraction and medium reasoning for synthesis. Set the
`OPENAI_CHANGELOG_MODEL` environment variable in the workflow to override the model deliberately.

The generator resolves pull request numbers from commit subjects and loads each PR title and body,
falling back to commit metadata when PR evidence is unavailable. It first extracts chronological,
user-visible change records without combining PRs. A synthesis pass then reconciles additions,
improvements, replacements, and reverts into the current rolling feature set. A second synthesis pass
uses only records delivered since the previous nightly to produce release highlights. Because those
highlights appear in the desktop updater, the workflow excludes changes classified as mobile-only;
shared changes remain eligible, and the complete GitHub release commit list still includes mobile
changes.

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
