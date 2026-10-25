/**
 * A device definition lives under `.styal/hardware/` and is read from the remote default
 * branch, so changing it takes a merge. Its address and credential live in server settings,
 * because they are local to the machine.
 *
 * @module Hardware
 */
import { Schema } from "effect";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HARDWARE_DEFINITION_DIRECTORY = ".styal/hardware";

export const HardwareDeviceId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/),
);
export type HardwareDeviceId = typeof HardwareDeviceId.Type;

export const HardwareActionName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
);
export type HardwareActionName = typeof HardwareActionName.Type;

/**
 * - `read`: no lease needed, allowed while another thread holds the device.
 * - `operate`: the caller must hold the lease.
 * - `approve`: the caller must hold the lease and a human must approve the call.
 */
export const HardwareTier = Schema.Literals(["read", "operate", "approve"]);
export type HardwareTier = typeof HardwareTier.Type;

const TIER_RANK: Record<HardwareTier, number> = { read: 0, operate: 1, approve: 2 };

/** The stricter of two tiers. */
export const stricterHardwareTier = (a: HardwareTier, b: HardwareTier): HardwareTier =>
  TIER_RANK[a] >= TIER_RANK[b] ? a : b;

export const isLooserHardwareTier = (candidate: HardwareTier, than: HardwareTier) =>
  TIER_RANK[candidate] < TIER_RANK[than];

export const HardwareHttpMethod = Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type HardwareHttpMethod = typeof HardwareHttpMethod.Type;

/**
 * An absolute path on the device. No query, fragment, backslash, or leading
 * `//`, any of which could resolve to another host and carry the device
 * credential there.
 */
const HardwarePath = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^\/(?!\/)[^?#\s\\]*$/),
);

export const HardwareActionDefinition = Schema.Struct({
  method: HardwareHttpMethod,
  path: HardwarePath,
  tier: HardwareTier,
  /** Query parameter names the caller may set. Anything else is refused. */
  query: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** `file`: the request body is a workspace file the caller names. */
  body: Schema.optional(Schema.Literal("file")),
  description: Schema.optional(Schema.String),
});
export type HardwareActionDefinition = typeof HardwareActionDefinition.Type;

/**
 * A lifecycle hook step. Query values may use `$lease.purpose` and
 * `$lease.deviceTtlSeconds`.
 */
export const HardwareHookStep = Schema.Struct({
  action: HardwareActionName,
  query: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Renew hooks only: the minimum interval between runs. */
  everySeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3600 }))),
});
export type HardwareHookStep = typeof HardwareHookStep.Type;

export const HardwareDefinition = Schema.Struct({
  type: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  health: Schema.optional(
    Schema.Struct({
      path: HardwarePath,
      intervalSeconds: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 3600 })),
      ),
      timeoutMs: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 30_000 })),
      ),
      /** Dotted paths into the JSON health response, joined into a one-line summary. */
      summary: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  hooks: Schema.optional(
    Schema.Struct({
      acquire: Schema.optional(Schema.Array(HardwareHookStep)),
      renew: Schema.optional(Schema.Array(HardwareHookStep)),
      release: Schema.optional(Schema.Array(HardwareHookStep)),
    }),
  ),
  /** Seconds a device-side maintenance TTL should last; renew hooks keep it alive. */
  deviceTtlSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 3600 })),
  ),
  actions: Schema.Record(HardwareActionName, HardwareActionDefinition),
});
export type HardwareDefinition = typeof HardwareDefinition.Type;

const HardwareBaseUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash) ||
        "Use an http(s) address without credentials, query or fragment."
      );
    } catch {
      return "Invalid device address.";
    }
  }),
);

const HardwareDefinitionFile = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/),
);

