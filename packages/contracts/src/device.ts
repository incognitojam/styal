/**
 * Device - Schemas for first-class iOS Simulator and Android Emulator support.
 *
 * The server owns device discovery, the streaming helper (expo-device-hub),
 * and the agent driver (agent-device). Clients render the live screen from the
 * server-proxied stream, and agents reach devices through the `device_*` MCP
 * tools plus the `agent-device` CLI the server preconfigures for them.
 *
 * Devices live on the local machine, an SSH host, or a connected environment.
 *
 * @module Device
 */
import { Schema } from "effect";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { AuthSessionId, EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DevicePlatform = Schema.Literals(["ios", "android"]);
export type DevicePlatform = typeof DevicePlatform.Type;

export const DeviceHostId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type DeviceHostId = typeof DeviceHostId.Type;

/** The server machine. Always present. */
export const LOCAL_DEVICE_HOST_ID = "local" as DeviceHostId;

/** SSH aliases and key paths are resolved on the environment server. */
export const SshDeviceHostConfig = Schema.Struct({
  id: DeviceHostId.check(
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    Schema.makeFilter((id) => id !== "local" || "The local host id is reserved."),
  ),
  label: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString.check(Schema.isPattern(/^[^\s-][^\s]*$/)),
  identityFile: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
});
export type SshDeviceHostConfig = typeof SshDeviceHostConfig.Type;

export const SshDeviceHostConfigs = Schema.Array(SshDeviceHostConfig).check(
  Schema.makeFilter(
    (hosts) =>
      new Set(hosts.map((host) => host.id)).size === hosts.length ||
      "Device host ids must be unique.",
  ),
);

const DeviceEnvironmentUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash) ||
        "Invalid device environment address."
      );
    } catch {
      return "Invalid device environment address.";
    }
  }),
);
const DeviceEnvironmentUrls = Schema.NonEmptyArray(DeviceEnvironmentUrl);

export const EnvironmentDeviceHostConfig = Schema.Struct({
  id: DeviceHostId.check(Schema.isPattern(/^environment-[a-f0-9]{24}$/)),
  label: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  /** Initially verified address. Older saved hosts have only this field. */
  url: DeviceEnvironmentUrl,
  urls: Schema.optional(DeviceEnvironmentUrls),
  sessionId: AuthSessionId,
});
export type EnvironmentDeviceHostConfig = typeof EnvironmentDeviceHostConfig.Type;
export const EnvironmentDeviceHostConfigs = Schema.Array(EnvironmentDeviceHostConfig).check(
  Schema.makeFilter(
    (hosts) =>
      new Set(hosts.map((host) => host.id)).size === hosts.length ||
      "Device host ids must be unique.",
  ),
);
export const DeviceHostGrantInput = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceLabel: TrimmedNonEmptyString,
});
export const DeviceHostGrant = Schema.Struct({
  environmentId: EnvironmentId,
  sourceEnvironmentId: EnvironmentId,
  sessionId: AuthSessionId,
  token: TrimmedNonEmptyString,
});
export type DeviceHostGrant = typeof DeviceHostGrant.Type;
const DeviceConnectEnvironmentAddresses = Schema.Struct({
  label: TrimmedNonEmptyString,
  urls: DeviceEnvironmentUrls,
  grant: DeviceHostGrant,
});
export const DeviceConnectEnvironmentInput = Schema.Union([
  DeviceConnectEnvironmentAddresses,
  Schema.Struct({
    label: TrimmedNonEmptyString,
    url: DeviceEnvironmentUrl,
    grant: DeviceHostGrant,
  }).pipe(
    Schema.decodeTo(
      Schema.toType(DeviceConnectEnvironmentAddresses),
      SchemaTransformation.transform({
        decode: ({ url, ...input }): typeof DeviceConnectEnvironmentAddresses.Type => ({
          ...input,
          urls: [url],
        }),
        encode: ({ urls, ...input }) => ({ ...input, url: urls[0] }),
      }),
    ),
  ),
]);
export type DeviceConnectEnvironmentInput = typeof DeviceConnectEnvironmentInput.Type;

