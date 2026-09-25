import type { HostActivity } from "@t3tools/contracts";

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
  checks: ReadonlyArray<HostActivity | null>,
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
  let uncheckedHosts = checks.length === 0;
  for (const check of checks) {
    if (check === null) {
      uncheckedHosts = true;
      continue;
    }
    active += check.activeSessions;
    if (options.continueRunningThreads) continuing += check.continuableSessions;
    waiting += check.waitingSessions;
    terminals += check.terminalsRequiringConfirmation - check.terminalsWithUnknownActivity;
    uncheckedTerminals += check.terminalsWithUnknownActivity;
  }
  const lines: string[] = [];
  if (active - continuing)
    lines.push(`${plural(active - continuing, "thread")} will be interrupted.`);
  if (continuing) lines.push(`${plural(continuing, "thread")} will continue after the restart.`);
  if (waiting)
    lines.push(`${plural(waiting, "thread")} waiting for input or approval will be interrupted.`);
  if (terminals) lines.push(`${plural(terminals, "terminal session")} will be interrupted.`);
  if (uncheckedTerminals)
    lines.push(
      `Could not check ${plural(uncheckedTerminals, "terminal session")} for running commands.`,
    );
  if (uncheckedHosts) lines.push(options.uncheckedHostsLine);
  return {
    concern:
      active || terminals ? "running" : waiting ? "waiting" : lines.length ? "unchecked" : null,
    lines,
    incomplete: uncheckedHosts || uncheckedTerminals > 0,
  };
}
