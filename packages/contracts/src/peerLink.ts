import * as Schema from "effect/Schema";

import { AuthMcpClientAccess } from "./auth.ts";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/** The `/mcp` refusal from a machine whose `incomingMachineAccess` is `nothing`. */
export const MACHINE_ACCEPTS_NOTHING = "machine_accepts_nothing";

/** Threads other machines started here that are running now. */
export const PeerIncomingWork = Schema.Struct({ threads: Schema.Number });
export type PeerIncomingWork = typeof PeerIncomingWork.Type;

/**
 * A link from this environment to another one (the peer), signed in to its `/mcp` as an
 * outside agent with a pairing code from it. The peer enforces the lower of the access
 * stored here and its own `incomingMachineAccess`, and revokes the link from its Connections.
 */
export const PeerLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Addresses the peer was linked at, tried in order. */
  urls: Schema.Array(TrimmedNonEmptyString),
  access: AuthMcpClientAccess,
  linkedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastReachedAt: Schema.NullOr(Schema.DateTimeUtc),
  lastError: Schema.NullOr(Schema.String),
});
export type PeerLink = typeof PeerLink.Type;

/** Whether a link can be used now, as worked out when it is listed. */
export const PeerLinkStatus = Schema.Literals(["reachable", "unreachable", "expired"]);
export type PeerLinkStatus = typeof PeerLinkStatus.Type;

export const PeerLinkSummary = Schema.Struct({
  ...PeerLink.fields,
  status: PeerLinkStatus,
});
export type PeerLinkSummary = typeof PeerLinkSummary.Type;

export const PeerLinkCreateInput = Schema.Struct({
  /** Where the peer answers: an https, Tailscale, LAN or loopback base URL. */
  url: TrimmedNonEmptyString,
  /** More addresses for the same peer, tried after `url`. */
  alternateUrls: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** A pairing code from the peer (`t3 pair` there, or its Connections settings). */
  pairingCode: TrimmedNonEmptyString,
  access: AuthMcpClientAccess,
  /**
   * The environment the user means. Addresses that answer as another one are
   * skipped, and only those that answer as this one are kept.
   */
  expectedEnvironmentId: Schema.optionalKey(EnvironmentId),
  /** What the user calls that environment, to name it when it cannot be reached. */
  expectedLabel: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PeerLinkCreateInput = typeof PeerLinkCreateInput.Type;

export const PeerLinkRemoveInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkRemoveInput = typeof PeerLinkRemoveInput.Type;

export const PeerLinkRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export type PeerLinkRemoveResult = typeof PeerLinkRemoveResult.Type;

/** Why linking or calling a peer failed, in words a user can act on. */
export class PeerLinkError extends Schema.TaggedError<PeerLinkError>()("PeerLinkError", {
  reason: Schema.Literals([
    "unreachable",
    "not_a_t3_environment",
    "incompatible",
    "self",
    "pairing_rejected",
    "expired",
    "unknown_link",
    "storage",
    "disabled",
  ]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * The user's answer to an agent asking to link an environment. The pairing
 * code is used once to link and is never recorded; the thread learns only the
 * outcome and the access the user chose.
 */
export const PeerLinkRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("link"),
      /** The machine the user picked, when they picked one rather than typing an address. */
      environmentId: Schema.optionalKey(EnvironmentId),
      /** What the client calls that machine. */
      label: Schema.optionalKey(TrimmedNonEmptyString),
      /** The addresses the client knows for that machine, most preferred first. */
      urls: Schema.NonEmptyArray(TrimmedNonEmptyString),
      access: AuthMcpClientAccess,
      pairingCode: TrimmedNonEmptyString,
    }),
    /** Answers with a machine this environment is already linked to, as it is. */
    Schema.Struct({ type: Schema.Literal("use-existing"), environmentId: EnvironmentId }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type PeerLinkRequestAnswerInput = typeof PeerLinkRequestAnswerInput.Type;

const PEER_LINK_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the link request.",
  not_found: "This link request no longer exists.",
  already_answered: "This link request was already answered.",
  record_failed: "Could not update the link request.",
} as const;

export const PeerLinkRequestFailureReason = Schema.Literals(
  Object.keys(PEER_LINK_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof PEER_LINK_REQUEST_FAILURE_MESSAGES
  >,
);
export type PeerLinkRequestFailureReason = typeof PeerLinkRequestFailureReason.Type;

/**
 * Answering a link request failed before anything was linked. A link the
 * other environment refused is not this error: the card records it as failed.
 */
export class PeerLinkRequestError extends Schema.TaggedError<PeerLinkRequestError>()(
  "PeerLinkRequestError",
  {
    reason: PeerLinkRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return PEER_LINK_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
