import type { HostActivity } from "@t3tools/contracts";
import { describeHostActivity, hostActivityQuestion } from "@t3tools/shared/hostActivity";

/**
 * Confirmation copy for updating a server, or null when the update can start
 * without asking. `activity` is null when the host could not be checked.
 * Desktop app updates always confirm because they relaunch the remote app.
 */
export function serverUpdateConfirmation(input: {
  readonly serverLabel: string;
  readonly activity: HostActivity | null;
  readonly desktopApp: boolean;
  readonly continueRunningThreads: boolean;
}): string | null {
  const { concern, lines } = describeHostActivity([input.activity], {
    uncheckedHostsLine: `Activity could not be checked on the ${input.serverLabel}.`,
    continueRunningThreads: input.continueRunningThreads,
  });
  if (input.desktopApp) {
    return [
      `Update the desktop app that runs the ${input.serverLabel}?`,
      "It will close and relaunch on that machine.",
      ...lines,
    ].join("\n");
  }
  if (concern === null) return null;
  return [
    `Update the ${input.serverLabel} ${hostActivityQuestion[concern]}`,
    ...lines,
    "The server restarts to finish the update.",
  ].join("\n");
}
