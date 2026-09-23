import type { TurnUsageView } from "@t3tools/shared/turnUsage";
import { Alert, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";

/** One muted figure; tapping it shows the token breakdown. */
export function TurnUsageText(props: { readonly view: TurnUsageView }) {
  const { view } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Turn usage: ${view.headline}`}
      accessibilityHint="Shows input, cached, and output tokens"
      hitSlop={8}
      onPress={() =>
        Alert.alert(
          `Turn usage · ${view.headline}`,
          [view.rows.map((row) => `${row.label}: ${row.value}`).join("\n"), ...view.notes].join(
            "\n\n",
          ),
        )
      }
    >
      <Text className="font-t3-medium text-xs tabular-nums text-adaptive-neutral-600-400">
        {view.headline}
      </Text>
    </Pressable>
  );
}
