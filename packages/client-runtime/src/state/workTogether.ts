/**
 * Two of a person's machines work together, or stop, through existing APIs. Results live on
 * the machines, so a later run picks up what is left. Upstream's linked environments are
 * still changing; this is the one place to swap.
 */
import {
  AuthMcpClientAccess,
  resolveEnvironmentMachineKind,
  type EnvironmentMachineKind,
  type AuthSessionId,
  type DeviceHostId,
  type EnvironmentId,
  type PeerLinkCreateInput,
  type PeerLinkRemoveInput,
  type PeerLinkSummary,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import type { Atom, AtomRegistry } from "effect/reactivity";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  connectionCatalogDisplayUrl,
  type EnvironmentPresentation,
} from "../connection/presentation.ts";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { LINK_DEFAULT_ACCESS } from "../linkRequest.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { request, subscribe } from "../rpc/client.ts";
import { connectDeviceEnvironment } from "./device.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { mintPeerPairingCode } from "./peerPairingCode.ts";
import {
  type AtomCommand,
  type AtomCommandResult,
  createRuntimeCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "./runtime.ts";

/** What a client knows about one machine when it plans a run. */
export interface WorkTogetherMachine {
  readonly environmentId: EnvironmentId;
  /** What this client calls the machine. */
  readonly label: string;
  /** What the machine calls itself, which names its sessions on other machines. */
  readonly ownLabel: string | null;
  readonly identityDetail?: string | null;
  readonly identityIcon?: EnvironmentMachineKind | null;
  readonly connected: boolean;
  /** Its links and device abilities have arrived, so a plan will not miss anything. */
  readonly loaded: boolean;
  /** This client's session there may change settings and access. */
  readonly canManage: boolean;
  readonly allowsLinks: boolean;
  /** Null until the machine answers. */
  readonly links: ReadonlyArray<
    Pick<PeerLinkSummary, "environmentId" | "status" | "access">
  > | null;
  /** Addresses another machine can try, for a link. */
  readonly urls: ReadonlyArray<string>;
  /** Addresses another machine can try, for its devices. Null without one. */
  readonly deviceUrls: readonly [string, ...string[]] | null;
  /** It has a simulator or an SDK, and can share them. */
  readonly hasDevices: boolean;
  /** It can use devices another machine shares. */
  readonly usesSharedDevices: boolean;
  readonly sharedDeviceHosts: ReadonlyArray<{
    readonly id: DeviceHostId;
    readonly environmentId: EnvironmentId;
  }>;
}

export interface WorkTogetherIdentity {
  readonly identityDetail: string | null;
  readonly identityIcon: EnvironmentMachineKind | null;
}

const MACHINE_NAMES: Record<EnvironmentMachineKind, string> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux/WSL",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mini PC",
  "mac-studio": "Workstation",
};

export function workTogetherLabels<
  T extends Pick<EnvironmentPresentation, "entry"> & {
    readonly serverConfig: Parameters<typeof resolveEnvironmentMachineKind>[0];
    readonly environmentId: string;
    readonly label: string;
  },