/** Simulator udid or adb serial (an AVD name while it is not running). */
export const DeviceId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type DeviceId = typeof DeviceId.Type;

export const DeviceSummary = Schema.Struct({
  hostId: DeviceHostId,
  id: DeviceId,
  platform: DevicePlatform,
  name: TrimmedNonEmptyString,
  /** OS label such as "iOS 18.0" or "Android 15.0". */
  version: Schema.String,
  booted: Schema.Boolean,
  physical: Schema.Boolean,
});
export type DeviceSummary = typeof DeviceSummary.Type;

/**
 * What the host can do right now. Platforms missing their toolchain are
 * reported rather than hidden so the picker and the agent can explain why a
 * platform is absent instead of showing an empty list.
 */
export const DevicePlatformAvailability = Schema.Struct({
  platform: DevicePlatform,
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});
export type DevicePlatformAvailability = typeof DevicePlatformAvailability.Type;

export const DeviceToolVersion = Schema.Struct({
  requiredVersion: Schema.String,
  installedVersions: Schema.Array(Schema.String),
  runningVersion: Schema.NullOr(Schema.String),
});
export type DeviceToolVersion = typeof DeviceToolVersion.Type;

export const DeviceToolVersions = Schema.Struct({
  hub: DeviceToolVersion,
  agent: DeviceToolVersion,
});
export type DeviceToolVersions = typeof DeviceToolVersions.Type;

export const DeviceHostSummary = Schema.Struct({
  id: DeviceHostId,
  kind: Schema.Literals(["local", "ssh", "environment"]),
  label: TrimmedNonEmptyString,
  connectedUrl: Schema.optional(DeviceEnvironmentUrl),
  platforms: Schema.Array(DevicePlatformAvailability),
  tools: Schema.optional(DeviceToolVersions),
  toolInspectionError: Schema.optional(Schema.String),
  hubInstalled: Schema.Boolean,
  agentDeviceInstalled: Schema.Boolean,
});
export type DeviceHostSummary = typeof DeviceHostSummary.Type;

/**
 * Lifecycle of the helper processes on a host. Tools are installed on first
 * use, so a fresh install spends a while in `installing` before any device can
 * stream; the UI shows that instead of an empty picker.
 */
export const DeviceHostStatus = Schema.Literals([
  "disabled",
  "idle",
  "installing",
  "starting",
  "ready",
  "failed",
]);
export type DeviceHostStatus = typeof DeviceHostStatus.Type;

/**
 * A device a thread is looking at. One session per (thread, device); the same
 * device may be open in several threads, since the stream is shared.
 */
export const DeviceSession = Schema.Struct({
  threadId: ThreadId,
  hostId: DeviceHostId,
  deviceId: DeviceId,
  platform: DevicePlatform,
  openedAt: Schema.String,
});
export type DeviceSession = typeof DeviceSession.Type;

export const DeviceServiceState = Schema.Struct({
  supportsEnvironmentHosts: Schema.optional(Schema.Boolean),
  supportsEnvironmentHostAddresses: Schema.optional(Schema.Boolean),
  supportsHostRetry: Schema.optional(Schema.Boolean),
  supportsToolUpdate: Schema.optional(Schema.Boolean),
  supportsToolInspection: Schema.optional(Schema.Boolean),
  hosts: Schema.Array(DeviceHostSummary),
  hostStatus: DeviceHostStatus,
  hostStatusDetail: Schema.optional(Schema.String),
  hostStatuses: Schema.Record(
    DeviceHostId,
    Schema.Struct({
      status: DeviceHostStatus,
      detail: Schema.optional(Schema.String),
    }),
  ),
  devices: Schema.Array(DeviceSummary),
  sessions: Schema.Array(DeviceSession),
  externalSessions: Schema.optional(Schema.Array(DeviceSession)),
  bootingDevices: Schema.optional(
    Schema.Array(Schema.Struct({ ...DeviceSummary.fields, threadId: ThreadId })),
  ),
  onboardingCompleted: Schema.Boolean,
  agentAccessEnabled: Schema.Boolean,
  /** Origin-relative path the client prefixes to hub routes. */
  hubBasePath: Schema.String,
  revision: Schema.Int,
});
export type DeviceServiceState = typeof DeviceServiceState.Type;

