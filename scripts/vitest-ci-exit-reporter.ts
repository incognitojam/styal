// @effect-diagnostics globalTimers:off - Vitest reporters run outside an Effect runtime and this timer is the process-level teardown failsafe.
import * as NodeTimers from "node:timers";

const teardownGuardMs = 15_000;
const armTeardownGuard = NodeTimers.setTimeout;

// Fork CI loads this after the default reporter so the final result is printed
// before guarding teardown. Vitest's own guard starts after its first close,
// which cannot recover when that close is the operation that hangs.
export default class VitestCiExitReporter {
  onTestRunEnd() {
    armTeardownGuard(() => {
      process.stderr.write(
        `Vitest did not exit within ${teardownGuardMs}ms after reporting its final result; forcing process exit.\n`,
      );
      process.exit(process.exitCode ?? 0);
    }, teardownGuardMs).unref();
  }
}
