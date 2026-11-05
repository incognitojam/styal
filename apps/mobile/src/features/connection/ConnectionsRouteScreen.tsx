import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";

import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { PullRequestRoutingSettings } from "./PullRequestRoutingSettings";
import { WorkTogetherSection } from "./WorkTogetherSection";

export function ConnectionsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar
        title="Machines"
        onClose={() => navigation.goBack()}
        closeAccessibilityLabel="Close machines"
        actions={[
          {
            accessibilityLabel: "Add machine",
            icon: "plus",
            onPress: () => navigation.navigate("ConnectionsNew"),
          },
        ]}
      />
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
