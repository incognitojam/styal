import { usageFigureText, type TurnUsageView } from "@t3tools/shared/turnUsage";
import { Alert, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useTurnUsageFigure } from "../../state/use-turn-usage";
import { MeterText } from "./MeterText";

/**
 * Tokens or cost, as the device prefers; tapping it shows the breakdown. With
 * `meterKey`, a changing cost rolls like a meter.
 */
export function TurnUsageText(props: {
  readonly view: TurnUsageView;
  /** Titles the breakdown and names the figure for screen readers. */
  readonly subject?: string;
  /** `secondary` matches a message's timestamp; `muted` sits among composer controls. */
  readonly tone?: "secondary" | "muted";
  /** Identifies what the figure counts, e.g. the thread; see `MeterText`. */
  readonly meterKey?: string;
}) {
  const { view, subject = "Turn usage", tone = "muted", meterKey } = props;
  const figure = useTurnUsageFigure();
  const text = usageFigureText(view, figure);
  const className =
    tone === "secondary"
      ? "font-t3-medium text-xs tabular-nums text-foreground-secondary"
      : "font-t3-medium text-xs tabular-nums text-adaptive-neutral-600-400";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${subject}: ${text}`}
      accessibilityHint="Shows the tokens and estimated cost"
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
      {meterKey !== undefined && figure === "cost" ? (
        <MeterText text={text} meterKey={meterKey} className={className} />
      ) : (
        <Text className={className}>{text}</Text>
      )}
    </Pressable>
  );
}
