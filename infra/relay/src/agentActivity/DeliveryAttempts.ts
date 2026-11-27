import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { DeliveryAttemptPersistence } from "../persistence/DeliveryPersistence.ts";

export class DeliveryAttemptRecordPersistenceError extends Schema.TaggedError<DeliveryAttemptRecordPersistenceError>()(
  "DeliveryAttemptRecordPersistenceError",
  {
    operation: Schema.Literals(["claim-source-job", "complete-source-job", "prune-expired"]),
    sourceJobId: Schema.NullOr(Schema.String),
    userId: Schema.NullOr(Schema.String),
    environmentId: Schema.NullOr(Schema.String),
    threadId: Schema.NullOr(Schema.String),
    deviceId: Schema.NullOr(Schema.String),
    kind: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist APNs delivery attempt during ${this.operation}.`;
  }
}

export interface DeliveryAttemptInput {
  readonly userId: string | null;
  readonly environmentId: string | null;
  readonly threadId: string | null;
  readonly deviceId: string | null;
  readonly kind: string;
  readonly sourceJobId?: string | null;
  readonly token: string | null;
  readonly apnsStatus?: number;
  readonly apnsReason?: string;
  readonly apnsId?: string | null;
  readonly transportError?: string;
}

export interface DeliveryAttemptCompletionInput {
  readonly sourceJobId: string;
  readonly apnsStatus?: number;
  readonly apnsReason?: string;
  readonly apnsId?: string | null;
  readonly transportError?: string;
}

export type DeliverySourceJobClaimResult = "claimed" | "completed" | "in_flight";

export class DeliveryAttempts extends Context.Service<
  DeliveryAttempts,
  {
    readonly claimSourceJob: (
      input: DeliveryAttemptInput & { readonly sourceJobId: string },
    ) => Effect.Effect<DeliverySourceJobClaimResult, DeliveryAttemptRecordPersistenceError>;
    readonly completeSourceJob: (
      input: DeliveryAttemptCompletionInput,
    ) => Effect.Effect<void, DeliveryAttemptRecordPersistenceError>;
    /** Delete attempts untouched for the retention period; returns how many were removed. */
    readonly pruneExpired: Effect.Effect<number, DeliveryAttemptRecordPersistenceError>;
  }
>()("t3code-relay/agentActivity/DeliveryAttempts") {}

export const DELIVERY_ATTEMPT_RETENTION_DAYS = 7;
export const DELIVERY_ATTEMPT_PRUNE_BATCH_SIZE = 5_000;
// Caps each cron run so draining the pre-retention backlog cannot monopolize the database.
export const DELIVERY_ATTEMPT_PRUNE_MAX_BATCHES = 4;

export const layer = Layer.effect(
  DeliveryAttempts,
  Effect.map(DeliveryAttemptPersistence, (store) => DeliveryAttempts.of(store)),
);
