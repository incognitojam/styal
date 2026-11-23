import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import * as ConnectionStorage from "~/connection/storage";
import { environmentShell } from "~/state/shell";
import { shellSnapshot, type FakeDriver } from "../../test/fakeEnvironment";
import { expectDraftStarted, launchApp, shellState } from "../../test/launchApp";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const ENVIRONMENT = EnvironmentId.make("environment-launch-cached");

it.effect("does not hold Home for the welcome when the primary shell started from the cache", () =>
  Effect.gen(function* () {
    const cache = yield* Persistence.EnvironmentCacheStore;
    yield* cache.saveShell(ENVIRONMENT, shellSnapshot());
    yield* Effect.promise(async () => {
      // Outlives the app, so the shell refreshed before it mounts is the one the app reads.
      using shellSubscription = new DisposableStack();
      await using app = await launchApp("/", ENVIRONMENT, async () => {
        // Home first sees rows the server has already refreshed, as when it mounts late.
        shellSubscription.defer(
          appAtomRegistry.mount(environmentShell.stateValueAtom(ENVIRONMENT)),
        );
        await vi.waitFor(() => {
          const state = shellState(ENVIRONMENT);
          expect(state.restoredFromCache).toBe(true);
          expect(state.generation).toBeGreaterThan(0);
        });
      });

      await expectDraftStarted(app);
    });
  }).pipe(Effect.provide(ConnectionStorage.layer)),
);
