# Android notifications

The Android app receives Firebase Cloud Messaging (FCM) data messages. The relay sends them directly through FCM HTTP v1; an Expo Push account is not required.

## Android compatibility and automated checks

The app's minimum is Android 7.0 (API 24), declared in `app.config.ts` and enforced by the relay's device-registration schema. Compile/target SDK versions follow the locked Expo/React Native toolchain (currently API 36). Notification channels begin at API 26; the notification permission prompt begins at API 33. Live Update promotion requires API 36 and remains subject to system settings and device support. Alerts and ordinary activity cards work below API 36.

On Android 16+, open styal Settings → Notifications → Live Updates to allow status bar chips. Android controls this separately from notification permission. The chip reads `Working` during work, `Approve` for approvals, and `Answer` for input requests; completed work returns to a normal notification. Use an Android 16 QPR2 or newer emulator image to verify the shipped promotion behavior.

API 24–25 use a single inexact system alarm to expire cards after process exit, with no exact-alarm permission. Android can delay that alarm in power-saving modes. API 26+ use notification timeouts. Disabling activity, dismissal, account changes and sign-out cancel the legacy alarm. A stale expiry broadcast cannot remove a newer run's card.

The native notification tests cover API 24, 26, 33 and 36 (plus API 25 for legacy expiry) using Robolectric. To compile the module, run these tests and run Android lint, use the following command from a generated `apps/mobile/android` project with JDK 21 available. No Firebase, signing or relay secrets are required:

```sh
./gradlew :t3-agent-notifications:testDebugUnitTest :t3-agent-notifications:lintRelease -Pandroid.lint.useK2Uast=false
```

Robolectric's API 36 runtime requires JDK 21; module compilation still uses Expo's Java 17 toolchain. The existing Mobile Native Static Analysis job separately runs ktlint and detekt. The native fingerprint check marks this change as requiring a new binary; the production workflow cannot deliver it to an older binary by OTA. Settings disable Android notifications if the installed native module is missing required methods.

The lint command uses the K1 frontend because AGP's K2 frontend crashes while analyzing Worklets 0.10's Gradle Kotlin scripts. This does not disable lint checks. Live Update eligibility must be verified on a device: Robolectric's API 36 image implements older promotion rules that require colorization, while shipped Live Updates require uncolorized notifications.

## Firebase and app build

1. Create a Firebase project and register each Android application identifier you intend to build: `build.styal.app.dev`, `build.styal.app.preview`, or `build.styal.app`.
2. Download `google-services.json`. Set `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` to its path when running Expo prebuild and building the app. The JSON must contain the selected variant's package identifier.
3. Create a service-account key with permission to send FCM messages for that Firebase project. Keep this private JSON outside the repository and the app bundle.
4. Enable the Firebase Cloud Messaging API in the Google project if it is not already enabled. For hosted delivery, set the relay's `FCM_SERVICE_ACCOUNT` secret to the service-account JSON.
5. Build a new Android binary. A JavaScript-only update cannot install the native notification handler or Firebase configuration. Hosted delivery also needs the relay database migration and updated relay deployment; local verification can use the watcher below.

For a local development build, from `apps/mobile`:

```sh
APP_VARIANT=development \
T3CODE_ANDROID_GOOGLE_SERVICES_FILE=/absolute/path/google-services.json \
vp run android:dev
```

For an EAS build, provide the same configuration through each selected build environment, using an EAS file variable named `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` for the Google services file. Make the file available to fingerprint generation as well as the native build. FCM service-account credentials belong on the relay, not in EAS's app environment. If deploying a separate hosted relay, set the build's `T3CODE_RELAY_URL` as described in [styal Link](./styal-link.md).

Set `T3CODE_MOBILE_UPDATES_ENABLED=0` before prebuild and bundling a private binary to disable the repository's configured Expo OTA update source. A debug development-client APK requires Metro; a bundled release build is needed to verify cold-start notification taps without Expo's development launcher.

## Sign-in for private builds

Use the relay's email sign-in; no Clerk callback registration is needed. A successful direct-pairing
or FCM smoke test does not verify hosted sign-in or device registration.

Set the same `APP_VARIANT` during prebuild and bundling, and supply a Google services file that
includes that package. Keep OTA updates disabled for a private binary. A locally signed build with
the production package cannot update an official installation signed by the maintainer or coexist
with it; removing that installation also removes its app-local data. The development package
remains a separate app.

## Focused delivery check

`infra/relay/scripts/android-push-smoke.ts` sends a message through the production FCM client implementation without provisioning the relay's database or Cloudflare queues. It verifies only Firebase-to-device delivery.

