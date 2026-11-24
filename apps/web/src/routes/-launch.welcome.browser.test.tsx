import { EnvironmentId } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";

import { emitWelcome, type FakeDriver } from "../../test/fakeEnvironment";
import {
  BOOTSTRAP_THREAD,
  expectDraftStarted,
  expectHomeHolding,
  launchApp,
  waitForProjectRows,
} from "../../test/launchApp";

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

const ENVIRONMENT = EnvironmentId.make("environment-launch-welcome");

it("lands a cold start on the bootstrap thread when the rows arrive before the welcome", async () => {
  await using app = await launchApp("/", ENVIRONMENT);
  await waitForProjectRows();
  expectHomeHolding(app);

  await emitWelcome(BOOTSTRAP_THREAD.id);
  await vi.waitFor(() => expect(app.pathname()).toBe(`/${ENVIRONMENT}/${BOOTSTRAP_THREAD.id}`));

  // A later visit to Home starts the draft at once.
  await app.navigate("/");
  await expectDraftStarted(app);
});
