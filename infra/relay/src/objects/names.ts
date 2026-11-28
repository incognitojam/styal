import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export type ObjectKind =
  | "allocation-route"
  | "account"
  | "email"
  | "environment"
  | "push-token"
  | "credential-route"
  | "replay"
  | "api-pause"
  | "delivery-attempt"
  | "inventory";

const tuple = (kind: ObjectKind, parts: readonly string[]) =>
  utf8ToBytes(JSON.stringify(["relay-object", 1, kind, ...parts]));
const name = (kind: ObjectKind, ...parts: string[]) =>
  `${kind}:v1:${bytesToHex(sha256(tuple(kind, parts)))}`;

export const allocationRouteName = (kind: "hostname" | "tunnel", value: string) =>
  name("allocation-route", kind, value);
export const accountName = (accountId: string) => name("account", accountId);
export const environmentName = (environmentId: string) => name("environment", environmentId);
export const emailName = (normalizedEmail: string, key: Uint8Array) => {
  if (key.length < 32) throw new Error("Email routing requires a stable key of at least 32 bytes");
  return `email:v1:${bytesToHex(hmac(sha256, key, tuple("email", [normalizedEmail])))}`;
};
export const pushTokenName = (kind: "push" | "push-to-start" | "live-activity", token: string) =>
  name("push-token", kind, token);
export const credentialRouteName = (kind: "session" | "machine", identity: string) =>
  name("credential-route", kind, identity);
export const replayName = (identity: string, jti: string) =>
  name(
    "replay",
    identity,
    identity === "relay-environment-link-challenge"
      ? bytesToHex(sha256(utf8ToBytes(jti))).slice(0, 2)
      : "",
  );
export const apiPauseName = (api: string) => name("api-pause", api);
export const deliveryAttemptName = (kind: "source-job" | "attempt", id: string) =>
  name("delivery-attempt", kind, id);
export const inventoryShardName = (kind: ObjectKind, objectName: string) =>
  `inventory:v1:${bytesToHex(sha256(tuple(kind, [objectName]))).slice(0, 1)}`;
export const inventoryShardNames = Array.from(
  { length: 16 },
  (_, i) => `inventory:v1:${i.toString(16)}`,
);
