import type { HostActivity } from "@t3tools/contracts";
import { describeHostActivity, hostActivityQuestion } from "@t3tools/shared/hostActivity";

export interface ServerUpdateHost {
  readonly serverLabel: string;
  /** Null when the host could not be checked. */
  readonly activity: HostActivity | null;
  readonly desktopApp: boolean;
  readonly continueRunningThreads: boolean;
}

function labels(hosts: ReadonlyArray<ServerUpdateHost>): string {
  return hosts.map((host) => host.serverLabel).join(", ");
}

/**
 * Confirmation copy for updating one or more servers together, or null when
 * the update can start without asking. Desktop app updates always confirm
 * because they relaunch the remote app.
 */
export function serverUpdateConfirmation(hosts: ReadonlyArray<ServerUpdateHost>): string | null {
  const single = hosts.length === 1 ? hosts[0]! : null;
  const unchecked = hosts.filter((host) => host.activity === null);
  const { concern, lines, incomplete } = describeHostActivity(
    // Continuation is chosen per host, so continuable threads only count on
    // hosts that asked for it.
    hosts.map(({ activity, continueRunningThreads }) =>
      activity && !continueRunningThreads ? { ...activity, continuableSessions: 0 } : activity,
    ),
    {
      uncheckedHostsLine: single
        ? `Could not check the ${single.serverLabel} for running work.`
        : `Could not check ${labels(unchecked)} for running work.`,
      continueRunningThreads: true,
    },
  );
  const desktopApps = hosts.filter((host) => host.desktopApp);
  if (desktopApps.length > 0) {
    return [
      single
        ? `Update the styal desktop app that runs the ${single.serverLabel}?`
        : `Update the styal desktop ${desktopApps.length === 1 ? "app" : "apps"} on ${labels(desktopApps)}?`,
      desktopApps.length === 1
        ? "It will close and relaunch on that machine."
        : "They will close and relaunch on those machines.",
      ...lines,
    ].join("\n");
  }
  if (concern === null) return null;
  const target = single ? single.serverLabel : `servers on ${labels(hosts)}`;
  const restart = single
    ? "The server restarts to finish the update"
    : "The servers restart to finish the update";
  return [
    `Update the ${target}${hostActivityQuestion[concern]}`,
    ...lines,
    incomplete ? `${restart}, so running threads and terminals may be interrupted.` : `${restart}.`,
  ].join("\n");
}
