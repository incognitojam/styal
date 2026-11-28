import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as RelayDb from "../db.ts";
import { relayDeliveryAttempts } from "./schema.ts";

import {
  DeliveryAttemptRecordPersistenceError,
  DELIVERY_ATTEMPT_RETENTION_DAYS,
  DELIVERY_ATTEMPT_PRUNE_BATCH_SIZE,
  DELIVERY_ATTEMPT_PRUNE_MAX_BATCHES,
  type DeliveryAttemptInput,
} from "../agentActivity/DeliveryAttempts.ts";
import { DeliveryAttemptPersistence } from "./DeliveryPersistence.ts";

const SOURCE_JOB_CLAIM_LEASE_MINUTES = 10;

function insertValues(
  input: DeliveryAttemptInput,
  id: string,
  createdAt: string,
): typeof relayDeliveryAttempts.$inferInsert {
  return {
    id,
    createdAt,
    userId: input.userId,
    environmentId: input.environmentId,
    threadId: input.threadId,
    deviceId: input.deviceId,
    kind: input.kind,
    sourceJobId: input.sourceJobId ?? null,
    tokenSuffix: input.token?.slice(-8) ?? null,
    apnsStatus: input.apnsStatus ?? null,
    apnsReason: input.apnsReason ?? null,
    apnsId: input.apnsId ?? null,
    transportError: input.transportError ?? null,
  };
}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const random = yield* SecureRandom.SecureRandom;

  const isExpiredClaim = (claimedAt: string | null, now: DateTime.DateTime) => {
    if (claimedAt === null) {
      return true;
    }
    return Option.match(DateTime.make(claimedAt), {
      onNone: () => true,
      onSome: (dateTime) =>
        now.epochMilliseconds - dateTime.epochMilliseconds >=
        SOURCE_JOB_CLAIM_LEASE_MINUTES * 60 * 1_000,
    });
  };

  return DeliveryAttemptPersistence.of({
    claimSourceJob: Effect.fn("relay.delivery_attempts.claim_source_job")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.delivery.kind": input.kind,
        "relay.delivery.job_id": input.sourceJobId,
        ...(input.deviceId ? { "relay.mobile.device_id": input.deviceId } : {}),
        ...(input.environmentId ? { "relay.environment_id": input.environmentId } : {}),
        ...(input.threadId ? { "relay.thread_id": input.threadId } : {}),
      });
      return yield* Effect.gen(function* () {
        const id = yield* random.uuidV4();
        const now = yield* DateTime.now;
        const createdAt = DateTime.formatIso(now);
        const inserted = yield* db
          .insert(relayDeliveryAttempts)
          .values(insertValues(input, id, createdAt))
          .onConflictDoNothing({ target: relayDeliveryAttempts.sourceJobId })
          .returning({ id: relayDeliveryAttempts.id });
        if (inserted.length > 0) {
          return "claimed";
        }

        const existing = yield* db
          .select({
            createdAt: relayDeliveryAttempts.createdAt,
            apnsStatus: relayDeliveryAttempts.apnsStatus,
            apnsReason: relayDeliveryAttempts.apnsReason,
            apnsId: relayDeliveryAttempts.apnsId,
            transportError: relayDeliveryAttempts.transportError,
          })
          .from(relayDeliveryAttempts)
          .where(eq(relayDeliveryAttempts.sourceJobId, input.sourceJobId))
          .limit(1);
        const row = existing[0];
        if (!row) {
          return "in_flight";
        }
        if (
          row.apnsStatus !== null ||
          row.apnsReason !== null ||
          row.apnsId !== null ||
          row.transportError !== null
        ) {
          return "completed";
        }
        if (!isExpiredClaim(row.createdAt, now)) {
          return "in_flight";
        }

        const reclaimed = yield* db
          .update(relayDeliveryAttempts)
          .set({
            createdAt,
          })
          .where(
            and(
              eq(relayDeliveryAttempts.sourceJobId, input.sourceJobId),
              eq(relayDeliveryAttempts.createdAt, row.createdAt),
              isNull(relayDeliveryAttempts.apnsStatus),
              isNull(relayDeliveryAttempts.apnsReason),
              isNull(relayDeliveryAttempts.apnsId),
              isNull(relayDeliveryAttempts.transportError),
            ),
          )
          .returning({ id: relayDeliveryAttempts.id });
        return reclaimed.length > 0 ? "claimed" : "in_flight";
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DeliveryAttemptRecordPersistenceError({
              operation: "claim-source-job",
              sourceJobId: input.sourceJobId,
              userId: input.userId,
              environmentId: input.environmentId,
              threadId: input.threadId,
              deviceId: input.deviceId,
              kind: input.kind,
              cause,
            }),
        ),
      );
    }),
    completeSourceJob: Effect.fn("relay.delivery_attempts.complete_source_job")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.delivery.job_id": input.sourceJobId });
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .update(relayDeliveryAttempts)
        .set({
          createdAt: completedAt,
          apnsStatus: input.apnsStatus ?? null,
          apnsReason: input.apnsReason ?? null,
          apnsId: input.apnsId ?? null,
          transportError: input.transportError ?? null,
        })
        .where(eq(relayDeliveryAttempts.sourceJobId, input.sourceJobId))
        .pipe(
          Effect.mapError(
            (cause) =>
              new DeliveryAttemptRecordPersistenceError({
                operation: "complete-source-job",
                sourceJobId: input.sourceJobId,
                userId: null,
                environmentId: null,
                threadId: null,
                deviceId: null,
                kind: null,
                cause,
              }),
          ),
        );
    }),
    pruneExpired: Effect.gen(function* () {
      const before = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { days: DELIVERY_ATTEMPT_RETENTION_DAYS }),
      );
      yield* Effect.annotateCurrentSpan({ "relay.delivery_attempts_prune.before": before });
      let deleted = 0;
      for (let batch = 0; batch < DELIVERY_ATTEMPT_PRUNE_MAX_BATCHES; batch += 1) {
        const rows = yield* db
          .delete(relayDeliveryAttempts)
          .where(
            inArray(
              relayDeliveryAttempts.id,
              // The Worker's db is a proxy whose builders render as nothing inside another query.
              new QueryBuilder()
                .select({ id: relayDeliveryAttempts.id })
                .from(relayDeliveryAttempts)
                .where(lt(relayDeliveryAttempts.createdAt, before))
                .limit(DELIVERY_ATTEMPT_PRUNE_BATCH_SIZE),
            ),
          )
          .returning({ id: relayDeliveryAttempts.id });
        deleted += rows.length;
        if (rows.length < DELIVERY_ATTEMPT_PRUNE_BATCH_SIZE) break;
      }
      yield* Effect.annotateCurrentSpan({ "relay.delivery_attempts_prune.deleted": deleted });
      return deleted;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DeliveryAttemptRecordPersistenceError({
            operation: "prune-expired",
            sourceJobId: null,
            userId: null,
            environmentId: null,
            threadId: null,
            deviceId: null,
            kind: null,
            cause,
          }),
      ),
      Effect.withSpan("relay.delivery_attempts.prune_expired"),
    ),
  });
});

export const layer = Layer.effect(DeliveryAttemptPersistence, make);