export const DeviceListInput = Schema.Struct({
  /** Install this server's pinned tool without enabling access or starting helpers. */
  updateTool: Schema.optional(Schema.Literals(["hub", "agent"])),
  /** Read inventory without installing tools or starting helpers. */
  inspectOnly: Schema.optional(Schema.Boolean),
  /** Retry this host only, including agent tools if access was already granted. */
  retryHostId: Schema.optional(DeviceHostId),
});
export type DeviceListInput = typeof DeviceListInput.Type;

export const DeviceConfigureInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  agentAccessEnabled: Schema.optional(Schema.Boolean),
  onboardingCompleted: Schema.optional(Schema.Boolean),
});
export type DeviceConfigureInput = typeof DeviceConfigureInput.Type;

export const DeviceOpenInput = Schema.Struct({
  threadId: ThreadId,
  hostId: Schema.optional(DeviceHostId),
  deviceId: DeviceId,
  platform: DevicePlatform,
  /** Boot the simulator or emulator when it is not running. Defaults to true. */
  boot: Schema.optional(Schema.Boolean),
  /**
   * Agent opens only: release other threads' holds on the device even while
   * their agents work. Without it, a device another thread is using fails with
   * `DeviceHeldError`. Device panel opens never take a device from an agent.
   */
  takeOver: Schema.optional(Schema.Boolean),
});
export type DeviceOpenInput = typeof DeviceOpenInput.Type;

export const DeviceCloseInput = Schema.Struct({
  hostId: Schema.optional(DeviceHostId),
  threadId: ThreadId,
  /** Omit to close every device session for the thread. */
  deviceId: Schema.optional(DeviceId),
  /** Also shut the simulator or emulator down. Defaults to false. */
  shutdown: Schema.optional(Schema.Boolean),
});
export type DeviceCloseInput = typeof DeviceCloseInput.Type;

export const DeviceShutdownInput = Schema.Struct({
  hostId: Schema.optional(DeviceHostId),
  deviceId: DeviceId,
  platform: DevicePlatform,
});
export type DeviceShutdownInput = typeof DeviceShutdownInput.Type;

// Device settings and actions. Each setting names the platforms that support
// it; the panel hides the rest. Values are normalized across platforms where
// both have the concept (appearance, text size) and platform-specific where
// only one does.

export const DeviceAppearance = Schema.Literals(["light", "dark"]);
export type DeviceAppearance = typeof DeviceAppearance.Type;

/**
 * iOS content-size categories map onto twelve steps; Android `font_scale`
 * is continuous. Four shared steps cover what people actually reach for.
 */
export const DeviceTextSize = Schema.Literals(["small", "default", "large", "extra-large"]);
export type DeviceTextSize = typeof DeviceTextSize.Type;

export const DeviceColorFilter = Schema.Literals([
  "none",
  "grayscale",
  "red-green",
  "green-red",
  "blue-yellow",
]);
export type DeviceColorFilter = typeof DeviceColorFilter.Type;

export const DeviceOrientation = Schema.Literals([
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
]);
export type DeviceOrientation = typeof DeviceOrientation.Type;

/** Current values as read from the device; `undefined` means unsupported or unread. */
export const DeviceSettings = Schema.Struct({
  appearance: Schema.optional(DeviceAppearance),
  textSize: Schema.optional(DeviceTextSize),
  reduceMotion: Schema.optional(Schema.Boolean),
  increaseContrast: Schema.optional(Schema.Boolean),
  reduceTransparency: Schema.optional(Schema.Boolean),
  showBorders: Schema.optional(Schema.Boolean),
  voiceOver: Schema.optional(Schema.Boolean),
  liquidGlass: Schema.optional(Schema.Literals(["clear", "tinted"])),
  colorFilter: Schema.optional(DeviceColorFilter),
  networkEnabled: Schema.optional(Schema.Boolean),
  location: Schema.optional(
    Schema.NullOr(Schema.Struct({ latitude: Schema.Number, longitude: Schema.Number })),
  ),
});
export type DeviceSettings = typeof DeviceSettings.Type;

