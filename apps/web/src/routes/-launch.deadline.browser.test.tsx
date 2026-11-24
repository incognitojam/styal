import { EARLY_LOAD_GRACE } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import { it, vi } from "vite-plus/test";

import type { FakeDriver } from "../../test/fakeEnvironment";
import {
  expectDraftStarted,
  expectHomeHolding,
  launchApp,
  waitForProjectRows,
} from "../../test/launchApp";
import { act, fakeTimers } from "../../test/render";

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

const ENVIRONMENT = EnvironmentId.make("environment-launch-deadline");

it("starts the draft when the welcome misses the launch deadline", async () => {
  // Before the app mounts, since the launch arms its deadline as the rows arrive. Real time
  // still runs the app; the test only jumps over the deadline.
  using _timers = fakeTimers({ shouldAdvanceTime: true });
  await using app = await launchApp("/", ENVIRONMENT);
  await waitForProjectRows();
  expectHomeHolding(app);

  await act(() => vi.advanceTimersByTimeAsync(Duration.toMillis(EARLY_LOAD_GRACE)));
  await expectDraftStarted(app);
});
