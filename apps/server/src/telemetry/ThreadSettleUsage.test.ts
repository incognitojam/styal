import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as AnalyticsService from "./AnalyticsService.ts";
import * as ThreadSettleUsage from "./ThreadSettleUsage.ts";

describe("previousSettleReason", () => {
  it("reports the rule that settled the thread being un-settled", () => {
    const settled = (settleReason: Parameters<typeof ThreadSettleUsage.previousSettleReason>[0]) =>
      ThreadSettleUsage.previousSettleReason(settleReason);
    expect(settled({ settledOverride: "settled", settleReason: { kind: "user" } })).toBe("user");
    expect(
      settled({
        settledOverride: "settled",
        settleReason: { kind: "pull_request", state: "closed", number: 3, url: "https://x/3" },
      }),
    ).toBe("closed");
    expect(
      settled({ settledOverride: "settled", settleReason: { kind: "inactivity", days: 3 } }),
    ).toBe("inactivity");
    // Settled before reasons were recorded, or not settled at all.
    expect(settled({ settledOverride: "settled" })).toBe("unknown");
    expect(settled({ settledOverride: null, settleReason: { kind: "user" } })).toBe("unknown");
    expect(settled(undefined)).toBe("unknown");
  });
});

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
