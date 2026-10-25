import * as Dialog from "../../components/ui/Dialog";
import { AuthRelayWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAuth } from "@clerk/expo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import { useNavigation } from "@react-navigation/native";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import {
  type AndroidAgentChannel,
  type AndroidAgentChannelStates,
  getAndroidAgentChannelStates,
  openAndroidAgentChannelSettings,
  openAndroidLiveUpdateSettings,
  supportsAndroidLiveUpdateSettings,
} from "../agent-awareness/androidNotifications";
import { setLiveActivityUpdatesEnabled } from "../agent-awareness/liveActivityPreferences";
import { DEFAULT_ATTENDED_ALERT_DELAY_SECONDS } from "../agent-awareness/registrationPayload";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
  updateAgentAwarenessRegistrationPreferences,
} from "../agent-awareness/remoteRegistration";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { runtime } from "../../lib/runtime";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";
type LiveActivityStatus = "checking" | "enabled" | "disabled" | "signed-out" | "linking";

function useDeviceRegistered(): boolean {
  const status = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    getAgentAwarenessRegistrationStatus,
    () => "unknown" as const,
  );
  return status === "registered";
}

const OFF_IN_ANDROID_SETTINGS = "Off in Android settings";

type AlertTypePreference =
  | "notifyOnApproval"
  | "notifyOnInput"
  | "notifyOnCompletion"
  | "notifyOnFailure";

const ALERT_TYPES: ReadonlyArray<{
  readonly preference: AlertTypePreference;
  readonly label: string;
  readonly icon: AppSymbolName;
}> = [
  { preference: "notifyOnApproval", label: "Needs approval", icon: "exclamationmark.shield" },
  { preference: "notifyOnInput", label: "Needs input", icon: "questionmark.bubble" },
  { preference: "notifyOnCompletion", label: "Done", icon: "checkmark.circle" },
  { preference: "notifyOnFailure", label: "Failed", icon: "exclamationmark.triangle" },
];

const ATTENDED_ALERT_DELAYS: ReadonlyArray<{ readonly seconds: number; readonly label: string }> = [
  { seconds: 0, label: "Immediately" },
  { seconds: 60, label: "After 1 minute" },
  { seconds: 120, label: "After 2 minutes" },
  { seconds: 300, label: "After 5 minutes" },
  { seconds: 600, label: "After 10 minutes" },
];

function openChannelSettings(channel: AndroidAgentChannel) {
  void openAndroidAgentChannelSettings(channel).catch(() => {
    Dialog.alert(
      "Couldn't open Settings",
      "Open Android Settings, select styal, then open Notifications.",
    );
  });
}

export function SettingsNotificationsRouteScreen() {
  if (!hasCloudPublicConfig()) {
    return (
      <SettingsScreen title="Notifications">
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pt-4"
        >
          <Text className="text-base text-foreground-muted">
            Notifications require styal Link in this app build.
          </Text>
        </ScrollView>
      </SettingsScreen>
    );
  }

  return <ConfiguredSettingsNotificationsRouteScreen />;
}