>(machines: ReadonlyArray<T>): ReadonlyArray<T & WorkTogetherIdentity> {
  const identities = machines.map((machine) => {
    const { entry } = machine;
    const kind = resolveEnvironmentMachineKind(machine.serverConfig);
    let address = connectionCatalogDisplayUrl(entry);
    let type =
      entry.target._tag === "RelayConnectionTarget"
        ? "styal Link"
        : entry.target._tag === "SshConnectionTarget"
          ? "SSH"
          : "Direct";
    if (
      entry.target._tag === "SshConnectionTarget" &&
      Option.isSome(entry.profile) &&
      entry.profile.value._tag === "SshConnectionProfile"
    ) {
      const target = entry.profile.value.target;
      address = `${target.hostname}:${target.port ?? 22}`;
    } else if (address !== null) {
      try {
        const url = new URL(address);
        address = url.host;
        if (
          entry.target._tag === "PrimaryConnectionTarget" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )
          type = "Local";
      } catch {
        address = null;
      }
    }
    const descriptor = address === null ? type : `${type} · ${address}`;
    return { machine, kind, descriptor };
  });
  return identities.map(({ machine, kind, descriptor }) => {
    const sameName = identities.filter((other) => other.machine.label === machine.label);
    if (sameName.length === 1) return { ...machine, identityDetail: null, identityIcon: null };
    const differentIcons = sameName.some((other) => other.kind !== kind);
    let detail = descriptor;
    let fullId: string | null = null;
    const sameAddress = sameName.filter((other) => other.descriptor === descriptor);
    if (sameAddress.length > 1 && sameAddress.some((other) => other.kind !== kind))
      detail += ` · ${MACHINE_NAMES[kind]}`;
    const indistinguishable = sameAddress.filter((other) => other.kind === kind || !differentIcons);
    if (indistinguishable.length > 1) {
      const id = machine.environmentId;
      fullId = id;
      let length = Math.min(6, id.length);
      while (
        indistinguishable.some(
          (other) =>
            other.machine.environmentId !== id &&
            other.machine.environmentId.slice(0, length) === id.slice(0, length),
        )
      )
        length += 1;
      let suffixLength = Math.min(6, id.length);
      while (
        indistinguishable.some(
          (other) =>
            other.machine.environmentId !== id &&
            other.machine.environmentId.slice(-suffixLength) === id.slice(-suffixLength),
        )
      )
        suffixLength += 1;
      const shortId =
        suffixLength < length
          ? `…${id.slice(-suffixLength)}`
          : `${id.slice(0, length)}${length < id.length ? "…" : ""}`;
      detail += ` · ${shortId}`;
    }
    const concise = detail.length > 64 ? `${detail.slice(0, 40)}…${detail.slice(-20)}` : detail;
    return {
      ...machine,
      label: `${machine.label} (${concise})`,
      identityDetail: `${machine.label}: ${detail}${fullId === null ? "" : ` · Environment ID: ${fullId}`}`,
      identityIcon: differentIcons ? kind : null,
    };
  });
}

type Step =
  | { readonly kind: "allow"; readonly machine: WorkTogetherMachine }
  | {
      readonly kind: "link";
      readonly from: WorkTogetherMachine;
      readonly to: WorkTogetherMachine;
    }
  | {
      readonly kind: "share";
      readonly device: WorkTogetherMachine;
      readonly agent: WorkTogetherMachine;
    }
  | {
      readonly kind: "unshare";
      readonly device: WorkTogetherMachine;
      readonly agent: WorkTogetherMachine;
      readonly hostId: DeviceHostId;
    }
  | {
      readonly kind: "unlink";
      readonly from: WorkTogetherMachine;
      readonly to: WorkTogetherMachine;
    }
  | {
      readonly kind: "revoke";
      readonly on: WorkTogetherMachine;
      readonly of: WorkTogetherMachine;
      /** `of` has a link there, so a session should be found. */
      readonly expected: boolean;
    };

export type WorkTogetherLineState =
  | { readonly state: "pending" }
  | { readonly state: "running" }
  | { readonly state: "done" }
  /** A machine this step needs is not connected. */
  | { readonly state: "waiting"; readonly machine: string }
  /** An earlier step this one needs did not finish. */
  | { readonly state: "blocked" }
  | { readonly state: "failed"; readonly message: string };

/** One line of the progress list. */
export interface WorkTogetherLine {
  readonly id: string;
  readonly label: string;
  readonly step: Step;
  /** Lines that have to be done first. */
  readonly after: ReadonlyArray<string>;
  readonly status: WorkTogetherLineState;
}

const line = (
  id: string,
  label: string,
  step: Step,
  done: boolean,
  after: ReadonlyArray<string> = [],
): WorkTogetherLine => ({
  id,
  label,
  step,
  after,
  status: { state: done ? "done" : "pending" },
});

