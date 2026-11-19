import { describe, expect, it } from "vite-plus/test";
import { isNativeUpdateJobMissing, isPendingNativeUpdateJob } from "./nativeUpdateJob.ts";

describe("native job liveness", () => {
  it.each([
    ["state = running\npid = 42\nlast exit code = 0", true],
    ["state = waiting\nlast exit code = 1", false],
    ["state = exited\nlast exit code = 1", false],
    ["state = not running\nlast exit code = 0", false],
    ["state = waiting", false],
    ["state = unknown", true],
    ["last exit code = 0", true],
  ])("uses current liveness rather than a historical exit: %s", (output, pending) => {
    expect(isPendingNativeUpdateJob(output)).toBe(pending);
  });
  it.each([
    [{ code: 3, stderr: 'Could not find service "synthetic.ShipIt" in domain gui: 501' }, true],
    [{ code: 113, stderr: 'Could not find service "synthetic.ShipIt" in domain system' }, true],
    [{ code: 113, stderr: "Operation not permitted" }, false],
    [{ code: 3, stderr: 'Could not find service "other.ShipIt" in domain system' }, false],
    [{ code: 1, stderr: "Permission denied" }, false],
    [{ code: 113 }, false],
  ])("requires a service-specific not-found diagnostic: %o", (error, absent) => {
    expect(isNativeUpdateJobMissing(error, "synthetic.ShipIt")).toBe(absent);
  });
});
