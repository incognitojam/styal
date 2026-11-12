import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Platform, RefreshControl } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { WorkTogetherSection } from "../connection/WorkTogetherSection";
import { PullRequestRoutingSettings } from "../connection/PullRequestRoutingSettings";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
export function SettingsEnvironmentsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const headerIconColor = useUniwindTheme()["--color-icon"];
  const relaySession = useAtomValue(managedRelaySessionAtom);
  const refreshRelayEnvironments = useAtomCommand(
    relayEnvironmentDiscovery.refresh,
    "relay environment refresh",
  );
  const [isRefreshingCloud, setIsRefreshingCloud] = useState(false);
  const cloudRefreshPendingRef = useRef(false);
  async function refreshCloudEnvironments() {
    if (!relaySession || cloudRefreshPendingRef.current) return;
    cloudRefreshPendingRef.current = true;
    setIsRefreshingCloud(true);
    await refreshRelayEnvironments();
    cloudRefreshPendingRef.current = false;
    setIsRefreshingCloud(false);
  }

  const openEnvironment = (environmentId: EnvironmentId) => {
    navigation.navigate("SettingsEnvironmentDetail", { environmentId });
  };

  return (
    <SettingsScreen
      title="Machines"
      trailing={
        Platform.OS === "android" && relaySession ? (
          <AndroidAnchoredMenu
            title="Environment options"
            actions={[
              {
                id: "refresh",
                title: "Refresh cloud environments",
                attributes: { disabled: isRefreshingCloud },
              },
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "refresh") void refreshCloudEnvironments();
            }}
          >
            {(open) => (
              <AndroidHeaderIconButton
                accessibilityLabel="Environment options"
                icon="ellipsis"
                onPress={open}
              />
            )}
          </AndroidAnchoredMenu>
        ) : undefined
      }
      actions={[
        {
          accessibilityLabel: "Add machine",
          icon: "plus",
          tintColor: headerIconColor,
          onPress: () => navigation.navigate("SettingsEnvironmentNew"),
        },
      ]}
    >
      <ScrollView
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
        refreshControl={
          relaySession ? (
            <RefreshControl
              refreshing={isRefreshingCloud}
              onRefresh={() => void refreshCloudEnvironments()}
            />
          ) : undefined
        }
      >
        <WorkTogetherSection onOpenEnvironment={openEnvironment} />
        <PullRequestRoutingSettings />
      </ScrollView>
    </SettingsScreen>
  );
}
