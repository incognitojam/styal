import { and, eq, ne, or, sql } from "drizzle-orm";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relayTunnelOperations as operations } from "./schema.ts";
import {
  TunnelOperationPersistence,
  TunnelOperationPersistenceError,
} from "./TunnelOperationPersistence.ts";

const encodeResources = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const random = yield* SecureRandom.SecureRandom;
  const mapError = (cause: unknown) => new TunnelOperationPersistenceError({ cause });
  const pending = ne(operations.phase, "complete");
  const advance = Effect.fn("relay.tunnel_operations.advance")(function* (
    operationId: string,
    phase: string,
    resources: Readonly<Record<string, string>> = {},
    expectedPhase?: string,
  ) {
    const encoded = yield* encodeResources(resources).pipe(Effect.mapError(mapError));
    const rows = yield* db
      .update(operations)
      .set({
        phase,
        resources: sql`${operations.resources} || ${encoded}::jsonb`,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      })
      .where(
        and(
          eq(operations.operationId, operationId),
          pending,
          expectedPhase === undefined ? undefined : eq(operations.phase, expectedPhase),
        ),
      )
      .returning({ id: operations.operationId })
      .pipe(Effect.mapError(mapError));
    return rows.length > 0;
  });
  return TunnelOperationPersistence.of({
    begin: Effect.fn("relay.tunnel_operations.begin")(function* (intent, expectedOperationId) {
      if (expectedOperationId !== undefined) {
        const rows = yield* db
          .update(operations)
          .set({ updatedAt: DateTime.formatIso(yield* DateTime.now) })
          .where(
            and(
              eq(operations.operationId, expectedOperationId),
              pending,
              eq(operations.desired, intent.desired),
            ),
          )
          .returning()
          .pipe(Effect.mapError(mapError));
        return rows[0] ? { ...rows[0], resumed: true } : null;
      }
      const operationId = yield* random.uuidV4();
      const rows = yield* db
        .insert(operations)
        .values({
          ...intent,
          operationId,
          phase: "intent",
          resources: {},
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        })
        .onConflictDoUpdate({
          target: [operations.userId, operations.environmentId],
          set: {
            operationId: sql`case when ${pending} then ${operations.operationId} else excluded.operation_id end`,
            hostname: sql`excluded.hostname`,
            tunnelName: sql`excluded.tunnel_name`,
            desired: sql`excluded.desired`,
            phase: sql`case when ${pending} then ${operations.phase} else 'intent' end`,
            resources: sql`case when ${pending} then ${operations.resources} else '{}'::jsonb end`,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          },
          setWhere: sql`${or(
            eq(operations.phase, "complete"),
            and(
              eq(operations.hostname, intent.hostname),
              eq(operations.tunnelName, intent.tunnelName),
              eq(operations.desired, intent.desired),
            ),
          )}`,
        })
        .returning()
        .pipe(Effect.mapError(mapError));
      return rows[0] ? { ...rows[0], resumed: rows[0].operationId !== operationId } : null;
    }),
    advance,
    complete: Effect.fn("relay.tunnel_operations.complete")((id, expectedPhase) =>
      advance(id, "complete", {}, expectedPhase),
    ),
    pending: Effect.fn("relay.tunnel_operations.pending")(function* (limit) {
      return yield* db
        .select()
        .from(operations)
        .where(pending)
        .orderBy(operations.updatedAt, operations.operationId)
        .limit(limit)
        .pipe(Effect.mapError(mapError));
    }),
  });
});

export const layer = Layer.effect(TunnelOperationPersistence, make);
