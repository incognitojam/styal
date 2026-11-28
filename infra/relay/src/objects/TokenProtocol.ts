import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { canonicalJson } from "./storage.ts";

export type TokenKind = "push" | "push-to-start" | "live-activity";
export interface TokenReference {
  kind: TokenKind;
  token: string;
  userId: string;
  deviceId: string;
  sessionId: string | null;
  operationId: string;
  generation: number;
  incarnation?: string;
}
export interface TokenPreparation {
  reference: TokenReference;
  expected: number;
  initialization: string | null;
  epoch: number | null;
  admittedAt: string;
}
export interface SuccessfulTokenClaim {
  digest: string;
  incarnation: string;
  epoch: number;
  generation: number;
}
export interface TokenRetirement {
  incarnation: string;
  epoch: number;
  generation: number;
  id: string;
  lastClaim: SuccessfulTokenClaim | null;
  expiresAt: string;
  admissionExpiresAt: string;
}
export const normalizedTokenReference = (reference: TokenReference) => ({
  ...reference,
  incarnation: reference.incarnation ?? "legacy",
});
export const registrationDigest = (value: unknown) =>
  "sha256:" + bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
export const tokenClaimDigest = (reference: TokenReference) =>
  registrationDigest(normalizedTokenReference(reference));
export const tokenPreparationDigest = (reference: TokenReference, expected: number) =>
  registrationDigest({ reference: normalizedTokenReference(reference), expected });

export type TokenInventoryCommand =
  | { kind: "ticket"; name: string; incarnation: string; admittedAt: string }
  | { kind: "activate"; name: string; incarnation: string; epoch: number }
  | { kind: "cancel-ticket"; name: string; incarnation: string; expiresAt: string }
  | { kind: "retire"; name: string; retirement: TokenRetirement }
  | { kind: "complete"; name: string; incarnation: string; epoch: number; id: string }
  | { kind: "read"; name: string; incarnation?: string }
  | { kind: "prune"; expiresBefore: string; admissionBefore: string };
