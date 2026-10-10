import type { TurnUsageView } from "@t3tools/shared/turnUsage";
import { Alert, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";

/** One muted figure; tapping it shows the token breakdown. */
export function TurnUsageText(props: {
  readonly view: TurnUsageView;
  /** Titles the breakdown and names the figure for screen readers. */
  readonly subject?: string;
}) {
  const { view, subject = "Turn usage" } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${subject}: ${view.headline}`}
      accessibilityHint="Shows input, cached, and output tokens"
      hitSlop={8}
      onPress={() =>
        Alert.alert(
          `${subject} · ${view.headline}`,
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
