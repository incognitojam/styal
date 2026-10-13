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

export interface DeviceHubEndpoint {
  /** Origin of expo-device-hub or an authenticated environment proxy. */
  readonly origin: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Environment hosts verify a reachable address before a new stream attaches. */
  readonly resolve?: Effect.Effect<DeviceHubEndpoint, DeviceError>;
}

export interface AgentDeviceEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  /** Host-local path of the agent-device entry script. The provider uses a separate local CLI install. */
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
  /**
   * Runs a host command (`xcrun`, `adb`, or a helper bundled with the hub)
   * where the devices live. On the local host this is a plain spawn; a
   * remote host would run it over its transport.
   */
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number; readonly stdin?: string },
  ) => Effect.Effect<{ readonly stdout: string; readonly stderr: string; readonly code: number }>;
  /** Absolute paths of helper binaries vendored with the hub, when present. */
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
    /**
     * Installs tools on first use and starts the helper processes. Idempotent:
     * concurrent callers share one start, and a ready host returns immediately.
     */
    readonly ensureReady: (
      onPhase: (phase: "installing" | "starting", detail?: string) => Effect.Effect<void>,
    ) => Effect.Effect<DeviceHostReady, DeviceHostError | NodeRuntimeUnavailableError>;
    /** Installs and starts agent-device after the user grants agent access. */
    readonly ensureAgentReady: (
      onPhase: (phase: "installing" | "starting", detail?: string) => Effect.Effect<void>,
    ) => Effect.Effect<
      DeviceHostAgentReady,
      DeviceHostError | DeviceHostTimeoutError | NodeRuntimeUnavailableError
    >;
    /** Current endpoints when already running, without starting anything. */
    readonly current: Effect.Effect<DeviceHostReady | null>;
    /** The running agent-device endpoint, without starting anything. */
    readonly currentAgent?: Effect.Effect<AgentDeviceEndpoint | null>;
    /** Stops only agent-device. Manual viewing through the hub stays available. */
    readonly stopAgent: Effect.Effect<void>;
    /** Stops helpers. Devices themselves keep running; the user owns those. */
    readonly stop: Effect.Effect<void>;
  }
>()("@styal/cli/device/DeviceHost") {}
