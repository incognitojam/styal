import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";

import { __holdClientSettingsHydrationForTests } from "~/hooks/useSettings";
import { useLaunchNavigationStore } from "~/launchNavigationStore";
import { emitWelcome, type FakeDriver } from "../../test/fakeEnvironment";
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

const ENVIRONMENT = EnvironmentId.make("environment-launch-settings-pending");

it("ends the launch on a welcome that arrives while settings still load", async () => {
  let releaseSettings = () => {};
  await using app = await launchApp("/", ENVIRONMENT, async () => {
    releaseSettings = __holdClientSettingsHydrationForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
  });
  await vi.waitFor(() => expect(shellState(ENVIRONMENT).snapshot._tag).toBe("Some"));
  expect(useLaunchNavigationStore.getState().launchPending).toBe(true);

  // The first-run gate keeps the app's event router unmounted while settings load.
  await emitWelcome();
  await vi.waitFor(() => expect(useLaunchNavigationStore.getState().launchPending).toBe(false));

  releaseSettings();
  await expectDraftStarted(app);
});
