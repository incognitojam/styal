import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

interface MachineConnection {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: {
    readonly phase: EnvironmentConnectionPhase;
    readonly error?: string | null;
  };
  /** Which side's version is too old, when the versions are why it cannot connect. */
  readonly outdated: "client" | "server" | null;
  /** "Show in this app" is on; a hidden machine keeps its version verdict. */
  readonly enabled: boolean;
  readonly serverConfig: Parameters<typeof resolveEnvironmentMachineKind>[0];
  /** A server update is restarting it, so a dropped connection is expected. */
  readonly updating: boolean;
  /** Reached only through styal Link and there is no Link sign-in, so a retry cannot help. */
  readonly awaitingSignIn: boolean;
}

export interface MachineConnectionLine {
  readonly tone: "connecting" | "failed";
  readonly text: string;
  /** Each machine's problem on its own line, when a version is one of them. */
  readonly tooltip: string | null;
  /** The icon while connecting: the one machine's own kind, or a server for several. */
  readonly machineKind: EnvironmentMachineKind | null;
  /** The first machine still waiting, failed or not, which keys the line's grace period. */
  readonly waitingEnvironmentId: EnvironmentId;
  /** The failed machines Retry reconnects; empty while connecting. */
  readonly retryEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

function nameMachines(labels: ReadonlyArray<string>): string {
  return labels.length <= 2 ? labels.join(" and ") : `${labels.length} machines`;
}

// A machine switched off, an offline device and one this client can never use, such as SSH on the
// web, are left out. The composer banner covers a missing Link sign-in, which Retry cannot fix.
function waitingMachines(environments: ReadonlyArray<MachineConnection>, everyMachine = false) {
  const shown = everyMachine
    ? environments
    : environments.filter(
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
  const outdated = shown.filter(
    (environment) =>
      environment.enabled &&
      environment.connection.phase === "unsupported" &&
      environment.outdated !== null,
  );
  return { connecting, failed, outdated };
}

function outdatedText(environment: MachineConnection): string {
  return environment.outdated === "client"
    ? `Update this app to use ${environment.label}`
    : `Update styal on ${environment.label}`;
}

// More than one machine, or a mix of problems, would not fit beside Retry, so the line counts them.
function outdatedLineText(
  failed: ReadonlyArray<MachineConnection>,
  outdated: ReadonlyArray<MachineConnection>,
): string {
  const count = failed.length + outdated.length;
  if (count === 1 && outdated[0]) return outdatedText(outdated[0]);
  if (failed.length > 0) return `Can't reach or use ${count} machines`;
  if (outdated.every((environment) => environment.outdated === "client")) {
    return `Update this app to use ${count} machines`;
  }
  if (outdated.every((environment) => environment.outdated === "server")) {
    return `Update styal on ${count} machines`;
  }
  return `Can't use ${count} machines`;
}

/** The sidebar footer line for machines the app is still connecting to, failures first. */
export function machineConnectionLine(
  environments: ReadonlyArray<MachineConnection>,
): MachineConnectionLine | null {
  const { connecting, failed, outdated } = waitingMachines(environments);
  const waitingEnvironmentId = environments.find(
    (environment) =>
      connecting.includes(environment) ||
      failed.includes(environment) ||
      outdated.includes(environment),
  )?.environmentId;
  if (waitingEnvironmentId === undefined) return null;
  const retryEnvironmentIds = failed.map((environment) => environment.environmentId);
  if (outdated.length > 0) {
    return {
      tone: "failed",
      machineKind: null,
      waitingEnvironmentId,
      text: outdatedLineText(failed, outdated),
      tooltip: [
        ...failed.map((environment) => `Can't reach ${environment.label}`),
        ...outdated.map((environment) => environment.connection.error ?? outdatedText(environment)),
      ].join("\n"),
      retryEnvironmentIds,
    };
  }
  if (failed.length > 0) {
    return {
      tone: "failed",
      machineKind: null,
      waitingEnvironmentId,
      text: `Can't reach ${nameMachines(failed.map((environment) => environment.label))}`,
      tooltip: null,
      retryEnvironmentIds,
    };
  }
  return {
    tone: "connecting",
    machineKind:
      connecting.length === 1 && connecting[0]
        ? resolveEnvironmentMachineKind(connecting[0].serverConfig)
        : "server",
    waitingEnvironmentId,
    text: `Connecting to ${nameMachines(connecting.map((environment) => environment.label))}`,
    tooltip: null,
    retryEnvironmentIds: [],
  };
}

/** What an empty sidebar says instead of "No projects yet" while a machine's projects can still arrive. */
export function machineConnectionEmptyText(
  environments: ReadonlyArray<MachineConnection>,
): string | null {
  // Projects can still arrive from a machine the footer line leaves out.
  const { connecting, failed } = waitingMachines(environments, true);
  const waiting = [...failed, ...connecting];
  if (waiting.length === 0) return null;
  const names = nameMachines(waiting.map((environment) => environment.label));
  return `Projects on ${names} show up here once ${waiting.length > 1 ? "they connect" : "it connects"}`;
}
