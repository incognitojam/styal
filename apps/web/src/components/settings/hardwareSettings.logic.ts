import {
  type HardwareDefinitionChange,
  HardwareDeviceConfig,
  type HardwareDeviceState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The editable fields of a device, as typed. */
export interface HardwareDeviceDraft {
  readonly id: string;
  readonly projectId: string;
  readonly definitionFile: string;
  readonly baseUrl: string;
  readonly authHeader: string;
  readonly authScheme: string;
}

export type HardwareDeviceDraftField = "id" | "projectId" | "definitionFile" | "baseUrl" | "auth";

export const EMPTY_HARDWARE_DEVICE_DRAFT: HardwareDeviceDraft = {
  id: "",
  projectId: "",
  definitionFile: "",
  baseUrl: "",
  authHeader: "",
  authScheme: "",
};

export function hardwareDeviceDraftFromConfig(device: HardwareDeviceConfig): HardwareDeviceDraft {
  return {
    id: device.id,
    projectId: device.projectId,
    definitionFile: device.definitionFile,
    baseUrl: device.baseUrl,
    authHeader: device.auth?.header ?? "",
    authScheme: device.auth?.scheme ?? "",
  };
}

const validateConfig = Schema.toStandardSchemaV1(HardwareDeviceConfig)["~standard"].validate;

const FIELD_MESSAGES: Readonly<Record<Exclude<HardwareDeviceDraftField, "baseUrl">, string>> = {
  id: "Use lowercase letters, digits, - and _, starting with a letter or digit.",
  projectId: "Choose the project whose repository holds the definition.",
  definitionFile: "Use a .json file name such as tree.json.",
  auth: "Header and scheme cannot be blank.",
};

const fieldOf = (key: PropertyKey | undefined): HardwareDeviceDraftField | null =>
  key === "id" || key === "projectId" || key === "definitionFile" || key === "baseUrl"
    ? key
    : key === "auth"
      ? "auth"
      : null;

/**
 * Decode a draft against the settings schema. Returns the config to save, or
 * one message per field that fails. `takenIds` are other devices' ids on the
 * same environment.
 */
export function parseHardwareDeviceDraft(
  draft: HardwareDeviceDraft,
  takenIds: ReadonlyArray<string>,
):
  | { readonly ok: true; readonly device: HardwareDeviceConfig }
  | {
      readonly ok: false;
      readonly errors: Partial<Record<HardwareDeviceDraftField, string>>;
    } {
  const header = draft.authHeader.trim();
  const scheme = draft.authScheme.trim();
  const candidate = {
    id: draft.id.trim(),
    projectId: draft.projectId,
    definitionFile: draft.definitionFile.trim(),
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
    ...(header || scheme
      ? { auth: { ...(header ? { header } : {}), ...(scheme ? { scheme } : {}) } }
      : {}),
  };
  const errors: Partial<Record<HardwareDeviceDraftField, string>> = {};
  if (takenIds.includes(candidate.id)) errors.id = "Another device already uses this id.";
  const result = validateConfig(candidate);
  if (result instanceof Promise)
    throw new Error("Hardware device schema must decode synchronously.");
  if (result.issues) {
    for (const issue of result.issues) {
      const first = issue.path?.[0];
      const field = fieldOf(typeof first === "object" && first !== null ? first.key : first);
      if (field === null || errors[field] !== undefined) continue;
      errors[field] = field === "baseUrl" ? baseUrlMessage(issue.message) : FIELD_MESSAGES[field];
    }
  }
  if (Object.keys(errors).length > 0 || result.issues) return { ok: false, errors };
  return { ok: true, device: result.value };
}

/** The schema's own messages for the address are already written for people. */
const baseUrlMessage = (message: string) =>
  message.startsWith("Use ") || message.startsWith("Invalid ")
    ? message
    : "Enter an http(s) address such as http://tree.local.";

const CHANGE_KIND_LABELS: Readonly<Record<HardwareDefinitionChange["kind"], string>> = {
  added: "new",
  loosened: "looser",
  "hooks-changed": "hooks changed",
  other: "changed",
};

/** "calibrate.start: looser, approve → operate". */
export function hardwareDefinitionChangeLabel(change: HardwareDefinitionChange): string {
  const transition =
    change.from !== undefined && change.to !== undefined
      ? `, ${change.from} → ${change.to}`
      : change.to !== undefined
        ? `, ${change.to}`
        : "";
  return `${change.action}: ${CHANGE_KIND_LABELS[change.kind]}${transition}`;
}

/** One line under the device name: what the health probe last saw. */
export function hardwareHealthLine(
  health: HardwareDeviceState["health"],
  formatAgo: (iso: string) => string,
): string {
  if (health.status === "online") return health.summary ?? "Online";
  if (health.status === "offline") {
    const seen = health.lastSeenAt ? `, last seen ${formatAgo(health.lastSeenAt)}` : "";
    return `Offline${seen}${health.error ? `: ${health.error}` : ""}`;
  }
  return health.checkedAt === null ? "Not checked yet" : "Status unknown";
}