const activeLink = (from: WorkTogetherMachine, to: WorkTogetherMachine) =>
  from.links?.find((link) => link.environmentId === to.environmentId && link.status !== "expired");

const hasLink = (from: WorkTogetherMachine, to: WorkTogetherMachine): boolean | null =>
  from.links === null ? null : activeLink(from, to) !== undefined;

const sharedHost = (agent: WorkTogetherMachine, device: WorkTogetherMachine) =>
  agent.sharedDeviceHosts.find((host) => host.environmentId === device.environmentId);

const canShare = (device: WorkTogetherMachine, agent: WorkTogetherMachine) =>
  device.hasDevices && agent.usesSharedDevices;

/** The machines that would share devices, for telling the person before they start. */
export const workTogetherSharedDevices = (
  a: WorkTogetherMachine,
  b: WorkTogetherMachine,
): ReadonlyArray<{ readonly device: WorkTogetherMachine; readonly agent: WorkTogetherMachine }> =>
  [
    { device: a, agent: b },
    { device: b, agent: a },
  ].filter(({ device, agent }) => canShare(device, agent) || sharedHost(agent, device));

/** Shares that could exist but do not, because one failed or was turned off in Devices. */
export const workTogetherMissingShares = (a: WorkTogetherMachine, b: WorkTogetherMachine) =>
  workTogetherSharedDevices(a, b).filter(({ device, agent }) => !sharedHost(agent, device));

/**
 * The pair has a direction paired with less than a new connection gets. It stays that way
 * until someone finishes it, which pairs it again; the machine's own setting still applies.
 */
export const workTogetherHasNarrowerAccess = (a: WorkTogetherMachine, b: WorkTogetherMachine) =>
  [activeLink(a, b), activeLink(b, a)].some(
    (link) => link !== undefined && link.access !== LINK_DEFAULT_ACCESS,
  );

/**
 * Every line of turning it on. What is already true starts done, so a rerun only finishes.
 * A link at other access than the one chosen is replaced, so the choice holds both ways.
 */
export function planWorkTogether(
  a: WorkTogetherMachine,
  b: WorkTogetherMachine,
  access: AuthMcpClientAccess,
): ReadonlyArray<WorkTogetherLine> {
  const allow = (machine: WorkTogetherMachine) =>
    line(
      `allow:${machine.environmentId}`,
      `${machine.label} can work with your other machines`,
      { kind: "allow", machine },
      machine.allowsLinks,
    );
  const link = (from: WorkTogetherMachine, to: WorkTogetherMachine) =>
    line(
      `link:${from.environmentId}`,
      `Agents on ${from.label} can work on ${to.label}`,
      { kind: "link", from, to },
      activeLink(from, to)?.access === access,
      [`allow:${from.environmentId}`, `allow:${to.environmentId}`],
    );
  return [
    allow(a),
    allow(b),
    link(a, b),
    link(b, a),
    ...workTogetherSharedDevices(a, b).map(({ device, agent }) =>
      line(
        `share:${device.environmentId}`,
        `${agent.label} can use ${device.label}'s devices`,
        { kind: "share", device, agent },
        sharedHost(agent, device) !== undefined,
      ),
    ),
  ];
}

/**
 * Every line of stopping. The switches stay as they are: they belong to the machine, which
 * may have other machines to work with, and Labs and Devices show them.
 */
