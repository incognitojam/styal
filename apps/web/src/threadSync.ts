import type {
  EnvironmentShellStatus,
  ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

export type ThreadSyncPhase = "loading" | "syncing";

export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
}): ThreadSyncPhase | null {
  if (!input.shellExists) {
    return null;
  }

  switch (input.status) {
    case "empty":
    case "cached":
    case "synchronizing":
      return input.detailExists ? "syncing" : "loading";
    case "deleted":
    case "live":
      return null;
  }
}

export function threadSyncLabel(phase: ThreadSyncPhase): string {
  return phase === "loading" ? "Loading messages..." : "Syncing messages...";
}

export type ThreadActivityState = "live" | "unconfirmed" | "inactive";

export function resolveThreadActivityState(input: {
  readonly detailStatus: EnvironmentThreadStatus;
  readonly detailServerSequence?: number | undefined;
  readonly shellStatus: EnvironmentShellStatus;
  readonly shellSequence: number;
  readonly shell: {
    readonly runtime: Pick<ThreadRuntimeSummary, "status"> | null;
    readonly hasPendingApprovals: boolean;
    readonly hasPendingUserInput: boolean;
  } | null;
}): ThreadActivityState {
  const detailSequence = input.detailServerSequence;
  const detailIsLive = input.detailStatus === "live" && detailSequence !== undefined;
  const summaryIsCurrent =
    input.shellStatus === "live" &&
    (detailSequence === undefined ||
      input.shellSequence > detailSequence ||
      (!detailIsLive && input.shellSequence === detailSequence));
  const shell = input.shell;
  if (
    summaryIsCurrent &&
    shell !== null &&
    (shell.hasPendingApprovals ||
      shell.hasPendingUserInput ||
      shell.runtime === null ||
      !["preparing", "queued", "starting", "running", "waiting"].includes(shell.runtime.status))
  ) {
    return "inactive";
  }
  return detailIsLive ? "live" : "unconfirmed";
}
