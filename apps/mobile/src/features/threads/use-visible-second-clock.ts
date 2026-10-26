import { useIsFocused } from "@react-navigation/native";
import { minuteTick, secondTick, type ClockStore } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

import { useAppActive } from "../../lib/appState";
import { minuteTickToEpochMs } from "../../lib/clock";

const subscribeNever = () => () => undefined;

const minuteEpochTick: ClockStore<number> = {
  subscribe: minuteTick.subscribe,
  getSnapshot: () => minuteTickToEpochMs(minuteTick.getSnapshot()),
};

/**
 * Retained routes stay mounted when hidden, so an ungated tick would keep
 * re-rendering them. Every visible label shares one module-level tick.
 */
export function useVisibleSecondClock(
  enabled: boolean,
  intervalMs: 1_000 | 60_000 = 1_000,
): number {
  const focused = useIsFocused();
  const appActive = useAppActive();
  const ticking = enabled && focused && appActive;
  const tick = intervalMs === 60_000 ? minuteEpochTick : secondTick;
  // While paused the snapshot still reads the shared tick, so resuming shows
  // the current second rather than the one the clock stopped on.
  return useSyncExternalStore(
    ticking ? tick.subscribe : subscribeNever,
    tick.getSnapshot,
    tick.getSnapshot,
  );
}
