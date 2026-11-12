import { Toolbar } from "../../components/ui/Toolbar";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";

import { useNavigation } from "@react-navigation/native";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { PullRequestRoutingSettings } from "./PullRequestRoutingSettings";
import { WorkTogetherSection } from "./WorkTogetherSection";

export function ConnectionsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Machines"
          onBack={() => navigation.goBack()}
          actions={[
            {
              accessibilityLabel: "Add machine",
              icon: "plus",
              onPress: () => navigation.navigate("ConnectionsNew"),
            },
          ]}
        />
      ) : (
        <Toolbar placement="right">
          <Toolbar.Button
            accessibilityLabel="Add machine"
            icon="plus"
            onPress={() => navigation.navigate("ConnectionsNew")}
            separateBackground
          />
        </Toolbar>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <WorkTogetherSection />
        <PullRequestRoutingSettings />
      </ScrollView>
    </View>
  );
}
