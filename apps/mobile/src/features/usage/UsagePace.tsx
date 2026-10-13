import type { LimitPacePresentation } from "@t3tools/shared/usageLimits";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

/** The same pace label and explanation in pooled cards, account details and the composer. */
export function PaceIndicator({
  pace,
  expanded = false,
}: {
  readonly pace: LimitPacePresentation | null;
  readonly expanded?: boolean;
}) {
  if (pace === null) return null;
  if (expanded) {
    return (
      <View className="gap-1">
        <Text className="text-xs text-foreground-tertiary">{pace.label}</Text>
        <Text className="text-xs text-foreground-muted">{pace.description}</Text>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pace.label}. ${pace.description}`}
      accessibilityHint="Show pace explanation"
      hitSlop={8}
      onPress={() => Alert.alert(pace.label, pace.description)}
      className="shrink-0 active:opacity-60"
    >
      <Text className="text-xs text-foreground-tertiary">{pace.label}</Text>
    </Pressable>
  );
}