/** The app in the foreground, when the platform can tell us. */
export const DeviceForegroundApp = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
});
export type DeviceForegroundApp = typeof DeviceForegroundApp.Type;

export const DeviceDetail = Schema.Struct({
  hostId: DeviceHostId,
  deviceId: DeviceId,
  settings: DeviceSettings,
  foregroundApp: Schema.NullOr(DeviceForegroundApp),
  readAt: Schema.String,
});
export type DeviceDetail = typeof DeviceDetail.Type;

export const DevicePermission = Schema.Literals([
  "camera",
  "microphone",
  "photos",
  "contacts",
  "calendar",
  "reminders",
  "location",
  "notifications",
  "motion",
  "media-library",
  "faceid",
]);
export type DevicePermission = typeof DevicePermission.Type;

const DeviceTarget = {
  hostId: Schema.optional(DeviceHostId),
  deviceId: DeviceId,
};

export const DeviceActionInput = Schema.Union([
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setAppearance"),
    value: DeviceAppearance,
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("setTextSize"), value: DeviceTextSize }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setToggle"),
    setting: Schema.Literals([
      "reduceMotion",
      "increaseContrast",
      "reduceTransparency",
      "showBorders",
      "voiceOver",
      "networkEnabled",
    ]),
    value: Schema.Boolean,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setLiquidGlass"),
    value: Schema.Literals(["clear", "tinted"]),
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setColorFilter"),
    value: DeviceColorFilter,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setOrientation"),
    value: DeviceOrientation,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setLocation"),
    latitude: Schema.Number.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
    longitude: Schema.Number.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("clearLocation") }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setPermission"),
    appId: TrimmedNonEmptyString,
    permission: DevicePermission,
    decision: Schema.Literals(["grant", "revoke", "reset"]),
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("openUrl"), url: TrimmedNonEmptyString }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("launchApp"),
    appId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("terminateApp"),
    appId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("shake") }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("sendPush"),
    appId: TrimmedNonEmptyString,
    /** APNs-style payload; a bare string becomes the alert body. */
    payload: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
  }),
]);
export type DeviceActionInput = typeof DeviceActionInput.Type;
export type DeviceActionType = DeviceActionInput["type"];

export const DeviceDetailInput = Schema.Struct(DeviceTarget);
export type DeviceDetailInput = typeof DeviceDetailInput.Type;

export const DeviceEnvironmentIdentity = Schema.Struct({
  environmentId: EnvironmentId,
  sourceEnvironmentId: EnvironmentId,
});
export const DeviceEnvironmentInfo = Schema.Struct({
  ...DeviceEnvironmentIdentity.fields,
  host: DeviceHostSummary,
  devices: Schema.Array(DeviceSummary),
  sessions: Schema.Array(DeviceSession),
});
export type DeviceEnvironmentInfo = typeof DeviceEnvironmentInfo.Type;
export const DevicePeerCommand = Schema.Union([
  Schema.Struct({
    operation: Schema.Literals([
      "identify",
      "inspect",
      "list",
      "agent",
      "stop-agent",
      "release",
      "revoke",
    ]),
  }),
  Schema.Struct({ operation: Schema.Literal("open"), input: DeviceOpenInput }),
  Schema.Struct({ operation: Schema.Literal("close"), input: DeviceCloseInput }),
  Schema.Struct({ operation: Schema.Literal("shutdown"), input: DeviceShutdownInput }),
  Schema.Struct({ operation: Schema.Literal("detail"), input: DeviceDetailInput }),
  Schema.Struct({ operation: Schema.Literal("action"), input: DeviceActionInput }),
  Schema.Struct({ operation: Schema.Literal("screenshot"), input: DeviceDetailInput }),
]);
export type DevicePeerCommand = typeof DevicePeerCommand.Type;
export const DevicePeerScreenshot = Schema.Struct({ device: DeviceSummary, png: Schema.String });
/** Agent proxy credential, separate from the grant so agents cannot issue peer commands. */
export const DevicePeerAgent = Schema.Struct({ token: TrimmedNonEmptyString });

