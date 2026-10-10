import type { TurnUsageView } from "@t3tools/shared/turnUsage";
import { Alert, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";

/** One figure; tapping it shows the token breakdown. */
export function TurnUsageText(props: {
  readonly view: TurnUsageView;
  /** Titles the breakdown and names the figure for screen readers. */
  readonly subject?: string;
  /** `secondary` matches a message's timestamp; `muted` sits among composer controls. */
  readonly tone?: "secondary" | "muted";
}) {
  const { view, subject = "Turn usage", tone = "muted" } = props;
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
      <Text
        className={
          tone === "secondary"
            ? "font-t3-medium text-xs tabular-nums text-foreground-secondary"
            : "font-t3-medium text-xs tabular-nums text-adaptive-neutral-600-400"
        }
      >
        {view.headline}
      </Text>
    </Pressable>
  );
}
