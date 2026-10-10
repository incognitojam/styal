import { useState } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  type EntryAnimationsValues,
  useReducedMotion,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import { meterWheels } from "@t3tools/shared/turnUsage";

import { AppText as Text } from "../../components/AppText";

const ROLL_TIMING = { duration: 450, easing: Easing.out(Easing.cubic) };

/** Brings a wheel's new digit up from below. */
function rollIn(delay: number) {
  return (values: EntryAnimationsValues) => {
    "worklet";
    return {
      initialValues: { transform: [{ translateY: values.targetHeight }] },
      animations: { transform: [{ translateY: withDelay(delay, withTiming(0, ROLL_TIMING)) }] },
    };
  };
}

/** Carries a wheel's old digit up and out. */
function rollOut(delay: number) {
  return (values: EntryAnimationsValues) => {
    "worklet";
    return {
      initialValues: { transform: [{ translateY: 0 }] },
      animations: {
        transform: [
          { translateY: withDelay(delay, withTiming(-values.targetHeight, ROLL_TIMING)) },
        ],
      },
    };
  };
}

/**
 * Text whose changed digits roll up once, like a meter's wheels, when it
 * changes under the same `meterKey`. A new key, or reduced motion, shows the
 * text as it is.
 */
export function MeterText(props: {
  readonly text: string;
  readonly meterKey: string;
  readonly className: string;
}) {
  const { text, meterKey, className } = props;
  const reduceMotion = useReducedMotion();
  const [shown, setShown] = useState({ text, meterKey, previous: null as string | null, roll: 0 });
  if (shown.text !== text || shown.meterKey !== meterKey) {
    setShown({
      text,
      meterKey,
      previous: shown.meterKey === meterKey ? shown.text : null,
      roll: shown.roll + 1,
    });
  }
  const previous = shown.previous;
  if (previous === null || reduceMotion) return <Text className={className}>{text}</Text>;

  return (
    <View className="flex-row">
      {meterWheels(previous, text).map(({ position, char, before, rolls }) => {
        if (!rolls) {
          return (
            <Text key={position} className={className}>
              {char}
            </Text>
          );
        }
        // The rightmost wheel turns first.
        const delay = position * 40;
        return (
          <View key={`${shown.roll}:${position}`} className="overflow-hidden">
            <Animated.View entering={rollIn(delay)}>
              <Text className={className}>{char}</Text>
            </Animated.View>
            {before !== undefined ? (
              <Animated.View
                entering={rollOut(delay)}
                style={{ position: "absolute", top: 0, left: 0, right: 0 }}
              >
                <Text className={className}>{before}</Text>
              </Animated.View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
