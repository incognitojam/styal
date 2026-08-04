# Fork nightly releases

The `Fork Nightly` workflow maintains installable macOS arm64 builds for the
`incognitojam/t3code` fork. It runs every six hours and can also be dispatched manually.

## Source branches

- `main` is the human-maintained patch stack. Keep fork-specific changes as ordinary commits on
  top of an upstream T3 Code commit.
- `nightly-candidate` is the workflow's temporary rebase of `main` onto the latest
  `pingdotgg/t3code@main`.
- `nightly` points to the source of the last successfully published fork release.

The workflow compares the candidate tree with `nightly`, so a scheduled run does not rebuild when
neither upstream nor the fork's patches changed. A rebase conflict fails before either bot-managed
branch is promoted. Do not commit directly to `nightly` or `nightly-candidate`.

The inherited upstream `Release` workflow should remain disabled in the fork's Actions settings.
It depends on upstream-only runners, signing credentials, npm publishing, relay infrastructure,
and deployment configuration. Disabling it in repository settings avoids carrying a conflicting
edit to `.github/workflows/release.yml` in the fork's patch stack.

## Unsigned builds

Without Apple credentials, the workflow publishes an unsigned DMG, update ZIP, and update manifest
to a GitHub prerelease. The DMG can be installed manually for testing, but macOS automatic updates
require a signed application. A self-signed certificate does not provide the Developer ID and
notarization chain expected by this release pipeline.

When macOS quarantines an unsigned build, move it to Applications and explicitly open it from
Finder's context menu. Do not expect an unsigned installation to update itself.

## Apple signing

The workflow enables signing only when all of this configuration is present:

| Kind     | Name                         |
| -------- | ---------------------------- |
| Secret   | `CSC_LINK`                   |
| Secret   | `CSC_KEY_PASSWORD`           |
| Secret   | `APPLE_API_KEY`              |
| Secret   | `APPLE_API_KEY_ID`           |
| Secret   | `APPLE_API_ISSUER`           |
| Secret   | `MACOS_PROVISIONING_PROFILE` |
| Variable | `APPLE_TEAM_ID`              |
| Variable | `CLERK_PASSKEY_RP_DOMAINS`   |

`MACOS_PROVISIONING_PROFILE` is the base64-encoded profile file. Every update must use the same
Developer ID signing identity as the installed application.

The desktop build currently uses the bundle identifier `com.t3tools.t3code`. Another Apple
Developer team generally cannot provision an identifier already registered by the upstream team.
Before enabling signing from another team, give the fork a unique bundle identifier and create the
matching App ID and provisioning profile.

## Windows

Windows should be added as another build job in this workflow, followed by the existing release job
downloading both artifact sets. Keeping one workflow gives macOS and Windows the same nightly
version and publishes a single GitHub prerelease. The Windows job also needs the upstream WSL
`node-pty` prebuild step; code signing can be added independently later.
