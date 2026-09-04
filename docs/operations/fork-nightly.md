# Fork nightly releases

The `Fork Nightly` workflow takes the newest commit on `main` that Fork CI has passed, builds the
supported desktop targets from it, and publishes a GitHub prerelease. It never modifies `main`.

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

## Fork features summary

Each published nightly can include model-generated highlights for changes since the previous nightly.
A separate rolling summary updates the pinned `styal features and improvements` issue,
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

Extraction also flags release-specific changes that are useful in the release where they ship but are
not enduring application capabilities. That includes application identity and branding, platform
distribution and installer packaging, and install or upgrade migration mechanics. Those changes stay
in release highlights and are left out of the rolling issue, which describes what users can do in the
running application. The release commit list is rendered from git and always lists them.

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
