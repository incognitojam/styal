# Fork nightly releases

The `Fork Nightly` workflow takes the newest commit on `main` that Fork CI has passed, builds the
supported desktop targets and CLI package from it, and publishes a GitHub prerelease. It never modifies `main`.

Successful Fork CI push runs on `main` trigger the nightly automatically. The three-hour
schedule remains a fallback, and manual dispatch still supports dry runs and forced publication.
CI completions request a release of the newest eligible commit rather than pinning their own
commit. One publisher runs at a time; newer requests replace a pending request, and the
candidate is compared with the last published nightly before any builds start. Failed CI,
pull request CI, and intake branch CI do not request publication. There is no minimum interval
between releases, so merges spread throughout the day can each produce a nightly.

Fork CI is the only verifier: the nightly does not repeat its checks, tests, or desktop build. It
walks `main` from the tip and skips any commit whose Fork CI run failed, so a briefly red `main` delays
those commits to a later nightly rather than shipping them. If the tip's run is still in progress the
nightly waits for it, since it is newer than any green commit below. The one check the nightly does
repeat is the previous-nightly schema upgrade test, because the `nightly` branch it upgrades from may
have moved since the pull request ran.

`Fork Release` promotes a nightly tag and refuses any commit without a successful Fork CI run, which
every commit the nightly tagged already has. Without a `source_tag` it promotes the newest published
nightly. The stable version is the one in the nightly's tag, so `v0.1.1-nightly.*` ships as `0.1.1`.
Its release notes list the changes since the previous stable release; the first stable release has
none to compare against, so write its notes by hand after it is published.

## Versions

`styal-version.json` names the next version to ship until a stable release reaches it. After that,
nightlies preview the next patch after the newest stable tag, so they always sort above the installed
stable release and no bump is needed between releases. Edit the file only for a minor or major bump.

## How upstream work reaches `main`

`main` is not rebased onto `pingdotgg/t3code`. Upstream changes arrive the same way fork changes
do: a pull request, reviewed and verified by Fork CI on the tree it will actually produce. Which
upstream changes to bring in, and when, is a maintainer decision made per change rather than an
automatic sync.

A run skips the release when `main`'s tree matches `origin/nightly`, the source of the last
published artifact, or when no commit since then changes shipped code as defined under
[Release notes](#release-notes). Skipped commits are counted in the next nightly that ships code.
Run the workflow manually with `force_publish` to release anyway, for example after fixing the
build or signing pipeline. Dry runs build and verify without publishing. A dry run leaves an
unpublished draft release with its artifacts attached for inspection; delete it from the
repository's Releases page when it is no longer needed.

## Release notes

Each nightly includes a “What's Changed” list built from commit subjects since the previous
nightly. Squashed PRs retain their titles, with links to the pull requests and author credits when
GitHub lookups succeed. Commits without a resolvable PR use commit links. The list includes fork and
upstream changes across all clients, followed by a comparison link between the fork's release tags.
The desktop updater uses these same notes.

Only commits that change shipped code are listed: files under `apps/web`, `apps/desktop`,
`apps/mobile`, `apps/server`, `packages/`, or `patches/`, other than tests, fixtures, scripts, and
Markdown, plus `pnpm-lock.yaml` and `pnpm-workspace.yaml`, which pin dependency versions. The decision uses changed paths rather than the commit subject, so a `ci(release)` commit
that changes desktop code is still listed. Other commits, including relay changes, which deploy
separately, are counted on the comparison link line instead.

Release notes do not use AI generation or require an OpenAI API key. The nightly workflow no longer
updates the rolling `styal features and improvements` issue. The maintained
[styal differences overview](../user/styal-differences.md) describes the fork's ongoing capabilities.

The commit list resolves a subject's PR suffix against upstream when it matches an `Upstream-PR`
trailer; other PR suffixes use the commit's repository. This preserves upstream links for cherry-picks
and fork links for fork squash commits with a different PR number. Failed GitHub lookups fall back to
the release's commit link, and their response bodies are never rendered as author names.

## Supported targets

- macOS arm64: signed and Apple-notarized DMG, with ZIP and updater artifacts
- Linux x64: unsigned AppImage
- Windows x64: unsigned NSIS installer with bundled WSL support

## CLI distribution

Each release includes a verified `@styal/cli` npm archive. npm publication is enabled
separately after the scope and trusted publishers are configured. See
[CLI releases](./cli-release.md) for bootstrap and deployment verification.
