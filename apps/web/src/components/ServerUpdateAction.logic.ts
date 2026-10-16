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
export function serverUpdateConfirmation(hosts: ReadonlyArray<ServerUpdateHost>) {
  const single = hosts.length === 1 ? hosts[0]! : null;
  const unchecked = hosts.filter((host) => host.activity === null);
  const { concern, lines, incomplete, threadActivity } = describeHostActivity(
    hosts.map(
      ({ activity, continueRunningThreads, serverLabel }) =>
        activity && {
          ...activity,
          continueRunningThreads,
          ...(hosts.length > 1 ? { hostLabel: serverLabel } : {}),
        },
    ),
    {
      uncheckedHostsLine: single
        ? `Could not check the ${single.serverLabel} for running work.`
        : `Could not check ${labels(unchecked)} for running work.`,
    },
  );
  const desktopApps = hosts.filter((host) => host.desktopApp);
  if (desktopApps.length > 0) {
    return {
      message: [
        single
          ? `Update the styal desktop app that runs the ${single.serverLabel}?`
          : desktopApps.length < hosts.length
            ? `Update the servers on ${labels(hosts)}?`
            : `Update the styal desktop apps on ${labels(desktopApps)}?`,
        desktopApps.length < hosts.length
          ? `The styal desktop ${desktopApps.length === 1 ? "app" : "apps"} on ${labels(desktopApps)} will close and relaunch.`
          : desktopApps.length === 1
            ? "It will close and relaunch on that machine."
            : "They will close and relaunch on those machines.",
        ...lines,
      ].join("\n"),
      threadActivity,
    };
  }
  if (concern === null) return null;
  const target = single ? single.serverLabel : `servers on ${labels(hosts)}`;
  return {
    message: [
      `Update the ${target}${hostActivityQuestion[concern]}`,
      ...lines,
      ...(incomplete ? ["Running threads and terminals may be interrupted."] : []),
    ].join("\n"),
    threadActivity,
  };
}
