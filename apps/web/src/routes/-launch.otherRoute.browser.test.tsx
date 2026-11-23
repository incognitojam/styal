import { EnvironmentId } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";

import type { FakeDriver } from "../../test/fakeEnvironment";
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

const ENVIRONMENT = EnvironmentId.make("environment-launch-other-route");

it("does not hold Home for the welcome when the page load started on another route", async () => {
  await using app = await launchApp("/settings/general", ENVIRONMENT);
  await vi.waitFor(() => expect(shellState(ENVIRONMENT).snapshot._tag).toBe("Some"));

  await app.navigate("/");
  await expectDraftStarted(app);
});