export class DeviceHostUnavailableError extends Schema.TaggedError<DeviceHostUnavailableError>()(
  "DeviceHostUnavailableError",
  {
    hostId: DeviceHostId,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Device host ${this.hostId} is unavailable: ${this.reason}`;
  }
}

export class DevicePlatformUnavailableError extends Schema.TaggedError<DevicePlatformUnavailableError>()(
  "DevicePlatformUnavailableError",
  {
    hostId: DeviceHostId,
    platform: DevicePlatform,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `${this.platform} devices are unavailable on host ${this.hostId}: ${this.reason}`;
  }
}

export class DeviceNotFoundError extends Schema.TaggedError<DeviceNotFoundError>()(
  "DeviceNotFoundError",
  {
    hostId: DeviceHostId,
    deviceId: DeviceId,
  },
) {
  override get message(): string {
    return `Device ${this.deviceId} was not found on host ${this.hostId}.`;
  }
}

export class DeviceBootError extends Schema.TaggedError<DeviceBootError>()("DeviceBootError", {
  hostId: DeviceHostId,
  deviceId: DeviceId,
  reason: Schema.Literals(["disk_space", "timeout", "launch_failed"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const explanation = {
      disk_space: "There is not enough free disk space on the environment server.",
      timeout: "The device did not become ready in time.",
      launch_failed:
        "The simulator or emulator could not start. Check its configuration on the environment server.",
    }[this.reason];
    return `Device ${this.deviceId} failed to boot: ${explanation}`;
  }
}

export class DeviceOperationError extends Schema.TaggedError<DeviceOperationError>()(
  "DeviceOperationError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "command_failed",
      "request_failed",
      "invalid_payload",
      "settings_failed",
      "hub_rejected",
    ]),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const explanation = {
      command_failed: `The device command failed${this.exitCode === undefined ? "" : ` (exit code ${this.exitCode})`}.`,
      request_failed: "Could not communicate with device support. Try refreshing devices.",
      invalid_payload: "The device request could not be encoded.",
      settings_failed: "Could not read or save device settings.",
      hub_rejected: "The device hub could not complete the request.",
    }[this.reason];
    return `Device ${this.operation} failed: ${explanation}`;
  }
}

export class DeviceActionUnavailableError extends Schema.TaggedError<DeviceActionUnavailableError>()(
  "DeviceActionUnavailableError",
  {
    operation: Schema.String,
    platform: DevicePlatform,
    reason: Schema.Literals(["unsupported", "helper_missing"]),
  },
) {
  override get message(): string {
    return this.reason === "helper_missing"
      ? `Device ${this.operation} requires a helper missing from this install. Set up device support again.`
      : `Device ${this.operation} is not supported on ${this.platform}.`;
  }
}

export class DeviceHeldError extends Schema.TaggedError<DeviceHeldError>()("DeviceHeldError", {
  hostId: DeviceHostId,
  deviceId: DeviceId,
  /** Threads using the device: their agent is working, someone watches it, or another environment holds it. */
  threadIds: Schema.Array(ThreadId),
}) {
  override get message(): string {
    return `Device ${this.deviceId} on host ${this.hostId} is in use by thread ${this.threadIds.join(", ")}: its agent may be driving it, or the user is watching it. Pick another device, or ask the user and pass takeOver: true to release that thread's hold.`;
  }
}

export const DeviceError = Schema.Union([
  DeviceHostUnavailableError,
  DeviceHeldError,
  DevicePlatformUnavailableError,
  DeviceNotFoundError,
  DeviceBootError,
  DeviceOperationError,
  DeviceActionUnavailableError,
]);
export type DeviceError = typeof DeviceError.Type;

// MCP tool shapes. Kept next to the RPC shapes so the tool surface and the
// panel describe devices the same way.

