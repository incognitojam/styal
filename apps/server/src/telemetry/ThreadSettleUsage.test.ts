import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as AnalyticsService from "./AnalyticsService.ts";
import * as ThreadSettleUsage from "./ThreadSettleUsage.ts";

describe("recordAutoSettle", () => {
  it.effect("records the rule and the inactivity threshold only", () =>
    Effect.gen(function* () {
      const records = yield* Ref.make<ReadonlyArray<readonly [string, unknown]>>([]);
      const analytics = Layer.mock(AnalyticsService.AnalyticsService)({
        record: (event, properties) =>
          Ref.update(records, (all) => [...all, [event, properties] as const]),
      });
      yield* ThreadSettleUsage.recordAutoSettle("merged", null).pipe(Effect.provide(analytics));
      yield* ThreadSettleUsage.recordAutoSettle("inactivity", 5).pipe(Effect.provide(analytics));
      expect(yield* Ref.get(records)).toEqual([
        ["server.thread.settled", { reason: "merged" }],
        ["server.thread.settled", { reason: "inactivity", afterDays: 5 }],
      ]);
    }),
  );
});
