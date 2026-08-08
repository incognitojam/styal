# Fork nightly releases

The `Fork Nightly` workflow rebases the `yngatech/t3code` patch stack onto the current
`pingdotgg/t3code` main branch, validates the candidate, builds the supported desktop targets, and
publishes a GitHub prerelease.

## Fork features summary

Each published nightly can include a model-generated summary of the features and improvements unique
to the fork. The same summary updates the pinned `yngatech/t3code fork features and improvements`
issue, which is the stable view of the fork's current differences from upstream.

Configure the `OPENAI_FORK_CHANGELOG_API_KEY` Actions secret to enable summary generation. The
workflow maps that purpose-specific secret to `OPENAI_API_KEY` only for the generator process. It uses
`gpt-5.6-sol` with low reasoning by default. Set the `OPENAI_CHANGELOG_MODEL` environment variable in
the workflow to override the model deliberately.

The model receives fork-only commit subjects, bodies, and changed paths. It writes only the `Added`
and `Improved` sections. Divergence counts, comparison links, supported targets, signing status, and
artifact formats are rendered deterministically by `scripts/generate-fork-features-summary.ts`.

If the secret is absent or generation fails, the release continues with its existing commit-based
notes and the rolling issue remains unchanged.

## Supported targets

- macOS arm64: signed and Apple-notarized DMG, with ZIP and updater artifacts
- Linux x64: unsigned AppImage
- Windows x64: unsigned NSIS installer with bundled WSL support
