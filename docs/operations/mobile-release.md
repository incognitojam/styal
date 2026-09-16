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
4. Configure the project's environment-specific styal Link authentication, relay,
   and notification settings when those features are enabled.
5. Once the distribution workflow and app ID are correct on `main`, add the
   GitHub `EXPO_TOKEN` secret. Set `STYAL_MOBILE_RELEASE_ENABLED=true` to enable
   production builds and over-the-air updates.

## Build and distribute

Run **Mobile EAS Production** with `mode=build` and the desired platform. Selecting
`all` schedules an iOS build with automatic TestFlight submission and an Android
APK build without store submission. Download the Android artifact from the EAS
build page and share its installation link with testers.

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
