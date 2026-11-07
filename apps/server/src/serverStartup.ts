import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ServerStartupCopyProgress } from "@t3tools/contracts";

export class StartupStatus extends Context.Reference<() => ServerStartupCopyProgress | null>(
  "styal/StartupStatus",
  { defaultValue: () => () => null },
) {}

export const makeStartupStatus = Effect.fn("ServerStartup.makeStatus")(function* () {
  const clock = yield* Clock.Clock;
  const now = () => Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n);
  let state: { progress: ServerStartupCopyProgress; at: number } | null = null;
  return {
    current: () =>
      state === null
        ? null
        : {
            ...state.progress,
            leaseMs: Math.max(0, state.progress.leaseMs - (now() - state.at)),
          },
    report: (progress: ServerStartupCopyProgress | null) =>
      Effect.sync(() => {
        state = progress === null ? null : { progress, at: now() };
      }),
  };
});

export const prepareBeforeRuntime = Effect.fn("ServerStartup.prepareBeforeRuntime")(function* <
  E,
  R,
  E2,
  R2,
>(enabled: boolean, listen: Effect.Effect<void, E, R>, prepare: Effect.Effect<void, E2, R2>) {
  if (enabled) {
    yield* listen;
    yield* prepare;
  }
});
