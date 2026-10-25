import {
  type HardwareAuditEntry,
  type HardwareDeviceConfig,
  type HardwareDeviceState,
  type HardwareLeaseSummary,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * The server probes device health while anyone is subscribed, so the stream
 * closes shortly after the last hardware surface unmounts instead of idling
 * for the default five minutes.
 */
const HARDWARE_STATE_IDLE_TTL_MS = 10_000;

export function createHardwareEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    /** Full snapshots of every device on one environment. */
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hardware:state",
      tag: WS_METHODS.subscribeHardwareState,
      idleTtlMs: HARDWARE_STATE_IDLE_TTL_MS,
    }),
    /** Revoke, pause/resume, keep-until-released. */
    control: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hardware:control",
      tag: WS_METHODS.hardwareControl,
      scheduler,
      concurrency,
    }),
    /** Accept a definition, store or clear a credential. */
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hardware:configure",
      tag: WS_METHODS.hardwareConfigure,
      scheduler,
      concurrency,
    }),
    auditList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:hardware:audit-list",
      tag: WS_METHODS.hardwareAuditList,
      idleTtlMs: 30_000,
    }),
  };
}

/** Whole minutes, hours and days, rounded down; under a minute reads "<1m". */
export function formatHardwareDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export type HardwareLeaseState =
  | { readonly kind: "kept" }
  | { readonly kind: "working" }
  | { readonly kind: "idle"; readonly remainingMs: number };

/**
 * The lease's current state. A kept lease never times out; a lease with no
 * idle deadline belongs to a busy thread; otherwise the idle clock runs.
 */
function hardwareLeaseState(lease: HardwareLeaseSummary, nowMs: number): HardwareLeaseState {
  if (lease.keepUntilReleased) return { kind: "kept" };
  if (lease.idleExpiresAt === null) return { kind: "working" };
  return { kind: "idle", remainingMs: Date.parse(lease.idleExpiresAt) - nowMs };
}

/** "kept", "working" or "idle 12m left", for the thread chip. */
export function hardwareLeaseStateLabel(lease: HardwareLeaseSummary, nowMs: number): string {
  const state = hardwareLeaseState(lease, nowMs);
  if (state.kind === "kept") return "kept";
  if (state.kind === "working") return "working";
  return state.remainingMs <= 0
    ? "idle, ending"
    : `idle ${formatHardwareDuration(state.remainingMs)} left`;
}

/** One line of expiry detail for the settings list. */
export function hardwareLeaseExpiryLabel(lease: HardwareLeaseSummary, nowMs: number): string {
  if (lease.keepUntilReleased || lease.hardExpiresAt === null) return "Kept until released";
  const state = hardwareLeaseState(lease, nowMs);
  const hardRemaining = Date.parse(lease.hardExpiresAt) - nowMs;
  const hard = `ends in ${formatHardwareDuration(hardRemaining)} at the latest`;
  if (state.kind === "idle") {
    return state.remainingMs <= 0
      ? `Idle, ending now; ${hard}`
      : `Idle, ends in ${formatHardwareDuration(state.remainingMs)}; ${hard}`;
  }
  return `Thread is working; ${hard}`;
}

/** Devices the thread currently holds. */
export function hardwareDevicesHeldBy(
  devices: ReadonlyArray<HardwareDeviceState>,
  threadId: ThreadId,
): ReadonlyArray<HardwareDeviceState> {
  return devices.filter((device) => device.lease?.threadId === threadId);
}

const detailString = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : null;

/** The few audit detail fields worth a glance: HTTP status, decision, reason, error. */
export function hardwareAuditDetailSummary(entry: HardwareAuditEntry): string | null {
  const parts: string[] = [];
  const { detail } = entry;
  const status = detailString(detail.status);
  if (status !== null) parts.push(`HTTP ${status}`);
  const decision = detailString(detail.decision);
  if (decision !== null) parts.push(decision);
  const hook = detailString(detail.hook);
  if (hook !== null) parts.push(`${hook} hook`);
  const file = detailString(detail.file);
  if (file !== null) parts.push(file);
  const error = detailString(detail.error);
  if (error !== null) parts.push(error);
  const reason = detailString(detail.reason);
  if (reason !== null) parts.push(reason);
  const purpose = detailString(detail.purpose);
  if (purpose !== null) parts.push(purpose);
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * `originalId` is the id before an edit, so a rename replaces the entry. The accepted
 * definition is server-owned: it survives address or credential edits and is dropped when the
 * definition source changes, so the new file has to be reviewed.
 */
export function updateHardwareDevices(
  devices: ReadonlyArray<HardwareDeviceConfig>,
  device: HardwareDeviceConfig,
  options: { readonly originalId?: string; readonly remove?: boolean } = {},
): ReadonlyArray<HardwareDeviceConfig> {
  const originalId = options.originalId ?? device.id;
  if (options.remove) return devices.filter((candidate) => candidate.id !== originalId);
  const existing = devices.find((candidate) => candidate.id === originalId);
  if (!existing) return [...devices, device];
  const { acceptedDefinition: _ignored, ...edited } = device;
  const next: HardwareDeviceConfig =
    existing.acceptedDefinition === undefined ||
    existing.projectId !== device.projectId ||
    existing.definitionFile !== device.definitionFile
      ? edited
      : { ...edited, acceptedDefinition: existing.acceptedDefinition };
  return devices.map((candidate) => (candidate.id === originalId ? next : candidate));
}
