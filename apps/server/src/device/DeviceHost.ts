/**
 * A device host is a machine with simulators or emulators on it. The service
 * layer talks to this interface for local, SSH, and connected-environment hosts.
 *
 * Every ready host presents an origin where expo-device-hub answers.
 * Hosts add an agent-device daemon endpoint only after agent access is granted.
 * SSH hosts forward local endpoints; connected environments expose authenticated
 * proxies and execute typed device operations on the owning server.
 */
import type {
  DeviceHostId,
  DeviceHostSummary,
  DevicePlatform,
  DevicePlatformAvailability,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { NodeRuntimeUnavailableError } from "@t3tools/shared/nodeRuntime";
import type { DeviceService } from "./DeviceService.ts";
import type { DeviceEnvironmentInfo, DeviceError } from "@t3tools/contracts";

export class DeviceHostError extends Schema.TaggedError<DeviceHostError>()("DeviceHostError", {
  hostId: Schema.String,
  step: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Device host ${this.hostId} failed while ${this.step}.`;
  }
}

export class DeviceHostTimeoutError extends Schema.TaggedError<DeviceHostTimeoutError>()(
  "DeviceHostTimeoutError",
  { hostId: Schema.String, timeoutMs: Schema.Number },
) {
  override get message(): string {
    return `Device host ${this.hostId} did not start agent tools within ${this.timeoutMs} ms.`;
  }
}

export class AgentDeviceStartError extends Schema.TaggedError<AgentDeviceStartError>()(
  "AgentDeviceStartError",
  {
    hostId: Schema.String,
    stateDir: Schema.String,
    exitCode: Schema.NullOr(Schema.Int),
    reason: Schema.Literals([
      "daemon_lock_not_directory",
      "daemon_registration_unproven",
      "daemon_retirement_unconfirmed",
      "command_failed",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const exit = this.exitCode === null ? "" : ` (exit code ${this.exitCode})`;
    const detail =
      this.reason === "daemon_lock_not_directory"
        ? "Daemon registration ownership could not be verified: daemon.lock is not a directory."
        : this.reason === "daemon_registration_unproven"
          ? "Daemon registration ownership could not be verified."
          : this.reason === "daemon_retirement_unconfirmed"
            ? "Daemon replacement could not be confirmed."
            : "The AgentDevice startup command failed.";
    const recovery =
      this.reason === "command_failed"
        ? `Inspect daemon diagnostics in ${this.stateDir}.`
        : `Inspect daemon.lock and daemon diagnostics in ${this.stateDir}. Stop older clients and daemons with their original CLI before manually repairing retained state.`;
    return `Agent tools failed to start${exit}. ${detail} ${recovery}`;
  }
}

export interface DeviceHubEndpoint {
  /** Origin of expo-device-hub or an authenticated environment proxy. */
  readonly origin: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AgentDeviceEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  readonly entryPath: string;
}

export interface DeviceHostReady {
  /** Environment hosts execute typed operations on their owning server. */
  readonly remote?: Pick<
    DeviceService["Service"],
    "open" | "close" | "shutdown" | "detail" | "action" | "screenshot"
  > & {
    readonly list: Effect.Effect<DeviceEnvironmentInfo, DeviceError>;
  };
  /** Keeps driver sessions distinct when different environments reuse a thread ID. */
  readonly agentSessionNamespace?: string;
  readonly nodePath: string;
  readonly hub: DeviceHubEndpoint;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number; readonly stdin?: string },
  ) => Effect.Effect<{ readonly stdout: string; readonly stderr: string; readonly code: number }>;
  readonly helpers: {
    readonly serveSimAxSettings: string | null;
    readonly serveSimCli: string | null;
  };
}

export interface DeviceHostAgentReady extends DeviceHostReady {
  readonly agentDevice: AgentDeviceEndpoint;
}

export class DeviceHost extends Context.Service<
  DeviceHost,
  {
    readonly id: DeviceHostId;
    readonly summary: Effect.Effect<DeviceHostSummary>;
    readonly inspect?: Effect.Effect<DeviceHostSummary, DeviceHostError>;
    readonly platformAvailability: (
      platform: DevicePlatform,
    ) => Effect.Effect<DevicePlatformAvailability>;
    readonly ensureReady: (
      onPhase: (phase: "installing" | "starting", detail?: string) => Effect.Effect<void>,
    ) => Effect.Effect<DeviceHostReady, DeviceHostError | NodeRuntimeUnavailableError>;
    readonly ensureAgentReady: (
      onPhase: (phase: "installing" | "starting", detail?: string) => Effect.Effect<void>,
    ) => Effect.Effect<
      DeviceHostAgentReady,
      DeviceHostError | DeviceHostTimeoutError | AgentDeviceStartError | NodeRuntimeUnavailableError
    >;
    readonly current: Effect.Effect<DeviceHostReady | null>;
    /** The running agent-device endpoint, without starting anything. Local hosts only. */
    readonly currentAgent?: Effect.Effect<AgentDeviceEndpoint | null>;
    readonly stopAgent: Effect.Effect<void>;
    /** Stops helpers. Devices themselves keep running; the user owns those. */
    readonly stop: Effect.Effect<void>;
  }
>()("@styal/cli/device/DeviceHost") {}
