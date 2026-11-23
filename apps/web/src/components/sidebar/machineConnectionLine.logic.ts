import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

interface MachineConnection {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  /** A server update is restarting it, so a dropped connection is expected. */
  readonly updating: boolean;
  /** Reached only through styal Link and there is no Link sign-in, so a retry cannot help. */
  readonly awaitingSignIn: boolean;
}

export interface MachineConnectionLine {
  readonly tone: "connecting" | "failed";
  readonly text: string;
  /** The first machine still waiting, failed or not, which keys the line's grace period. */
  readonly waitingEnvironmentId: EnvironmentId;
  /** The failed machines Retry reconnects; empty while connecting. */
  readonly retryEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

function nameMachines(labels: ReadonlyArray<string>): string {
  return labels.length <= 2 ? labels.join(" and ") : `${labels.length} machines`;
}

// A machine switched off, an offline device and an incompatible version are not connections in
// progress. The composer banner covers a missing Link sign-in, which Retry cannot fix.
function waitingMachines(environments: ReadonlyArray<MachineConnection>) {
  const shown = environments.filter(
    (environment) =>
      !environment.awaitingSignIn &&
      (!environment.updating || environment.connection.phase === "error"),
  );
  const connecting = shown.filter((environment) => environment.connection.phase === "connecting");
  // Reconnecting means an attempt failed; a manual retry starts over as connecting.
  const failed = shown.filter(
    (environment) =>
      environment.connection.phase === "reconnecting" || environment.connection.phase === "error",
  );
  return { connecting, failed };
}

/** The sidebar footer line for machines the app is still connecting to, failures first. */
export function machineConnectionLine(
  environments: ReadonlyArray<MachineConnection>,
): MachineConnectionLine | null {
  const { connecting, failed } = waitingMachines(environments);
  const waitingEnvironmentId = environments.find(
    (environment) => connecting.includes(environment) || failed.includes(environment),
  )?.environmentId;
  if (waitingEnvironmentId === undefined) return null;
  if (failed.length > 0) {
    return {
      tone: "failed",
      waitingEnvironmentId,
      text: `Can't reach ${nameMachines(failed.map((environment) => environment.label))}`,
      retryEnvironmentIds: failed.map((environment) => environment.environmentId),
    };
  }
  return {
    tone: "connecting",
    waitingEnvironmentId,
    text: `Connecting to ${nameMachines(connecting.map((environment) => environment.label))}`,
    retryEnvironmentIds: [],
  };
}

/** What an empty sidebar says instead of "No projects yet" while a machine's projects can still arrive. */
export function machineConnectionEmptyText(
  environments: ReadonlyArray<MachineConnection>,
): string | null {
  const { connecting, failed } = waitingMachines(environments);
  const waiting = [...failed, ...connecting];
  if (waiting.length === 0) return null;
  const names = nameMachines(waiting.map((environment) => environment.label));
  return `Projects on ${names} show up here once ${waiting.length > 1 ? "they connect" : "it connects"}`;
}
