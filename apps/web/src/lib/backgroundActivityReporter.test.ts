import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import {
  layer,
  observeBackgroundActivitySubscription,
  readSystemActive,
  retainedBackgroundScopes,
} from "./backgroundActivityReporter.ts";

describe("wasRecentlyInteracted", () => {
  it.effect("retains an observed subscription until its returned finalizer runs", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-observation-test");
      const scope = { type: "vcs-status" as const, cwd: "/repo" };
      const releasePassive = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd, includeRemote: false },
      });
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd },
      });

      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* releasePassive;
      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* release;
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );
});

describe("readSystemActive", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubBridge = (getSystemActive?: () => Promise<boolean>) =>
    vi.stubGlobal("window", { desktopBridge: getSystemActive ? { getSystemActive } : {} });

  it.effect("reports the desktop OS idle state", () =>
    Effect.gen(function* () {
      stubBridge(() => Promise.resolve(false));
      expect(yield* readSystemActive).toEqual(Option.some(false));
    }),
  );

  it.effect("omits the state when the bridge lacks it, fails, or stalls", () =>
    Effect.gen(function* () {
      stubBridge();
      expect(yield* readSystemActive).toEqual(Option.none());

      stubBridge(() => Promise.reject(new Error("ipc closed")));
      expect(yield* readSystemActive).toEqual(Option.none());

      stubBridge(() => new Promise<boolean>(() => undefined));
      const stalled = yield* Effect.forkChild(readSystemActive);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(stalled)).toEqual(Option.none());
    }),
  );
});

describe("layer", () => {
  beforeEach(() => {
    const target = new EventTarget();
    const listeners = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    };
    vi.stubGlobal("window", {
      ...listeners,
      localStorage: { getItem: () => "client", setItem: () => undefined },
    });
    vi.stubGlobal("document", { ...listeners, visibilityState: "visible", hasFocus: () => true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // As when an environment's connection is torn down while its report is in flight.
  it.effect("keeps reporting after a report is interrupted", () =>
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make(
        new Map([[EnvironmentId.make("environment-reporter-test"), {}]]),
      );
      let calls = 0;
      const registry = EnvironmentRegistry.EnvironmentRegistry.of({
        entries,
        run: () => {
          calls += 1;
          return calls === 1 ? Effect.failCause(Cause.interrupt()) : Effect.void;
        },
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

      yield* Layer.build(
        layer.pipe(Layer.provide(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry))),
      );
      yield* TestClock.adjust("1 second");
      expect(calls).toBe(1);

      yield* TestClock.adjust("25 seconds");
      expect(calls).toBe(2);
    }).pipe(Effect.scoped),
  );
});
