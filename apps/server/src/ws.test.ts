import { assert, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  hasCompatibleOrchestrationProtocol,
  recordAcceptedClientCommandAnalytics,
  resolveAvailableEditorsForConfig,
  shouldUseBoundedThreadSnapshot,
} from "./ws.ts";

it("accepts only the current orchestration protocol before websocket RPC setup", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  assert.isFalse(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
});

it("keeps full thread snapshot fallback unless the client opts into bounded history", () => {
  assert.isFalse(shouldUseBoundedThreadSnapshot({}));
  assert.isFalse(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: false }));
  assert.isTrue(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: true }));
});

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

it.effect(
  "records accepted lifecycle outcomes with client metadata and ignores rejected commands",
  () =>
    Effect.gen(function* () {
      const records: Array<{ event: string; properties?: Readonly<Record<string, unknown>> }> = [];
      const analytics = {
        record: (event: string, properties?: Readonly<Record<string, unknown>>) =>
          Effect.sync(() => {
            records.push({ event, ...(properties === undefined ? {} : { properties }) });
          }),
      };
      const properties = { clientSurface: "mobile", appVersion: "1.2.3" };
      for (const type of [
        "thread.settle",
        "thread.unsettle",
        "thread.archive",
        "thread.unarchive",
        "thread.delete",
      ] as const) {
        yield* Effect.succeed("accepted").pipe(
          Effect.tap(() => recordAcceptedClientCommandAnalytics({ type }, analytics, properties)),
        );
      }
      yield* Effect.fail("rejected").pipe(
        Effect.tap(() =>
          recordAcceptedClientCommandAnalytics({ type: "thread.delete" }, analytics, properties),
        ),
        Effect.ignore,
      );
      yield* recordAcceptedClientCommandAnalytics({ type: "thread.pin" }, analytics, properties);
      assert.deepEqual(
        records,
        ["settled", "unsettled", "archived", "unarchived", "deleted"].map((outcome) => ({
          event: `client.thread.${outcome}`,
          properties,
        })),
      );
    }),
);