export const DeviceToolListResult = Schema.Struct({
  hostStatuses: DeviceServiceState.fields.hostStatuses,
  hosts: Schema.Array(DeviceHostSummary),
  devices: Schema.Array(DeviceSummary),
  /** Devices already open in this thread's Device panel. */
  open: Schema.Array(Schema.Struct({ hostId: DeviceHostId, deviceId: DeviceId })),
  /** Devices other threads have open, one entry per thread. */
  openInOtherThreads: Schema.Array(
    Schema.Struct({
      hostId: DeviceHostId,
      deviceId: DeviceId,
      threadId: ThreadId,
      /**
       * The thread's agent is working, someone is watching the device, or another
       * environment holds it, so device_open needs takeOver. Otherwise device_open
       * hands the device over.
       */
      inUse: Schema.Boolean,
    }),
  ),
});
export type DeviceToolListResult = typeof DeviceToolListResult.Type;

export const DeviceToolOpenInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({
      description:
        "Simulator udid or emulator serial from device_list. Omit to use a booted device for the platform that no other thread has open.",
    }),
  ),
  platform: Schema.optional(
    DevicePlatform.annotate({
      description: "Required when deviceId is omitted and both platforms are available.",
    }),
  ),
  hostId: Schema.optional(
    DeviceHostId.annotate({ description: "Device host from device_list. Defaults to local." }),
  ),
  takeOver: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Take the device from another thread that is using it, releasing that thread's hold. Only when the user asked for it. Defaults to false.",
    }),
  ),
}).annotate({
  description:
    "Boots the device if needed, starts its live stream, and opens the Device panel so the user can watch. Returns how to drive it with the agent-device CLI.",
});
export type DeviceToolOpenInput = typeof DeviceToolOpenInput.Type;

export const DeviceToolOpenResult = Schema.Struct({
  device: DeviceSummary,
  /** Ready-to-run agent-device invocation pinned to this device. */
  agentDevice: Schema.Struct({
    command: Schema.String,
    /** Flags that pin every command to this device, e.g. `--udid <id>`. */
    targetArgs: Schema.Array(Schema.String),
  }),
  quickStart: Schema.String,
});
export type DeviceToolOpenResult = typeof DeviceToolOpenResult.Type;

export const DeviceToolTargetInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({
      description:
        "Device from device_list. Omit to use the device most recently opened in this thread.",
    }),
  ),
  hostId: Schema.optional(DeviceHostId),
});
export type DeviceToolTargetInput = typeof DeviceToolTargetInput.Type;

export const DeviceToolScreenshotResult = Schema.Struct({
  device: DeviceSummary,
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
export type DeviceToolScreenshotResult = typeof DeviceToolScreenshotResult.Type;

export const DeviceToolCloseInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({
      description: "Device to close. Omit to close every device in this thread.",
    }),
  ),
  hostId: Schema.optional(DeviceHostId),
  shutdown: Schema.optional(
    Schema.Boolean.annotate({
      description: "Also power the simulator or emulator off. Defaults to false.",
    }),
  ),
});
export type DeviceToolCloseInput = typeof DeviceToolCloseInput.Type;

export class DeviceToolUnavailableError extends Schema.TaggedError<DeviceToolUnavailableError>()(
  "DeviceToolUnavailableError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const DeviceToolError = Schema.Union([
  DeviceToolUnavailableError,
  DeviceHostUnavailableError,
  DeviceHeldError,
  DevicePlatformUnavailableError,
  DeviceNotFoundError,
  DeviceBootError,
  DeviceOperationError,
  DeviceActionUnavailableError,
]);
export type DeviceToolError = typeof DeviceToolError.Type;

export function deviceToolInstallMessage(name: string, tool: DeviceToolVersion | undefined) {
  if (!tool) return `Installing ${name}…`;
  const previous =
    tool.runningVersion ??
    [...tool.installedVersions].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
  return previous && !tool.installedVersions.includes(tool.requiredVersion)
    ? `Updating ${name} from ${previous} to ${tool.requiredVersion}…`
    : `Installing ${name} ${tool.requiredVersion}…`;
}
