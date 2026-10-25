import type { DesktopUpdateActivity, HostActivity } from "@t3tools/contracts";
import {
  desktopUpdateActivityChecks,
  describeHostActivity,
  hostActivityQuestion,
} from "@t3tools/shared/hostActivity";

export interface ServerUpdateHost {
  readonly serverLabel: string;
  /** Null when the host could not be checked. */
  readonly activity: HostActivity | null;
  /** Complete desktop pool coverage; absent on hosts predating remote activity checks. */
  readonly desktopActivity?: ReadonlyArray<DesktopUpdateActivity | null> | null;
  readonly desktopApp: boolean;
  readonly continueRunningThreads: boolean;
}

function labels(hosts: ReadonlyArray<Pick<ServerUpdateHost, "serverLabel">>): string {
  return hosts.map((host) => host.serverLabel).join(", ");
}

/**
 * The server named in a sentence such as "Update the build-box server?". Single
 * update buttons pass a label like "build-box server" or "server"; batch updates
 * pass the machine name, which reads as "build-box server" here.
 */
function serverNoun(label: string): string {
  return /(^|\s)server$/iu.test(label) ? label : `${label} server`;
}

/** Names the action consistently before and after checking running work. */
export function serverUpdateQuestion(
  hosts: ReadonlyArray<Pick<ServerUpdateHost, "serverLabel" | "desktopApp">>,
  concern: keyof typeof hostActivityQuestion | null = null,
): string {
  const single = hosts.length === 1 ? hosts[0]! : null;
  const desktopApps = hosts.filter((host) => host.desktopApp);
  if (desktopApps.length > 0) {
    return single
      ? `Update the styal desktop app that runs the ${serverNoun(single.serverLabel)}?`
      : desktopApps.length < hosts.length
        ? `Update the servers on ${labels(hosts)}?`
        : `Update the styal desktop apps on ${labels(desktopApps)}?`;
  }
  const target = single ? serverNoun(single.serverLabel) : `servers on ${labels(hosts)}`;
  return `Update the ${target}${concern === null ? "?" : hostActivityQuestion[concern]}`;
}

export function serverUpdateActivity(hosts: ReadonlyArray<ServerUpdateHost>) {
  const single = hosts.length === 1 ? hosts[0]! : null;
  const unchecked = hosts.filter((host) =>
    host.desktopApp
      ? desktopUpdateActivityChecks(host.activity, host.desktopActivity).some(
          (activity) => activity === null,
        )
      : host.activity === null,
  );
  return describeHostActivity(
    hosts.flatMap((host) => {
      if (host.desktopApp) {
        return desktopUpdateActivityChecks(host.activity, host.desktopActivity).map(
          (activity) =>
            activity && {
              ...activity,
              ...(hosts.length > 1
                ? { hostLabel: [host.serverLabel, activity.hostLabel].filter(Boolean).join(" / ") }
                : {}),
            },
        );
      }
      return [
        host.activity && {
          ...host.activity,
          continueRunningThreads: host.continueRunningThreads,
          ...(hosts.length > 1 ? { hostLabel: host.serverLabel } : {}),
        },
      ];
    }),
    {
      uncheckedHostsLine: single
        ? `Could not check the ${serverNoun(single.serverLabel)} for running work.`
        : `Could not check ${labels(unchecked)} for running work.`,
    },
  );
}

/** Remote desktop relaunches always need explicit confirmation. */
export function serverUpdateConfirmation(
  hosts: ReadonlyArray<ServerUpdateHost>,
  activity = serverUpdateActivity(hosts),
) {
  const { concern, lines, incomplete, threadActivity } = activity;
  const desktopApps = hosts.filter((host) => host.desktopApp);
  if (desktopApps.length > 0) {
    return {
      message: [
        serverUpdateQuestion(hosts),
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
  return {
    message: [
      serverUpdateQuestion(hosts, concern),
      ...lines,
      ...(incomplete ? ["Running threads and terminals may be interrupted."] : []),
    ].join("\n"),
    threadActivity,
  };
}