export function planStopWorkingTogether(
  a: WorkTogetherMachine,
  b: WorkTogetherMachine,
): ReadonlyArray<WorkTogetherLine> {
  const unshare = (agent: WorkTogetherMachine, device: WorkTogetherMachine) => {
    const host = sharedHost(agent, device);
    return host === undefined
      ? []
      : [
          line(
            `unshare:${device.environmentId}`,
            `${agent.label} stops using ${device.label}'s devices`,
            { kind: "unshare", device, agent, hostId: host.id },
            false,
          ),
        ];
  };
  const unlink = (from: WorkTogetherMachine, to: WorkTogetherMachine) =>
    line(
      `unlink:${from.environmentId}`,
      `Agents on ${from.label} stop working on ${to.label}`,
      { kind: "unlink", from, to },
      hasLink(from, to) === false,
    );
  const revoke = (on: WorkTogetherMachine, of: WorkTogetherMachine) =>
    line(
      `revoke:${on.environmentId}`,
      `${on.label} ends the sessions it gave ${of.label}`,
      { kind: "revoke", on, of, expected: hasLink(of, on) === true },
      false,
    );
  return [
    ...unshare(a, b),
    ...unshare(b, a),
    unlink(a, b),
    unlink(b, a),
    revoke(b, a),
    revoke(a, b),
  ];
}

export type WorkTogetherStatus = "separate" | "together" | "partial";

/** What is true of the pair, from what the connected machines report. */
export function workTogetherStatus(
  a: WorkTogetherMachine,
  b: WorkTogetherMachine,
): WorkTogetherStatus {
  const links = [hasLink(a, b), hasLink(b, a)].filter((link) => link !== null);
  const shared = sharedHost(a, b) !== undefined || sharedHost(b, a) !== undefined;
  if (links.length > 0 && links.every((link) => !link) && !shared) return "separate";
  const allowed = [a, b].every((machine) => !machine.connected || machine.allowsLinks);
  return links.length > 0 && links.every((link) => link) && allowed ? "together" : "partial";
}

/**
 * Whether a pair has something to do, so a page can leave out the ones that are fine. A machine
 * that is asleep is not a reason: nothing can be done from here until it is back.
 */
export function workTogetherNeedsAttention(
  a: WorkTogetherMachine,
  b: WorkTogetherMachine,
): boolean {
  const machines = [a, b];
  if (machines.some((machine) => machine.connected && !machine.loaded)) return false;
  if (machines.every((machine) => !machine.connected)) return false;
  if (workTogetherStatus(a, b) !== "together") return true;
  return (
    machines.every((machine) => machine.connected) && workTogetherMissingShares(a, b).length > 0
  );
}

/** The machines this client must be connected to before a step can run. */
const machinesNeeded = (step: Step): ReadonlyArray<WorkTogetherMachine> => {
  switch (step.kind) {
    case "allow":
      return [step.machine];
    case "link":
      return [step.from, step.to];
    case "share":
      return [step.device, step.agent];
    case "unshare":
      return [step.agent];
    case "unlink":
      return [step.from];
    case "revoke":
      return [step.on];
  }
};

/**
 * Runs what is not done yet, in order, and keeps going past a line that fails or has to wait,
 * since later lines often do not need it.
 */
export const runWorkTogetherLines = Effect.fnUntraced(function* <E, R>(
  lines: ReadonlyArray<WorkTogetherLine>,
  execute: (step: Step) => Effect.Effect<void, E, R>,
  onUpdate: (lines: ReadonlyArray<WorkTogetherLine>) => void,
) {
  let current = lines;
  const set = (id: string, status: WorkTogetherLineState) => {
    current = current.map((entry) => (entry.id === id ? { ...entry, status } : entry));
    onUpdate(current);
  };
  for (const { id, step, after } of lines) {
    if (current.find((entry) => entry.id === id)?.status.state === "done") continue;
    const absent = machinesNeeded(step).find((machine) => !machine.connected);
    if (absent !== undefined) {
      set(id, { state: "waiting", machine: absent.label });
      continue;
    }
    const unfinished = current.some(
      (entry) => after.includes(entry.id) && entry.status.state !== "done",
    );
    if (unfinished) {
      set(id, { state: "blocked" });
      continue;
    }
    set(id, { state: "running" });
    const result = yield* Effect.exit(execute(step));
    if (result._tag === "Success") {
      set(id, { state: "done" });
    } else if (Cause.hasInterruptsOnly(result.cause)) {
      return yield* Effect.interrupt;
    } else {
      set(id, { state: "failed", message: workTogetherFailureMessage(Cause.squash(result.cause)) });
    }
  }
  return current;
});

