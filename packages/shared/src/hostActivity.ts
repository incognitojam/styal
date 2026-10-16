import type {
  ConfirmDialogThreadActivity,
  HostActivity,
  HostActivityThread,
} from "@t3tools/contracts";

export type HostActivityCheck = HostActivity & {
  readonly hostLabel?: string;
  readonly continueRunningThreads?: boolean;
};

/** Short labels for the restart warning's per-thread status badges. */
export const hostActivityReasonLabels: Record<HostActivityThread["reasons"][number], string> = {
  preparing: "Preparing",
  starting: "Starting",
  running: "Running",
  input: "Needs input",
  approval: "Needs approval",
  waiting: "Waiting",
  command: "Background command",
  monitor: "Monitor",
  subagent: "Subagent",
  background_task: "Background task",
};

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export type HostActivityConcern = "running" | "waiting" | "unchecked";

/**
 * Title endings, e.g. `Quit${hostActivityQuestion.running}`. A failed check
 * asks plainly; the description says what could not be checked.
 */
export const hostActivityQuestion: Record<HostActivityConcern, string> = {
  running: " with running work?",
  waiting: " with waiting threads?",
  unchecked: "?",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Describes the work a restart of one or more hosts would stop. A null
 * check (or an empty list) is a host whose activity could not be read, and is
 * reported with `uncheckedHostsLine`. `concern` is null when every host was
 * checked and nothing needs confirmation.
 */
export function describeHostActivity(
  checks: ReadonlyArray<HostActivityCheck | null>,
  options: {
    readonly uncheckedHostsLine: string;
    /** Thread continuation is requested, so continuable threads resume after the restart. */
    readonly continueRunningThreads?: boolean;
  },
): {
  readonly concern: HostActivityConcern | null;
  readonly lines: ReadonlyArray<string>;
  readonly threadActivity: ReadonlyArray<ConfirmDialogThreadActivity>;
  /** Some host or terminal could not be inspected. */
  readonly incomplete: boolean;
} {
  let active = 0;
  let continuing = 0;
  let waiting = 0;
  let terminals = 0;
  let uncheckedTerminals = 0;
  let deviceUsers = 0;
  let uncheckedHosts = checks.length === 0;
  const threadWarnings: string[] = [];
  const threadActivity: ConfirmDialogThreadActivity[] = [];
  for (const check of checks) {
    if (check === null) {
      uncheckedHosts = true;
      continue;
    }
    active += check.activeSessions;
    const continueThreads = check.continueRunningThreads ?? options.continueRunningThreads;
    if (continueThreads) continuing += check.continuableSessions;
    waiting += check.waitingSessions;
    if (check.threads === undefined && check.activeSessions + check.waitingSessions > 0) {
      threadWarnings.push(
        `Thread names and activity reasons are unavailable${check.hostLabel ? ` for ${singleLine(check.hostLabel)}` : " from this server"}.`,
      );
    }
    for (const thread of check.threads ?? []) {
      threadActivity.push({
        thread,
        ...(check.environmentId ? { environmentId: check.environmentId } : {}),
        hostLabel: check.hostLabel ?? null,
        continuesAfterRestart: Boolean(continueThreads && thread.continuable),
      });
    }
    terminals += check.terminalsRequiringConfirmation - check.terminalsWithUnknownActivity;
    uncheckedTerminals += check.terminalsWithUnknownActivity;
    deviceUsers += check.environmentsUsingDevices;
  }
  const lines: string[] = [];
  const interrupted = [
    ...(active - continuing + waiting ? [plural(active - continuing + waiting, "thread")] : []),
    ...(terminals ? [plural(terminals, "terminal session")] : []),
  ];
  if (interrupted.length) lines.push(`${interrupted.join(" and ")} will be interrupted.`);
  if (continuing) lines.push(`${plural(continuing, "thread")} will continue after the restart.`);
  if (deviceUsers) lines.push("Devices in use by other environments will be disconnected.");
  if (uncheckedTerminals)
    lines.push(
      `Could not check ${plural(uncheckedTerminals, "terminal session")} for running commands.`,
    );
  if (uncheckedHosts) lines.push(options.uncheckedHostsLine);
  if (threadWarnings.length) lines.push("", ...threadWarnings);
  return {
    concern:
      active || terminals || deviceUsers
        ? "running"
        : waiting
          ? "waiting"
          : lines.length
            ? "unchecked"
            : null,
    lines,
    threadActivity,
    incomplete: uncheckedHosts || uncheckedTerminals > 0,
  };
}
