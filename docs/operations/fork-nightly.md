# Fork nightly releases

The `Fork Nightly` workflow takes the newest commit on `main` that Fork CI has passed, builds the
supported desktop targets and CLI package from it, and publishes a GitHub prerelease. It never modifies `main`.

Fork CI is the only verifier: the nightly does not repeat its checks, tests, or desktop build. It
walks `main` from the tip and skips any commit whose Fork CI run failed, so a briefly red `main` delays
those commits to a later nightly rather than shipping them. If the tip's run is still in progress the
nightly waits for it, since it is newer than any green commit below. The one check the nightly does
repeat is the previous-nightly schema upgrade test, because the `nightly` branch it upgrades from may
have moved since the pull request ran.

`Fork Release` promotes a nightly tag and refuses any commit without a successful Fork CI run, which
every commit the nightly tagged already has.

## How upstream work reaches `main`

`main` is not rebased onto `pingdotgg/t3code`. Upstream changes arrive the same way fork changes
do: a pull request, reviewed and verified by Fork CI on the tree it will actually produce. Which
upstream changes to bring in, and when, is a maintainer decision made per change rather than an
automatic sync.

A run skips the release when `main`'s tree matches `origin/nightly`, the source of the last
published artifact. Dry runs build and verify without publishing.

## Release notes

Each nightly includes a “What's Changed” list built from commit subjects since the previous
nightly. Squashed PRs retain their titles, with links to the pull requests and author credits when
GitHub lookups succeed. Commits without a resolvable PR use commit links. The list includes fork and
upstream changes across all clients, followed by a comparison link between the fork's release tags.
The desktop updater uses these same notes.

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
