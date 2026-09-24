# styal mobile releases

Mobile production builds use the styal-owned Expo project. iOS builds are submitted
to TestFlight; Android builds produce signed APKs for direct installation. Android
builds are not submitted to Google Play.

## Account setup

1. Configure GitHub variables `EXPO_OWNER`, `EXPO_PROJECT_ID`, and `APPLE_TEAM_ID`.
   Set the same values in the Expo project's development, preview, and production
   environments so local configuration and remote builds use the same identity.
2. Create an App Store Connect iOS app for `build.styal.app`. Set its numeric Apple
   ID as `submit.production.ios.ascAppId` in `apps/mobile/eas.json` before enabling
   submission. An Apple team ID is not an App Store app ID.
3. Configure EAS signing credentials for the iOS app, its widget and sharing
   extensions, and the Android keystore. Configure the App Store Connect API key
   used by EAS Submit. Keep Android's signing key stable across APK releases so
   users can install updates over an existing installation.
   Provisioning through the Apple API requires a team API key with Admin access.
   Before creating iOS provisioning profiles, register the App Group
   `group.build.styal.app` in the Apple Developer portal and assign it to
   `build.styal.app`, `build.styal.app.sharing`, and `build.styal.app.widgets`.
   EAS cannot create or link App Groups when authenticating with an API key.
4. Configure styal Link's public settings in the Expo project's production and
   preview environments, using the existing production GitHub variables:

   | GitHub variable         | EAS variable                   |
   | ----------------------- | ------------------------------ |
   | `CLERK_PUBLISHABLE_KEY` | `T3CODE_CLERK_PUBLISHABLE_KEY` |
   | `CLERK_JWT_TEMPLATE`    | `T3CODE_CLERK_JWT_TEMPLATE`    |
   | `RELAY_URL`             | `T3CODE_RELAY_URL`             |

   Both distributed variants use production styal Link; local development uses
   the development configuration described in [styal Link](./styal-link.md).
   Register `build.styal.app` with the signing team in Clerk's production Native
   API settings. Verify that its Apple association file includes the app under
   `webcredentials.apps` before testing native passkeys.
   Notification delivery needs separate push credentials and relay configuration;
   enabling the iOS push entitlement alone does not configure delivery.

5. Once the distribution workflow and app ID are correct on `main`, add the
   GitHub `EXPO_TOKEN` secret. Set `STYAL_MOBILE_RELEASE_ENABLED=true` to enable
   production builds and over-the-air updates.

### Signing and submission credentials

From `apps/mobile`, configure the production signing credentials:

```sh
eas credentials:configure-build --platform ios --profile production
eas credentials:configure-build --platform android --profile production
```

The iOS app and its two extensions can share one distribution certificate, but
each needs its own App Store provisioning profile. Verify that all three contain
`group.build.styal.app`; the main app also needs production push notifications
and Sign in with Apple entitlements.

Configure upload credentials separately with `eas credentials --platform ios`.
Select `production`, then **App Store Connect → Set up your project to use an API
Key for EAS Submit**, and select the main `styal` target. Import an existing key
using its `.p8` file, key ID, and issuer ID. The Developer key used for uploads can
be separate from the Admin key used for provisioning. Importing an existing key
does not require signing in with an Apple ID; decline that optional login prompt.

Credentials are stored in EAS. Keep private keys out of the repository. Successful
credential setup does not verify a native build or TestFlight upload; complete
the release checks below after the first builds finish.

The repository-root `.easignore` excludes local state, scratch files, credentials,
dependencies, and generated native projects from build uploads. EAS uses it in
place of all `.gitignore` files, so keep its exclusions aligned when those change.

## Build and distribute

Run **Mobile EAS Production** with `mode=build` and the desired platform. Selecting
`all` schedules an iOS build with automatic TestFlight submission and an Android
APK build without store submission. Download the Android artifact from the EAS
build page and share its installation link with testers.

The optional version override commits the new version before building. It uses
the fork's `NIGHTLY_APP_CLIENT_ID` variable and `NIGHTLY_APP_PRIVATE_KEY` secret;
the GitHub App must have permission to push version commits to the selected branch.
Leaving the override blank uses the version already in source and requires no
GitHub App token.

The production profile uses `build.styal.app` on both platforms. The preview
profile uses `build.styal.app.preview` and a separate update channel. Preview iOS
installation uses registered devices; TestFlight uses production builds.

Once enabled, relevant pushes to `main` schedule a production build for each
platform when its latest build has a different app version. Failed builds require
a manual retry. The workflow publishes an over-the-air update only when a finished
build matches the current native fingerprint. Native changes require a compatible
new binary; a JavaScript update cannot replace native code.

## Verify a release

Install through TestFlight or the APK link on a real device. Check pairing with
the published `@styal/cli`, an agent turn, background/reconnect behavior, and any
enabled notification, widget, or share-extension features. Install a subsequent
build over the first one and verify that saved environments remain available.
Verify an over-the-air update separately on a matching native runtime.