/** One device instance on this environment. */
export const HardwareDeviceConfig = Schema.Struct({
  id: HardwareDeviceId,
  /** The project whose repository holds the definition. Only its threads may use the device. */
  projectId: ProjectId,
  /** File name under `.styal/hardware/` in that repository. */
  definitionFile: HardwareDefinitionFile,
  baseUrl: HardwareBaseUrl,
  /** Header the stored credential is sent in, when one is set. */
  auth: Schema.optional(
    Schema.Struct({
      header: Schema.optional(TrimmedNonEmptyString),
      scheme: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  /** The definition the user last accepted. Loosenings on the default branch wait for this. */
  acceptedDefinition: Schema.optional(HardwareDefinition),
});
export type HardwareDeviceConfig = typeof HardwareDeviceConfig.Type;

export const HardwareDeviceConfigs = Schema.Array(HardwareDeviceConfig).check(
  Schema.makeFilter(
    (devices) =>
      new Set(devices.map((device) => device.id)).size === devices.length ||
      "Hardware device ids must be unique.",
  ),
);

export const HardwareHealthStatus = Schema.Literals(["online", "offline", "unknown"]);
export type HardwareHealthStatus = typeof HardwareHealthStatus.Type;

export const HardwareHealth = Schema.Struct({
  status: HardwareHealthStatus,
  checkedAt: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  error: Schema.optional(Schema.String),
});
export type HardwareHealth = typeof HardwareHealth.Type;

export const HardwareLeaseSummary = Schema.Struct({
  threadId: ThreadId,
  purpose: Schema.String,
  grantedAt: Schema.String,
  lastActivityAt: Schema.String,
  /** When the lease ends if the thread stays idle. Null while the thread is busy or the lease is kept. */
  idleExpiresAt: Schema.NullOr(Schema.String),
  /** Null when the user chose to keep the lease until they release it. */
  hardExpiresAt: Schema.NullOr(Schema.String),
  keepUntilReleased: Schema.Boolean,
});
export type HardwareLeaseSummary = typeof HardwareLeaseSummary.Type;

export const HardwareDefinitionChange = Schema.Struct({
  action: Schema.String,
  kind: Schema.Literals(["added", "loosened", "hooks-changed", "other"]),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
});
export type HardwareDefinitionChange = typeof HardwareDefinitionChange.Type;

export const HardwareDefinitionStatus = Schema.Struct({
  /**
   * - `ok`: the default branch matches what the user accepted.
   * - `pending`: it has changes that wait for the user; the accepted rules apply meanwhile.
   * - `missing` / `invalid`: no usable definition on the default branch.
   */
  status: Schema.Literals(["ok", "pending", "missing", "invalid"]),
  /** The ref the definition was read from, such as `origin/main`. */
  source: Schema.NullOr(Schema.String),
  error: Schema.optional(Schema.String),
  pendingChanges: Schema.Array(HardwareDefinitionChange),
});
export type HardwareDefinitionStatus = typeof HardwareDefinitionStatus.Type;

export const HardwareActionSummary = Schema.Struct({
  name: Schema.String,
  method: HardwareHttpMethod,
  path: Schema.String,
  tier: HardwareTier,
  query: Schema.Array(Schema.String),
  body: Schema.optional(Schema.Literal("file")),
  description: Schema.optional(Schema.String),
});
export type HardwareActionSummary = typeof HardwareActionSummary.Type;

export const HardwareDeviceState = Schema.Struct({
  id: HardwareDeviceId,
  name: Schema.String,
  projectId: ProjectId,
  baseUrl: Schema.String,
  health: HardwareHealth,
  lease: Schema.NullOr(HardwareLeaseSummary),
  queue: Schema.Array(Schema.Struct({ threadId: ThreadId, queuedAt: Schema.String })),
  paused: Schema.Boolean,
  /** The last lease ended and its release hooks are still running; nobody can acquire yet. */
  cleaningUp: Schema.Boolean,
  hasCredential: Schema.Boolean,
  definition: HardwareDefinitionStatus,
  /** The effective actions, after accepted-definition and tightening rules. */
  actions: Schema.Array(HardwareActionSummary),
});
export type HardwareDeviceState = typeof HardwareDeviceState.Type;

export const HardwareServiceState = Schema.Struct({
  devices: Schema.Array(HardwareDeviceState),
});
export type HardwareServiceState = typeof HardwareServiceState.Type;

export const HardwareAuditEvent = Schema.Literals([
  "lease.requested",
  "lease.granted",
  "lease.queued",
  "lease.released",
  "lease.revoked",
  "lease.expired",
  "call",
  "hook",
  "approval.requested",
  "approval.decided",
  "cleanup.failed",
  "definition.accepted",
  "paused",
  "resumed",
]);
export type HardwareAuditEvent = typeof HardwareAuditEvent.Type;

export const HardwareAuditEntry = Schema.Struct({
  id: Schema.Int,
  deviceId: HardwareDeviceId,
  occurredAt: Schema.String,
  /** Last time a coalesced row was repeated. */
  lastOccurredAt: Schema.String,
  actor: Schema.Literals(["thread", "user", "system"]),
  threadId: Schema.NullOr(ThreadId),
  event: HardwareAuditEvent,
  action: Schema.NullOr(Schema.String),
  detail: Schema.Record(Schema.String, Schema.Unknown),
  repeatCount: Schema.Int,
});
export type HardwareAuditEntry = typeof HardwareAuditEntry.Type;

// RPC inputs

/** What the user can do to a lease from a client. */
export const HardwareControlInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("revoke"), deviceId: HardwareDeviceId }),
  Schema.Struct({
    type: Schema.Literal("set-paused"),
    deviceId: HardwareDeviceId,
    paused: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("set-keep"),
    deviceId: HardwareDeviceId,
    keepUntilReleased: Schema.Boolean,
  }),
]);
export type HardwareControlInput = typeof HardwareControlInput.Type;

