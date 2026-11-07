import type { AutoPullOutcome } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class AutoPullStatus extends Context.Service<
  AutoPullStatus,
  {
    readonly record: (
      cwd: string,
      outcome: AutoPullOutcome["outcome"],
      detail?: string,
    ) => Effect.Effect<void>;
    readonly get: (cwd: string) => Effect.Effect<AutoPullOutcome | null>;
  }
>()("@styal/cli/vcs/AutoPullStatus") {}

export const layer = Layer.effect(
  AutoPullStatus,
  Effect.gen(function* () {
    const results = yield* Ref.make(new Map<string, AutoPullOutcome>());
    return AutoPullStatus.of({
      record: Effect.fn("AutoPullStatus.record")(function* (cwd, outcome, detail) {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        yield* Ref.update(results, (previous) =>
          new Map(previous).set(cwd, {
            checkedAt,
            outcome,
            ...(detail === undefined ? {} : { detail }),
          }),
        );
      }),
      get: Effect.fn("AutoPullStatus.get")((cwd) =>
        Ref.get(results).pipe(Effect.map((results) => results.get(cwd) ?? null)),
      ),
    });
  }),
);
