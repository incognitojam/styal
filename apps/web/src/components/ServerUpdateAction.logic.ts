import { msg } from "gt-react";
import { m } from "../i18n/messages";
import { describeHostActivity } from "@t3tools/shared/hostActivityCopy";
import type { DesktopUpdateActivity, HostActivity } from "@t3tools/contracts";
import { desktopUpdateActivityChecks, hostActivityQuestion } from "@t3tools/shared/hostActivity";

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
  return /(^|\s)server$/iu.test(label) ? label : m(msg("{label} server", { label }));
}

/** Names the action consistently before and after checking running work. */
function serverUpdateQuestion(
  hosts: ReadonlyArray<Pick<ServerUpdateHost, "serverLabel" | "desktopApp">>,
  concern: keyof typeof hostActivityQuestion | null = null,
): string {
  const single = hosts.length === 1 ? hosts[0]! : null;
  const desktopApps = hosts.filter((host) => host.desktopApp);
  if (desktopApps.length > 0) {
    return single
      ? m(
          msg("Update the styal desktop app that runs the {server}?", {
            server: serverNoun(single.serverLabel),
          }),
        )
      : desktopApps.length < hosts.length
        ? m(msg("Update the servers on {servers}?", { servers: labels(hosts) }))
        : m(msg("Update the styal desktop apps on {servers}?", { servers: labels(desktopApps) }));
  }
  const target = single ? serverNoun(single.serverLabel) : labels(hosts);
  if (single)
    return m(
      concern === "running"
        ? msg("Update the {server} with running work?", { server: target })
        : concern === "waiting"
          ? msg("Update the {server} with waiting threads?", { server: target })
          : msg("Update the {server}?", { server: target }),
    );
  return m(
    concern === "running"
      ? msg("Update the servers on {servers} with running work?", { servers: target })
      : concern === "waiting"
        ? msg("Update the servers on {servers} with waiting threads?", { servers: target })
        : msg("Update the servers on {servers}?", { servers: target }),
  );
}

export function serverUpdateActivity(
  hosts: ReadonlyArray<ServerUpdateHost>,
  includeHostLabels = false,
) {
  const single = hosts.length === 1 ? hosts[0]! : null;
  const checks = hosts.map((host) =>
    host.desktopApp
      ? desktopUpdateActivityChecks(
          host.activity,
          host.desktopActivity,
          m(msg("other environments on this desktop app")),
        )
      : [
          host.activity && {
            ...host.activity,
            continueRunningThreads: host.continueRunningThreads,
          },
        ],
  );
  const unchecked = hosts.filter((_, index) => checks[index]!.includes(null));
  return describeHostActivity(
    checks.flatMap((hostChecks, index) =>
      hosts.length > 1 || includeHostLabels
        ? hostChecks.map((activity) => {
            const label = [hosts[index]!.serverLabel, activity?.hostLabel].filter(Boolean);
            return activity && { ...activity, hostLabel: label.join(" / ") };
          })
        : hostChecks,
    ),
    {
      uncheckedHostsLine: single
        ? m(
            msg("Could not check the {server} for running work.", {
              server: serverNoun(single.serverLabel),
            }),
          )
        : m(msg("Could not check {servers} for running work.", { servers: labels(unchecked) })),
    },
    m,
  );
}

/** A manual update needs confirmation only when work could be interrupted. */
export function serverUpdateConfirmation(
  hosts: ReadonlyArray<ServerUpdateHost>,
  activity = serverUpdateActivity(hosts),
) {
  if (!activity.interrupts) return null;
  const { concern, lines, incomplete, threadActivity } = activity;
  const desktopApps = hosts.filter((host) => host.desktopApp);
  if (desktopApps.length > 0) {
    return {
      message: [
        serverUpdateQuestion(hosts),
        desktopApps.length < hosts.length
          ? m(
              msg(
                "The styal desktop {count, plural, one {app} other {apps}} on {servers} will close and relaunch.",
                { count: desktopApps.length, servers: labels(desktopApps) },
              ),
            )
          : desktopApps.length === 1
            ? m(msg("It will close and relaunch on that machine."))
            : m(msg("They will close and relaunch on those machines.")),
        ...lines,
      ].join("\n"),
      threadActivity,
    };
  }
  return {
    message: [
      serverUpdateQuestion(hosts, concern),
      ...lines,
      ...(incomplete ? [m(msg("Running threads and terminals may be interrupted."))] : []),
    ].join("\n"),
    threadActivity,
  };
}

/** Asks while the running-work check is still going after the grace period. */
export function serverUpdateCheckingMessage(
  hosts: ReadonlyArray<Pick<ServerUpdateHost, "serverLabel" | "desktopApp">>,
): string {
  const single = hosts.length === 1 ? hosts[0]! : null;
  return [
    serverUpdateQuestion(hosts),
    single
      ? m(
          msg("Still checking the {server} for running work.", {
            server: serverNoun(single.serverLabel),
          }),
        )
      : m(msg("Still checking {servers} for running work.", { servers: labels(hosts) })),
    m(msg("Updating now may interrupt running threads and terminals.")),
  ].join("\n");
}

/** Replaces the checking message when a late check finds nothing to interrupt. */
export function serverUpdateSafeMessage(
  hosts: ReadonlyArray<Pick<ServerUpdateHost, "serverLabel" | "desktopApp">>,
): string {
  return [serverUpdateQuestion(hosts), m(msg("Nothing running will be interrupted."))].join("\n");
}
