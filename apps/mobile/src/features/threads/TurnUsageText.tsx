import { usageFigureText, type TurnUsageView } from "@t3tools/shared/turnUsage";
import { Alert, Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useTurnUsageFigure } from "../../state/use-turn-usage";

/**
 * A turn's tokens or cost, as the device prefers, styled like the message
 * timestamp beside it; tapping it shows the breakdown.
 */
export function TurnUsageText(props: { readonly view: TurnUsageView }) {
  const { view } = props;
  const figure = useTurnUsageFigure();
  const text = usageFigureText(view, figure);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Turn usage: ${text}`}
      accessibilityHint="Shows the tokens and estimated cost"
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
      <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">{text}</Text>
    </Pressable>
  );
}
