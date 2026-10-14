import type { LimitProjection } from "@t3tools/shared/usageLimits";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

/**
 * `Runs out in 45m` beside a window that empties before its reset; tap for the
 * figures. Account details pass `expanded` to show either outcome with its
 * figures inline.
 */
export function ProjectionLabel({
  projection,
  expanded = false,
}: {
  readonly projection: LimitProjection | null;
  readonly expanded?: boolean;
}) {
  if (projection === null) return null;
  if (expanded) {
    return (
      <View className="gap-1">
        <Text className="text-xs text-foreground-tertiary">{projection.label}</Text>
        <Text className="text-xs text-foreground-muted">{projection.description}</Text>
      </View>
    );
  }
  if (!projection.runsOut) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${projection.label}. ${projection.description}`}
      accessibilityHint="Show how this was projected"
      hitSlop={8}
      onPress={() => Alert.alert(projection.label, projection.description)}
      className="shrink-0 active:opacity-60"
    >
      <Text className="text-xs text-foreground-tertiary">{projection.label}</Text>
    </Pressable>
  );
}
