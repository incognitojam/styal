import type { HostActivity, HostActivityThread } from "@t3tools/contracts";

export type HostActivityCheck = HostActivity & {
  readonly hostLabel?: string;
  readonly continueRunningThreads?: boolean;
};

const reasonLabels: Record<HostActivityThread["reasons"][number], string> = {
  preparing: "Preparing a turn",
  starting: "Starting a turn",
  running: "Running a turn",
  input: "Waiting for your input",
  approval: "Waiting for approval",
  waiting: "Waiting for input or approval",
  command: "Running a background command",
  monitor: "Running a monitor",
  subagent: "Running a subagent",
  background_task: "Running a background task",
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
  const threadLines: string[] = [];
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
      threadLines.push(
        `Thread names and activity reasons are unavailable${check.hostLabel ? ` for ${singleLine(check.hostLabel)}` : " from this server"}.`,
      );
    }
    for (const thread of check.threads ?? []) {
      const context = [thread.projectTitle, check.hostLabel]
        .filter((value): value is string => Boolean(value))
        .map(singleLine)
        .join(" · ");
      const reasons = thread.reasons.map((reason) => reasonLabels[reason]);
      if (continueThreads && thread.continuable) reasons.push("Continues after restart");
      threadLines.push(
        `• ${singleLine(thread.title) || "Untitled thread"}${context ? ` (${context})` : ""}\n  ${reasons.join("; ")}`,
      );
    }
    terminals += check.terminalsRequiringConfirmation - check.terminalsWithUnknownActivity;
    uncheckedTerminals += check.terminalsWithUnknownActivity;
    deviceUsers += check.environmentsUsingDevices;
  }
  const lines: string[] = [];
  if (active - continuing)
    lines.push(`${plural(active - continuing, "thread")} will be interrupted.`);
  if (continuing) lines.push(`${plural(continuing, "thread")} will continue after the restart.`);
  if (waiting)
    lines.push(`${plural(waiting, "thread")} waiting for input or approval will be interrupted.`);
  if (terminals) lines.push(`${plural(terminals, "terminal session")} will be interrupted.`);
  if (deviceUsers) lines.push("Devices in use by other environments will be disconnected.");
  if (uncheckedTerminals)
    lines.push(
      `Could not check ${plural(uncheckedTerminals, "terminal session")} for running commands.`,
    );
  if (uncheckedHosts) lines.push(options.uncheckedHostsLine);
  if (threadLines.length) lines.push("", ...threadLines);
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
    incomplete: uncheckedHosts || uncheckedTerminals > 0,
  };
}
