import { expect, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as AnalyticsService from "./AnalyticsService.ts";
import { commandFeatureUsage } from "./FeatureUsage.ts";
import * as ProviderSignInRecoveryUsage from "./ProviderSignInRecoveryUsage.ts";

it.effect("records each step with no thread data", () =>
  Effect.gen(function* () {
    const records = yield* Ref.make<ReadonlyArray<readonly [string, unknown]>>([]);
    const analytics = Layer.mock(AnalyticsService.AnalyticsService)({
      record: (event, properties) =>
        Ref.update(records, (all) => [...all, [event, properties] as const]),
    });
    yield* ProviderSignInRecoveryUsage.record("resume").pipe(Effect.provide(analytics));
    expect(yield* Ref.get(records)).toEqual([
      ["feature.used", { feature: "provider-sign-in", source: "system", action: "resume" }],
    ]);
  }),
);

it("counts a person changing a thread's wait, not the worker arming it", () => {
  const update = (authRecovery: { readonly waiting?: boolean; readonly signedOutSeen?: boolean }) =>
    commandFeatureUsage({
      type: "thread.metadata.update",
      commandId: CommandId.make("command"),
      threadId: ThreadId.make("thread"),
      authRecovery: { runId: RunId.make("run"), ...authRecovery },
    });
  expect(update({ waiting: false })).toEqual({
    feature: "provider_sign_in.wait",
    variant: "off",
  });
  expect(update({ waiting: true, signedOutSeen: true })).toBeUndefined();
  expect(update({ signedOutSeen: true })).toBeUndefined();
});