/** Changes that need settings access: accepting a definition, storing a credential. */
export const HardwareConfigureInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("accept-definition"), deviceId: HardwareDeviceId }),
  Schema.Struct({
    type: Schema.Literal("set-credential"),
    deviceId: HardwareDeviceId,
    /** Null removes the stored credential. Never returned to clients. */
    value: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  }),
]);
export type HardwareConfigureInput = typeof HardwareConfigureInput.Type;

export const HardwareAuditListInput = Schema.Struct({
  deviceId: HardwareDeviceId,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type HardwareAuditListInput = typeof HardwareAuditListInput.Type;

export const HardwareAuditListResult = Schema.Struct({
  entries: Schema.Array(HardwareAuditEntry),
});
export type HardwareAuditListResult = typeof HardwareAuditListResult.Type;

export class HardwareError extends Schema.TaggedError<HardwareError>()("HardwareError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

// MCP tools

export const HardwareToolListInput = Schema.Struct({
  device: Schema.optional(
    HardwareDeviceId.annotate({ description: "Limit to one device. Defaults to all." }),
  ),
});
export type HardwareToolListInput = typeof HardwareToolListInput.Type;

export const HardwareToolDevice = Schema.Struct({
  id: HardwareDeviceId,
  name: Schema.String,
  health: HardwareHealthStatus,
  summary: Schema.NullOr(Schema.String),
  /** `you`, another thread's title, or null when nobody holds it. */
  holder: Schema.NullOr(Schema.String),
  leaseIdleExpiresAt: Schema.NullOr(Schema.String),
  queueLength: Schema.Int,
  paused: Schema.Boolean,
  actions: Schema.Array(HardwareActionSummary),
  /** The default branch has definition changes the user has not accepted yet. */
  definitionPending: Schema.Boolean,
});
export type HardwareToolDevice = typeof HardwareToolDevice.Type;

export const HardwareToolListResult = Schema.Struct({
  devices: Schema.Array(HardwareToolDevice),
});
export type HardwareToolListResult = typeof HardwareToolListResult.Type;

export const HardwareToolAcquireInput = Schema.Struct({
  device: HardwareDeviceId,
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
    description: "One short sentence the user sees, e.g. 'calibration capture, front angle'.",
  }),
  wait: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Wait in line while another thread holds the device or it is offline. Defaults to false: fail at once with who holds it.",
    }),
  ),
  waitMinutes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })).annotate({
      description: "How long to wait when wait is true. Defaults to 10.",
    }),
  ),
  idleMinutes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 120 })).annotate({
      description:
        "How long the lease survives after this thread's turn ends with no further calls. Defaults to 30.",
    }),
  ),
});
export type HardwareToolAcquireInput = typeof HardwareToolAcquireInput.Type;

export const HardwareToolAcquireResult = Schema.Struct({
  device: HardwareDeviceId,
  hardExpiresAt: Schema.NullOr(Schema.String),
  /**
   * Loopback base URL that forwards read and operate actions for this lease,
   * for scripts on this machine. It stops working when the lease ends.
   */
  proxyBaseUrl: Schema.String,
});
export type HardwareToolAcquireResult = typeof HardwareToolAcquireResult.Type;

export const HardwareToolCallInput = Schema.Struct({
  device: HardwareDeviceId,
  action: HardwareActionName.annotate({ description: "Action name from hardware_list." }),
  query: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
    ).annotate({ description: "Query parameters the action allows." }),
  ),
  bodyFile: Schema.optional(
    Schema.String.annotate({
      description:
        "For actions whose body is a file: a path inside this thread's workspace, sent as the request body.",
    }),
  ),
});
export type HardwareToolCallInput = typeof HardwareToolCallInput.Type;

export const HardwareToolCallResult = Schema.Struct({
  status: Schema.Int,
  contentType: Schema.NullOr(Schema.String),
  body: Schema.Unknown,
  truncated: Schema.Boolean,
});
export type HardwareToolCallResult = typeof HardwareToolCallResult.Type;

export const HardwareToolReleaseInput = Schema.Struct({ device: HardwareDeviceId });
export type HardwareToolReleaseInput = typeof HardwareToolReleaseInput.Type;

export const HardwareToolReleaseResult = Schema.Struct({ released: Schema.Boolean });
export type HardwareToolReleaseResult = typeof HardwareToolReleaseResult.Type;

export const HardwareToolErrorCode = Schema.Literals([
  "not_found",
  "offline",
  "busy",
  "not_held",
  "paused",
  "forbidden",
  "approval_declined",
  "approval_timeout",
  "invalid_request",
  "request_failed",
  "unavailable",
]);
export type HardwareToolErrorCode = typeof HardwareToolErrorCode.Type;

export class HardwareToolError extends Schema.TaggedError<HardwareToolError>()(
  "HardwareToolError",
  {
    code: HardwareToolErrorCode,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}