function ConfiguredSettingsNotificationsRouteScreen() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS);
  const agentAwarenessSubtitle =
    Platform.OS === "android" && !agentAwarenessPushAvailable
      ? "Install a newer app build to enable notifications"
      : agentAwarenessPlatform.subtitle;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>("checking");
  const [liveActivityStatus, setLiveActivityStatus] = useState<LiveActivityStatus>("checking");
  const [channelStates, setChannelStates] = useState<AndroidAgentChannelStates | null>(null);
  const alertsChannelOff = channelStates?.alerts === false;
  const activityChannelOff = channelStates?.activity === false;
  const liveActivityWriteInFlight = useRef(false);
  const deviceRegistered = useDeviceRegistered();
  const liveActivitiesPreferenceEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;
  const canClearLiveActivitiesPreference =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.liveActivitiesEnabled !== false;

  const connections = Object.values(savedConnectionsById);
  const environmentCount = connections.length;
  const alertsEnabled =
    agentAwarenessPushAvailable &&
    notificationStatus === "enabled" &&
    deviceRegistered &&
    !alertsChannelOff;
  const storedPreferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : null;

  // The stored preference is what later registrations send, so a failed relay
  // update is retried by the next registration (app foreground, token rotation).
  const handleAlertTypeChange = async (preference: AlertTypePreference, enabled: boolean) => {
    savePreferences({ [preference]: enabled });
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        updateAgentAwarenessRegistrationPreferences({ [preference]: enabled }),
      ),
    );
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification type update" });
    }
  };

  const selectedAlertDelay =
    storedPreferences?.attendedAlertDelaySeconds ?? DEFAULT_ATTENDED_ALERT_DELAY_SECONDS;
  const handleAlertDelayChange = async (seconds: number) => {
    savePreferences({ attendedAlertDelaySeconds: seconds });
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        updateAgentAwarenessRegistrationPreferences({ attendedAlertDelaySeconds: seconds }),
      ),
    );
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification delay update" });
    }
  };

  const refreshNotifications = async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      setNotificationStatus("unsupported");
      return;
    }
    if (Platform.OS === "android") setChannelStates(getAndroidAgentChannelStates());
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      setNotificationStatus("disabled");
      return;
    }
    setNotificationStatus(result.value.granted ? "enabled" : "disabled");
  };

  useEffect(() => {
    void refreshNotifications();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshNotifications();
    });
    return () => subscription.remove();
  }, [refreshNotifications]);

  useEffect(() => {
    if (!isLoaded) {
      setLiveActivityStatus("checking");
      return;
    }
    if (!isSignedIn) {
      setLiveActivityStatus("signed-out");
      return;
    }
    if (!AsyncResult.isSuccess(preferencesResult)) {
      if (AsyncResult.isFailure(preferencesResult)) {
        reportAtomCommandResult(preferencesResult, { label: "live activity preference load" });
        setLiveActivityStatus("enabled");
      } else {
        setLiveActivityStatus("checking");
      }
      return;
    }
    setLiveActivityStatus(
      preferencesResult.value.liveActivitiesEnabled === false ? "disabled" : "enabled",
    );
  }, [isLoaded, isSignedIn, preferencesResult]);

  const requestNotifications = async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "Notifications unavailable",
          error instanceof Error ? error.message : "Could not request notification permission.",
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      if (getAgentAwarenessRegistrationStatus() === "registered") {
        Dialog.alert("Notifications enabled", "Agent notifications are enabled for this device.");
      } else {
        Dialog.alert(
          "Couldn't finish enabling notifications",
          "Notification access was granted, but this device could not be registered with styal Link. Notifications will start once registration succeeds.",
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Dialog.alert(
        "Notifications unavailable",
        "Agent notifications are unavailable on this platform.",
      );
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Dialog.alert("Notifications disabled", "Notifications were not enabled.");
      return;
    }
    Dialog.alert(
      "Notifications disabled",
      "Notifications were denied for this app. Open Settings to enable them.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  };

  const promptSignIn = () => {
    Dialog.alert(
      "Sign in to styal Link",
      "Live Activity updates require styal Link so relay can deliver updates to this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          onPress: () => navigation.navigate("SettingsAuth"),
        },
      ],
    );
  };

  const linkEnvironments = async () => {
    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    setLiveActivityStatus("linking");
    if (Platform.OS === "android") {
      const permission = await settleAsyncResult(() =>
        runtime.runPromiseExit(requestAgentNotificationPermission),
      );
      if (permission._tag === "Failure") {
        setLiveActivityStatus("disabled");
        const error = squashAtomCommandFailure(permission);
        Dialog.alert(
          "Ongoing activity unavailable",
          error instanceof Error ? error.message : "Could not enable agent notifications.",
        );
        return;
      }
      if (permission.value.type !== "granted") {
        setLiveActivityStatus("disabled");
        Dialog.alert(
          "Notification permission needed",
          "Enable notifications in system Settings to show ongoing agent activity.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ],
        );
        return;
      }
      setNotificationStatus("enabled");
    }
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (tokenResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      const error = squashAtomCommandFailure(tokenResult);
      Dialog.alert(
        Platform.OS === "android" ? "Ongoing activity unavailable" : "Live Activities unavailable",
        error instanceof Error ? error.message : "Could not enable agent activity updates.",
      );
      return;
    }
    if (!tokenResult.value) {
      promptSignIn();
      setLiveActivityStatus("signed-out");
      return;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          canConfigureEnvironment: (environmentId) =>
            readEnvironmentScope(environmentId, AuthRelayWriteScope),
          enabled: true,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: tokenResult.value,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      if (!isAtomCommandInterrupted(updateResult)) {
        const error = squashAtomCommandFailure(updateResult);
        Dialog.alert(
          Platform.OS === "android"
            ? "Ongoing activity unavailable"
            : "Live Activities unavailable",
          error instanceof Error ? error.message : "Could not enable agent activity updates.",
        );
      }
      return;
    }

    savePreferences({ liveActivitiesEnabled: true });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("enabled");
    // Environment linking can precede device registration; only registered devices can receive Live Activities.
    if (getAgentAwarenessRegistrationStatus() === "registered") {
      Dialog.alert(
        Platform.OS === "android" ? "Ongoing activity enabled" : "Live Activities enabled",
        environmentCount > 0
          ? "Agent activity updates are enabled for environments this connection can configure."
          : "Agent activity updates are enabled. Add an environment to start receiving updates.",
      );
    } else {
      Dialog.alert(
        "Couldn't finish enabling activity updates",
        "This device could not be registered with styal Link, so activity updates won't appear yet. They'll start once registration succeeds.",
      );
    }
  };

  const handleDeviceNotificationsChange = (enabled: boolean) => {
    if (enabled) {
      if (!isSignedIn) {
        promptSignIn();
        return;
      }
      if (alertsChannelOff && notificationStatus === "enabled") {
        openChannelSettings("alerts");
        return;
      }
      void requestNotifications();
      return;
    }

    if (Platform.OS === "android") {
      openChannelSettings("alerts");
      return;
    }

    Dialog.alert(
      "Disable notifications",
      "Open system Settings to disable notifications for styal.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  };

  async function disableLiveActivities() {
    let token: string | null = null;
    if (isSignedIn) {
      const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
      if (tokenResult._tag === "Failure") {
        setLiveActivityStatus("enabled");
        reportAtomCommandResult(tokenResult, {
          label: "live activity disable token lookup",
        });
        return;
      }
      token = tokenResult.value;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          canConfigureEnvironment: (environmentId) =>
            readEnvironmentScope(environmentId, AuthRelayWriteScope),
          enabled: false,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: token,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus(isSignedIn ? "enabled" : "signed-out");
      reportAtomCommandResult(updateResult, {
        label: "live activity disable",
      });
      return;
    }
    savePreferences({ liveActivitiesEnabled: false });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("disabled");
  }

  // Both writers settle their own failures, so awaiting them never throws.
  const handleLiveActivitiesChange = async (enabled: boolean) => {
    if (liveActivityWriteInFlight.current) return;
    if (enabled && activityChannelOff && liveActivityStatus === "enabled") {
      openChannelSettings("activity");
      return;
    }
    if (!enabled) {
      liveActivityWriteInFlight.current = true;
      setLiveActivityStatus("linking");
      await disableLiveActivities();
      liveActivityWriteInFlight.current = false;
      return;
    }

    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    liveActivityWriteInFlight.current = true;
    await linkEnvironments();
    liveActivityWriteInFlight.current = false;
  };

  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title="Agent activity">
          <SettingsSwitchRow
            icon="bell.badge"
            label={Platform.OS === "android" ? "Agent alerts" : "Device Notifications"}
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              notificationStatus === "checking" ||
              notificationStatus === "unsupported"
            }
            subtitle={
              agentAwarenessSubtitle ??
              (Platform.OS === "android"
                ? alertsChannelOff
                  ? OFF_IN_ANDROID_SETTINGS
                  : "When a thread finishes, fails, or needs input or approval"
                : undefined)
            }
            value={alertsEnabled}
            onValueChange={handleDeviceNotificationsChange}
          />
          <SettingsSwitchRow
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              !isLoaded ||
              liveActivityStatus === "checking" ||
              liveActivityStatus === "linking"
            }
            icon="bolt.circle"
            label={Platform.OS === "android" ? "Ongoing agent activity" : "Live Activity Updates"}
            subtitle={
              agentAwarenessSubtitle ??
              (Platform.OS === "android"
                ? activityChannelOff
                  ? OFF_IN_ANDROID_SETTINGS
                  : "Lists agents while they work"
                : undefined)
            }
            value={
              agentAwarenessPushAvailable &&
              (liveActivityStatus === "enabled" || liveActivityStatus === "linking") &&
              deviceRegistered &&
              !activityChannelOff
            }
            onValueChange={(enabled) => void handleLiveActivitiesChange(enabled)}
          />
          {liveActivityStatus === "signed-out" && canClearLiveActivitiesPreference ? (
            <SettingsRow
              icon="bolt.circle"
              label="Turn off Live Activity preference"
              onPress={() => void handleLiveActivitiesChange(false)}
            />
          ) : null}
          {supportsAndroidLiveUpdateSettings() ? (
            <SettingsRow
              icon={{ ios: "iphone", android: "smartphone" }}
              label="Live Updates"
              value="Show working agents in the status bar"
              onPress={() => {
                void openAndroidLiveUpdateSettings().catch(() => {
                  Dialog.alert(
                    "Couldn't open Settings",
                    "Open Android Settings, select styal, then enable Live Updates in Notifications.",
                  );
                });
              }}
            />
          ) : null}
        </SettingsSection>
        <SettingsSection title="Notify me when an agent">
          {ALERT_TYPES.map((alertType) => (
            <SettingsSwitchRow
              key={alertType.preference}
              icon={alertType.icon}
              label={alertType.label}
              disabled={!alertsEnabled || storedPreferences === null}
              value={storedPreferences?.[alertType.preference] !== false}
              onValueChange={(enabled) => void handleAlertTypeChange(alertType.preference, enabled)}
            />
          ))}
        </SettingsSection>
        <SettingsSection
          title="While I'm using a computer"
          footer="Alerts wait while you're active in styal on a computer, and are skipped if you handle or open the thread there first."
        >
          {ATTENDED_ALERT_DELAYS.map((delay, index) => (
            <SettingsChoiceRow
              key={delay.seconds}
              label={delay.label}
              selected={selectedAlertDelay === delay.seconds}
              separated={index > 0}
              disabled={!alertsEnabled || storedPreferences === null}
              onPress={() => void handleAlertDelayChange(delay.seconds)}
            />
          ))}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
