import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

interface MachineShellProgress {
  readonly hasLoadedShell: boolean;
  readonly shellError: string | null;
}

export function createMachineShellProgressAtom(
  environmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>,
  shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Pick<EnvironmentShellState, "status" | "error">>,
) {
  return Atom.make((get) => {
    const previous = Option.getOrNull(get.self<ReadonlyMap<EnvironmentId, MachineShellProgress>>());
    const next = new Map<EnvironmentId, MachineShellProgress>();
    for (const environmentId of get(environmentIdsAtom)) {
      const shell = get(shellStateAtom(environmentId));
      const prior = previous?.get(environmentId);
      const hasLoadedShell = prior?.hasLoadedShell === true || shell.status === "live";
      const shellError = Option.getOrNull(shell.error);
      next.set(
        environmentId,
        prior?.hasLoadedShell === hasLoadedShell && prior.shellError === shellError
          ? prior
          : { hasLoadedShell, shellError },
      );
    }
    return previous?.size === next.size &&
      [...next].every(([id, value]) => previous.get(id) === value)
      ? previous
      : next;
  });
}

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
  readonly signInLoading: boolean;
  readonly hasLoadedShell: boolean;
  readonly shellError: string | null;
}

export interface MachineConnectionLine {
  readonly tone: "connecting" | "failed";
  readonly showImmediately: boolean;
  readonly text: string;
  /** Each machine's problem on its own line, when a version is one of them. */
  readonly tooltip: string | null;
  /** The icon while connecting: the one machine's own kind, or a server for several. */
  readonly machineKind: EnvironmentMachineKind | null;
  /** The first machine represented by the line. */
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
  const enabled = environments.filter((environment) => environment.enabled);
  const shown = everyMachine
    ? enabled
    : enabled.filter(
        (environment) =>
          !environment.awaitingSignIn &&
          (!environment.updating || environment.connection.phase === "error"),
      );
  const connecting = shown.filter(
    (environment) =>
      (environment.signInLoading &&
        (environment.connection.phase === "connecting" ||
          environment.connection.phase === "reconnecting" ||
          environment.connection.phase === "error")) ||
      environment.connection.phase === "connecting" ||
      (environment.connection.phase === "connected" &&
        !environment.hasLoadedShell &&
        environment.shellError === null),
  );
  // Reconnecting means an attempt failed; a manual retry starts over as connecting.
  const failed = shown.filter(
    (environment) =>
      !connecting.includes(environment) &&
      (environment.connection.phase === "reconnecting" ||
        environment.connection.phase === "error" ||
        (environment.connection.phase === "connected" && environment.shellError !== null)),
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

/** Pending machines stay visible even when another machine has failed. */
export function machineConnectionLine(
  environments: ReadonlyArray<MachineConnection>,
): MachineConnectionLine | null {
  const { connecting, failed, outdated } = waitingMachines(environments);
  if (connecting.length > 0) {
    return {
      tone: "connecting",
      showImmediately: connecting.some((environment) => !environment.hasLoadedShell),
      machineKind:
        connecting.length === 1 && connecting[0]
          ? resolveEnvironmentMachineKind(connecting[0].serverConfig)
          : "server",
      waitingEnvironmentId: connecting[0]!.environmentId,
      text: `Connecting to ${nameMachines(connecting.map((environment) => environment.label))}`,
      tooltip:
        connecting.length > 2
          ? connecting.map((environment) => environment.label).join("\n")
          : null,
      retryEnvironmentIds: [],
    };
  }
  const waitingEnvironmentId = environments.find(
    (environment) => failed.includes(environment) || outdated.includes(environment),
  )?.environmentId;
  if (waitingEnvironmentId === undefined) return null;
  const retryEnvironmentIds = failed.map((environment) => environment.environmentId);
  if (outdated.length > 0) {
    return {
      tone: "failed",
      showImmediately: [...failed, ...outdated].some((environment) => !environment.hasLoadedShell),
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
      showImmediately: [...failed, ...outdated].some((environment) => !environment.hasLoadedShell),
      machineKind: null,
      waitingEnvironmentId,
      text: `${failed.some((environment) => environment.connection.phase === "connected") ? "Can't load projects from" : "Can't reach"} ${nameMachines(failed.map((environment) => environment.label))}`,
      tooltip: null,
      retryEnvironmentIds,
    };
  }
  return null;
}

/** What an empty sidebar says instead of "No projects yet" while a machine's projects can still arrive. */
export function machineConnectionEmptyText(
  environments: ReadonlyArray<MachineConnection>,
  catalogReady = true,
): string | null {
  if (!catalogReady) return "Loading saved machines…";
  // Projects can still arrive from a machine the footer line leaves out.
  const { connecting, failed } = waitingMachines(environments, true);
  const waiting = [...failed, ...connecting];
  if (waiting.length === 0) return null;
  const names = nameMachines(waiting.map((environment) => environment.label));
  return `Projects on ${names} show up here once ${waiting.length > 1 ? "they connect" : "it connects"}`;
}
