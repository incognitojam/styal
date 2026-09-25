import type { HostActivity } from "@t3tools/contracts";

export type HostActivityConcern = "running" | "waiting" | "unchecked";

/** Title endings, e.g. `Quit ${hostActivityQuestion.running}`. */
export const hostActivityQuestion: Record<HostActivityConcern, string> = {
  running: "with running work?",
  waiting: "with waiting threads?",
  unchecked: "without checking activity?",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Describes the work a restart of one or more hosts would interrupt. A null
 * check (or an empty list) is a host whose activity could not be read, and is
 * reported with `uncheckedHostsLine`. `concern` is null when every host was
 * checked and nothing needs confirmation.
 */
export function describeHostActivity(
  checks: ReadonlyArray<HostActivity | null>,
  options: {
    readonly uncheckedHostsLine: string;
    /** Active threads resume after the restart instead of being lost. */
    readonly continueRunningThreads?: boolean;
  },
): {
  readonly concern: HostActivityConcern | null;
  readonly lines: ReadonlyArray<string>;
  /** Some host or terminal could not be inspected. */
  readonly incomplete: boolean;
} {
  let active = 0;
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
    waiting += check.waitingSessions;
    terminals += check.terminalsRequiringConfirmation - check.terminalsWithUnknownActivity;
    uncheckedTerminals += check.terminalsWithUnknownActivity;
  }
  const lines: string[] = [];
  if (active)
    lines.push(
      options.continueRunningThreads
        ? `${plural(active, "thread")} will restart and continue afterwards.`
        : `${plural(active, "thread")} will be interrupted.`,
    );
  if (waiting)
    lines.push(`${plural(waiting, "thread")} waiting for input or approval will be interrupted.`);
  if (terminals) lines.push(`${plural(terminals, "terminal session")} will be interrupted.`);
  if (uncheckedTerminals)
    lines.push(
      `Activity could not be checked for ${plural(uncheckedTerminals, "terminal session")}.`,
    );
  if (uncheckedHosts) lines.push(options.uncheckedHostsLine);
  return {
    concern:
      active || terminals ? "running" : waiting ? "waiting" : lines.length ? "unchecked" : null,
    lines,
    incomplete: uncheckedHosts || uncheckedTerminals > 0,
  };
}
