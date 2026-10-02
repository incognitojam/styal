import { useAtomValue } from "@effect/atom-react";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveTurnUsage,
  EMPTY_TURN_USAGE,
  type TurnUsageByTurn,
  type TurnUsageView,
} from "@t3tools/shared/turnUsage";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { Alert, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { mobilePreferencesAtom } from "../../state/preferences";

/**
 * Turn usage that keeps its identity until a usage activity arrives, so feed
 * rows keyed on it do not refresh on every streamed activity. Empty while the
 * device preference hides it.
 */
export function useTurnUsage(
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): TurnUsageByTurn {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const enabled =
    !AsyncResult.isSuccess(preferences) || preferences.value.turnUsageEnabled !== false;
  const [previous, setPrevious] = useState(EMPTY_TURN_USAGE);
  const usage = useMemo(
    () => (enabled && activities ? deriveTurnUsage(activities, previous) : EMPTY_TURN_USAGE),
    [activities, enabled, previous],
  );
  if (usage !== previous) setPrevious(usage);
  return usage;
}

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