/** A step this client could not start, such as a machine with no address. */
class WorkTogetherStepError extends Data.TaggedError("WorkTogetherStepError")<{
  readonly message: string;
}> {}

/** Failures whose message is written for people and never carries a pairing code. */
const USER_FACING_FAILURE_TAGS = new Set([
  "WorkTogetherStepError",
  "PeerLinkError",
  "EnvironmentAuthorizationError",
]);

export function workTogetherFailureMessage(failure: unknown): string {
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) {
    return "This step did not finish. Try again.";
  }
  if (failure._tag === "DeviceHostUnavailableError" && "reason" in failure) {
    return String(failure.reason);
  }
  return typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
    ? failure.message
    : "This step did not finish. Try again.";
}

/** How a finished run went, for what to offer next and for usage counts. */
export function workTogetherOutcome(
  lines: ReadonlyArray<WorkTogetherLine>,
): "complete" | "waiting" | "failed" {
  if (lines.some((entry) => entry.status.state === "failed")) return "failed";
  return lines.every((entry) => entry.status.state === "done") ? "complete" : "waiting";
}

/** What the server issues a peer link under; the machine's name is the only other mark on it. */
const PEER_LINK_SUBJECT = "mcp-client";

/** The sessions on the environment this runs in that `machine` holds. */
const readSessions = Effect.fn("clientRuntime.state.workTogether.readSessions")(function* (
  machine: WorkTogetherMachine,
) {
  const access = yield* subscribe(WS_METHODS.subscribeAuthAccess, {}).pipe(Stream.runHead);
  if (Option.isNone(access) || access.value.type !== "snapshot") {
    return yield* new WorkTogetherStepError({
      message: "Could not read this machine's connections. Try again.",
    });
  }
  const linkLabel = machine.ownLabel === null ? null : `styal · ${machine.ownLabel}`;
  const sessions = access.value.payload.clientSessions.filter(({ current }) => !current);
  return {
    link: sessions
      .filter(
        ({ subject, client: { label } }) => subject === PEER_LINK_SUBJECT && label === linkLabel,
      )
      .map(({ sessionId }) => sessionId),
    device: sessions
      .filter(({ subject }) => subject === `device-host:${machine.environmentId}`)
      .map(({ sessionId }) => sessionId),
  };
});

const revokeSessions = Effect.fn("clientRuntime.state.workTogether.revokeSessions")(function* (
  sessionIds: ReadonlyArray<AuthSessionId>,
) {
  if (sessionIds.length === 0) return;
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new WorkTogetherStepError({ message: "The machine is not connected." });
  }
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  for (const sessionId of sessionIds) {
    yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: prepared.value,
      signer,
      remoteAuthorization,
      group: "auth",
      method: "POST",
      url: (urls) => urls.revokeClient(),
      timeoutMs: 8_000,
      request: ({ client, headers }) => client.revokeClient({ headers, payload: { sessionId } }),
    });
  }
});

/** The link commands, which check this client's permissions and refresh what each lists. */
interface PeerLinkCommands {
  readonly link: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: PeerLinkCreateInput },
    unknown,
    unknown
  >;
  readonly unlink: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: PeerLinkRemoveInput },
    unknown,
    unknown
  >;
}

const settled = (result: () => Promise<AtomCommandResult<unknown, unknown>>) =>
  Effect.promise(result).pipe(
    Effect.flatMap((outcome) => {
      if (outcome._tag === "Success") return Effect.void;
      if (isAtomCommandInterrupted(outcome)) return Effect.interrupt;
      return Effect.fail(
        new WorkTogetherStepError({
          message: workTogetherFailureMessage(squashAtomCommandFailure(outcome)),
        }),
      );
    }),
  );