Provide a private device JSON file containing the app's native FCM `token`, registered `deviceId`, signed-in `userId`, and Android `packageName`. An optional `deepLink` can target an existing thread for tap verification. The app must have registered its local native notification handler and have notification permission. From `infra/relay`:

```sh
vp run push:android:smoke /path/service-account.json /path/device.json running
vp run push:android:smoke /path/service-account.json /path/device.json approval
vp run push:android:smoke /path/service-account.json /path/device.json completed
```

Supported states are `running`, `approval`, `input`, `completed`, `failed`, and `end`. Firebase acceptance is not proof that a device displayed the message. Check the actual notification, background the app, and test a notification tap. Also test dismissal, disabling ongoing activity, sign-out, token rotation, and delivery after the app process has exited. Android Settings **Force stop** intentionally prevents delivery until the app is opened again.

With the app in the foreground, Android suppresses an alert only for the thread currently on screen, matching iOS notification presentation; alerts for other threads still show. Activity cards still update in the foreground and retain finished results silently. Check that completion stays quiet while its thread is open, alerts while another screen is open, alerts after backgrounding, and that retrying a suppressed alert does not show it later. This uses the app lifecycle and route on the receiving phone, not thread visibility on other clients.

With ongoing activity enabled, verify two threads entering approval/input together produce one `2 agents need attention` alert, and two observed active threads completing/failing together produce one `2 agents finished` alert. The body lists their titles. The relay shares iOS transition selection and retains its delivered baseline when work finishes; publishing the same states again must not produce another alert. Grouped alerts open the aggregate’s priority thread; individual alerts retain their thread link.

Verify an expanded card with five threads, attention/failure priority, project names and statuses. When all work finishes, the card should show **Agent work completed** or **Agent work failed**, lose its ongoing/promotion flag, and expire 15 minutes after the newest displayed result. Replays must not extend that deadline. Quiet running work uses the relay’s two-hour state lifetime; approval/input states use 24 hours. Reopen the same signed-in app and confirm existing alerts and dismissal survive, with a silent aggregate replay on cold start or a foreground after at least 60 seconds. Also check empty replays remove an orphaned card and completions older than two minutes never alert, even with ongoing activity disabled.

After Android prebuild, run the native presentation regression tests from `apps/mobile/android`:

```sh
./gradlew :t3-agent-notifications:testDebugUnitTest --tests expo.modules.t3agentnotifications.AgentNotificationsTest
```

## Relay deployment

### Local verification with existing styal services

You do not need to duplicate styal Link's hosted infrastructure to develop Android push. Keep the normal email sign-in and environment connections. `infra/relay/scripts/android-push-watch.ts` subscribes to one paired environment's shell stream, uses the shared agent-awareness projection, and sends updates through the new FCM client. It holds transient state in memory and needs no hosted database or relay credentials.

Create a private `connection.json` containing `wsUrl` (the environment's `/ws` URL) and `bearerToken` (a normal paired environment access token). Use a separate pairing credential for this watcher. Supply the same device file described above, then run from `infra/relay`:

```sh
vp run push:android:watch /path/service-account.json /path/device.json /path/connection.json
```

The Android native handler must already be configured with that device and account, and notifications must be allowed. A native instrumentation harness can configure a disposable emulator before testing; a signed-in development app configures the handler during device registration. This watcher is a development transport: it observes all unarchived threads in its paired environment, enables all alert types, keeps no durable queue, and must stay running. It does not register Android devices with the existing hosted relay. The hosted relay needs the changes below before its notification settings and delivery work end to end.

### Hosted delivery

Use the [relay deployment runbook](../../infra/relay/README.md#deployment) for Neon, Cloudflare,
push credentials, and stage isolation. It owns the deployment commands and requirements; client
public settings do not grant deployment access.

Build the host client and mobile app with the same relay URL. Keep a test host's T3 home separate
from an existing installation. Signing into the phone alone does not link a host environment: use
the host client's styal Link settings to link it and enable activity publishing. Enable phone
notifications and verify an agent turn produces a running update and completion alert while the
phone is locked.

For deployment through GitHub Actions, add `FCM_SERVICE_ACCOUNT` to the `production` environment's secrets. The relay workflow passes it to Alchemy. The maintainer must also supply `google-services.json` for the production Android package in the native build environment; changing the relay secret alone cannot move an installed app to another Firebase project.

Android delivery uses `RelayFcmDeliveryQueue` and a separate dead-letter queue. Failed requests are retried; messages expire after five minutes. Before sending, the consumer rechecks the device token, current preferences, environment links, and current thread state. `UNREGISTERED` responses invalidate only the matching device token. OAuth tokens are cached within the FCM service and refreshed after an authorization failure.
