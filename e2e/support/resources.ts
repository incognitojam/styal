// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - plain Node e2e resource ownership.
import type * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { hasTestFailed, markFailed } from "./failures.ts";

/** Owns startup resources immediately, including when setup fails before readiness. */
export function stateResources(prefix: string) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  const resources = new AsyncDisposableStack();
  return {
    root,
    resources,
    stop: async () => {
      try {
        await resources.disposeAsync();
      } catch (error) {
        markFailed();
        throw error;
      } finally {
        if (process.env.E2E_KEEP_STATE || hasTestFailed()) {
          process.stderr.write(`e2e state kept at ${root}\n`);
        } else {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }
    },
  };
}

/** Captures spawn errors and owns the child before waiting for any startup output. */
export function ownProcess(
  resources: AsyncDisposableStack,
  child: NodeChildProcess.ChildProcess,
  killAfterMs: number,
): () => void {
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  resources.defer(async () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
  });
  return () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited (code ${child.exitCode}, signal ${child.signalCode}).`);
    }
  };
}