const executeStep = (
  access: AuthMcpClientAccess,
  commands: PeerLinkCommands,
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.fn("clientRuntime.state.workTogether.executeStep")(function* (step: Step) {
    const environments = yield* EnvironmentRegistry;
    switch (step.kind) {
      case "allow":
        yield* environments.run(
          step.machine.environmentId,
          request(WS_METHODS.serverUpdateSettings, {
            patch: { linkedEnvironmentsEnabled: true },
          }),
        );
        return;
      case "link": {
        const [url, ...alternateUrls] = step.to.urls;
        if (url === undefined) {
          return yield* new WorkTogetherStepError({
            message: `${step.from.label} has no address for ${step.to.label}. On ${step.to.label}, turn on styal Link or network access in Connections, or run \`styal up --lan\`.`,
          });
        }
        // A link replaced at other access must not leave its old session usable.
        const replaced = yield* environments.run(step.to.environmentId, readSessions(step.from));
        const pairingCode = yield* environments.run(
          step.to.environmentId,
          mintPeerPairingCode(access).pipe(
            Effect.mapError(
              (error) =>
                new WorkTogetherStepError({
                  message:
                    error.reason === "not_allowed"
                      ? `This app can't create a pairing code on ${step.to.label}. Pair it again from there to manage it.`
                      : `Could not get a pairing code from ${step.to.label}. Check that it's awake, then try again.`,
                }),
            ),
          ),
        );
        yield* settled(() =>
          commands.link.run(registry, {
            environmentId: step.from.environmentId,
            input: {
              url,
              ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
              pairingCode,
              access,
              expectedEnvironmentId: step.to.environmentId,
              expectedLabel: step.to.label,
            },
          }),
        );
        yield* environments.run(step.to.environmentId, revokeSessions(replaced.link));
        return;
      }
      case "share":
        if (step.device.deviceUrls === null) {
          return yield* new WorkTogetherStepError({
            message: `${step.device.label} has no address another machine can reach for its devices. On ${step.device.label}, turn on styal Link or network access in Connections, or run \`styal up --lan\`.`,
          });
        }
        yield* environments.run(
          step.agent.environmentId,
          connectDeviceEnvironment(step.agent.environmentId, {
            targetEnvironmentId: step.device.environmentId,
            targetLabel: step.device.label,
            urls: step.device.deviceUrls,
            sourceLabel: step.agent.label,
          }),
        );
        return;
      case "unshare":
        yield* environments.run(
          step.agent.environmentId,
          request(WS_METHODS.deviceDisconnectEnvironment, { hostId: step.hostId }).pipe(
            // It is gone here. The revoke line ends the device's side once that machine is back.
            Effect.catchTags({
              DeviceHostUnavailableError: (error) =>
                step.device.connected ? Effect.fail(error) : Effect.void,
            }),
          ),
        );
        return;
      case "unlink":
        yield* settled(() =>
          commands.unlink.run(registry, {
            environmentId: step.from.environmentId,
            input: { environmentId: step.to.environmentId },
          }),
        );
        return;
      case "revoke": {
        const found = yield* environments.run(step.on.environmentId, readSessions(step.of));
        yield* environments.run(
          step.on.environmentId,
          revokeSessions([...found.link, ...found.device]),
        );
        if (step.expected && found.link.length === 0) {
          return yield* new WorkTogetherStepError({
            message: `Could not find ${step.of.label}'s session. If it was renamed, revoke its session in ${step.on.label}'s Connections.`,
          });
        }
        return;
      }
    }
  });

export function createWorkTogetherCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
  commands: PeerLinkCommands,
) {
  return createRuntimeCommand(runtime, {
    label: "environment-data:work-together:run",
    execute: (
      input: {
        readonly lines: ReadonlyArray<WorkTogetherLine>;
        readonly access: AuthMcpClientAccess;
        readonly onUpdate: (lines: ReadonlyArray<WorkTogetherLine>) => void;
      },
      registry,
    ) =>
      runWorkTogetherLines(
        input.lines,
        executeStep(input.access, commands, registry),
        input.onUpdate,
      ),
  });
}
