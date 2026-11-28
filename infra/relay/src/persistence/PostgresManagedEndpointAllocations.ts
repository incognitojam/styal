import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { TunnelOperationExecution } from "./TunnelOperationPersistence.ts";
import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayManagedEndpointAllocations,
  relayTunnelOperations,
} from "./schema.ts";

import { ManagedEndpointAllocationPersistenceError } from "../environments/ManagedEndpointAllocations.ts";
import type { ManagedEndpointAllocations } from "../environments/ManagedEndpointAllocations.ts";
import { ManagedEndpointAllocationPersistence } from "./TunnelPersistence.ts";

type ManagedEndpointAllocationKey = Parameters<ManagedEndpointAllocations["Service"]["get"]>[0];
type ReserveManagedEndpointAllocationInput = Parameters<
  ManagedEndpointAllocations["Service"]["reserve"]
>[0];
type RecordManagedEndpointTunnelInput = Parameters<
  ManagedEndpointAllocations["Service"]["recordTunnel"]
>[0];
type RecordManagedEndpointDnsInput = Parameters<
  ManagedEndpointAllocations["Service"]["recordDns"]
>[0];
type MarkManagedEndpointReadyInput = Parameters<
  ManagedEndpointAllocations["Service"]["markReady"]
>[0];
type ClaimManagedEndpointReleaseInput = Parameters<
  ManagedEndpointAllocations["Service"]["claimRelease"]
>[0];
type EnableManagedEndpointRecoveryInput = Parameters<
  ManagedEndpointAllocations["Service"]["enableRecovery"]
>[0];
type ClaimManagedEndpointDeprovisionInput = Parameters<
  ManagedEndpointAllocations["Service"]["claimDeprovision"]
>[0];
type RemoveClaimedManagedEndpointAllocationInput = Parameters<
  ManagedEndpointAllocations["Service"]["removeClaimed"]
>[0];

const MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE = 500;

const allocationSelection = {
  userId: relayManagedEndpointAllocations.userId,
  environmentId: relayManagedEndpointAllocations.environmentId,
  hostname: relayManagedEndpointAllocations.hostname,
  tunnelId: relayManagedEndpointAllocations.tunnelId,
  tunnelName: relayManagedEndpointAllocations.tunnelName,
  dnsRecordId: relayManagedEndpointAllocations.dnsRecordId,
  readyAt: relayManagedEndpointAllocations.readyAt,
  origin: relayManagedEndpointAllocations.origin,
  updatedAt: relayManagedEndpointAllocations.updatedAt,
  generation: relayManagedEndpointAllocations.generation,
  tunnelReleasedAt: relayManagedEndpointAllocations.tunnelReleasedAt,
};

const whereAllocation = (input: ManagedEndpointAllocationKey) =>
  and(
    eq(relayManagedEndpointAllocations.userId, input.userId),
    eq(relayManagedEndpointAllocations.environmentId, input.environmentId),
  );

export const pendingTunnelOperation = () =>
  exists(
    new QueryBuilder()
      .select({ id: relayTunnelOperations.operationId })
      .from(relayTunnelOperations)
      .where(
        and(
          eq(relayTunnelOperations.userId, relayManagedEndpointAllocations.userId),
          eq(relayTunnelOperations.environmentId, relayManagedEndpointAllocations.environmentId),
          sql`${relayTunnelOperations.phase} <> 'complete'`,
        ),
      ),
  );

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  const operationGuard = Effect.fn("relay.managed_endpoint_allocations.operation_guard")(
    function* () {
      const operation = yield* Effect.serviceOption(TunnelOperationExecution);
      if (Option.isNone(operation)) return sql`not (${pendingTunnelOperation()})`;
      return exists(
        new QueryBuilder()
          .select({ id: relayTunnelOperations.operationId })
          .from(relayTunnelOperations)
          .where(
            and(
              eq(relayTunnelOperations.userId, relayManagedEndpointAllocations.userId),
              eq(
                relayTunnelOperations.environmentId,
                relayManagedEndpointAllocations.environmentId,
              ),
              eq(relayTunnelOperations.operationId, operation.value.operationId),
              sql`${relayTunnelOperations.phase} <> 'complete'`,
            ),
          ),
      );
    },
  );
  return ManagedEndpointAllocationPersistence.of({
    get: Effect.fn("relay.managed_endpoint_allocations.get")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      return yield* db
        .select(allocationSelection)
        .from(relayManagedEndpointAllocations)
        .where(whereAllocation(input))
        .limit(1)
        .pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "get",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    getByTunnelName: Effect.fn("relay.managed_endpoint_allocations.get_by_tunnel_name")(function* (
      tunnelName: string,
    ) {
      return yield* db
        .select(allocationSelection)
        .from(relayManagedEndpointAllocations)
        .where(eq(relayManagedEndpointAllocations.tunnelName, tunnelName))
        .limit(1)
        .pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "get-by-tunnel-name",
                stage: "database-request",
                userId: "",
                environmentId: "",
                tunnelName,
                cause,
              }),
          ),
        );
    }),
    reserve: Effect.fn("relay.managed_endpoint_allocations.reserve")(function* (
      input: ReserveManagedEndpointAllocationInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const inserted = yield* db
        .insert(relayManagedEndpointAllocations)
        .values({
          ...input,
          createdAt: now,
          updatedAt: now,
        })
        // Refreshing updatedAt makes a re-reserved row count toward the tunnel limit again.
        .onConflictDoUpdate({
          target: [
            relayManagedEndpointAllocations.userId,
            relayManagedEndpointAllocations.environmentId,
          ],
          set: { updatedAt: now },
        })
        .returning(allocationSelection)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "reserve",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );

      const allocation = inserted[0];
      if (allocation === undefined) {
        return yield* new ManagedEndpointAllocationPersistenceError({
          operation: "reserve",
          stage: "resolve-reservation",
          ...input,
        });
      }

      return allocation;
    }),
    recordTunnel: Effect.fn("relay.managed_endpoint_allocations.record_tunnel")(function* (
      input: RecordManagedEndpointTunnelInput,
    ) {
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          tunnelId: input.tunnelId,
          readyAt: sql`case when ${relayManagedEndpointAllocations.tunnelId} = ${input.tunnelId} then ${relayManagedEndpointAllocations.readyAt} else null end`,
          origin: sql`case when ${relayManagedEndpointAllocations.tunnelId} = ${input.tunnelId} then ${relayManagedEndpointAllocations.origin} else null end`,
          // Replacement tunnels must re-register recovery before becoming reapable.
          recoveryEnabledAt: sql`case when ${relayManagedEndpointAllocations.tunnelId} = ${input.tunnelId} then ${relayManagedEndpointAllocations.recoveryEnabledAt} else null end`,
          recoveryEnvironmentPublicKey: sql`case when ${relayManagedEndpointAllocations.tunnelId} = ${input.tunnelId} then ${relayManagedEndpointAllocations.recoveryEnvironmentPublicKey} else null end`,
          tunnelReleasedAt: null,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            yield* operationGuard(),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "record-tunnel",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    recordDns: Effect.fn("relay.managed_endpoint_allocations.record_dns")(function* (
      input: RecordManagedEndpointDnsInput,
    ) {
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          dnsRecordId: input.dnsRecordId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            yield* operationGuard(),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "record-dns",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    markReady: Effect.fn("relay.managed_endpoint_allocations.mark_ready")(function* (
      input: MarkManagedEndpointReadyInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          readyAt: now,
          origin: input.origin,
          updatedAt: now,
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            yield* operationGuard(),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ environmentId: relayManagedEndpointAllocations.environmentId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "mark-ready",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    enableRecovery: Effect.fn("relay.managed_endpoint_allocations.enable_recovery")(function* (
      input: EnableManagedEndpointRecoveryInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          recoveryEnabledAt: now,
          recoveryEnvironmentPublicKey: input.environmentPublicKey,
          updatedAt: now,
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
        })
        .where(
          and(
            whereAllocation(input),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.origin, input.origin),
            exists(
              new QueryBuilder()
                .select({ userId: relayEnvironmentLinks.userId })
                .from(relayEnvironmentLinks)
                .where(
                  and(
                    eq(relayEnvironmentLinks.userId, input.userId),
                    eq(relayEnvironmentLinks.environmentId, input.environmentId),
                    eq(relayEnvironmentLinks.environmentPublicKey, input.environmentPublicKey),
                    eq(relayEnvironmentLinks.endpointProviderKind, "cloudflare_tunnel"),
                    isNull(relayEnvironmentLinks.revokedAt),
                  ),
                )
                .for("update"),
            ),
          ),
        )
        .returning({ environmentId: relayManagedEndpointAllocations.environmentId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "enable-recovery",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    listByTunnelNames: Effect.fn("relay.managed_endpoint_allocations.list_by_tunnel_names")(
      function* (tunnelNames: ReadonlyArray<string>) {
        if (tunnelNames.length === 0) {
          return [];
        }
        const batches = Array.from(
          { length: Math.ceil(tunnelNames.length / MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE) },
          (_, index) =>
            tunnelNames.slice(
              index * MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE,
              (index + 1) * MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE,
            ),
        );
        const results = yield* Effect.forEach(
          batches,
          (batch) =>
            db
              .select({
                ...allocationSelection,
                recoveryEnabledAt: relayManagedEndpointAllocations.recoveryEnabledAt,
                recoveryEnvironmentPublicKey:
                  relayManagedEndpointAllocations.recoveryEnvironmentPublicKey,
                linkedEnvironmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
              })
              .from(relayManagedEndpointAllocations)
              .leftJoin(
                relayEnvironmentLinks,
                and(
                  eq(relayEnvironmentLinks.userId, relayManagedEndpointAllocations.userId),
                  eq(
                    relayEnvironmentLinks.environmentId,
                    relayManagedEndpointAllocations.environmentId,
                  ),
                  isNull(relayEnvironmentLinks.revokedAt),
                ),
              )
              .where(
                and(
                  inArray(relayManagedEndpointAllocations.tunnelName, batch),
                  sql`not (${pendingTunnelOperation()})`,
                ),
              )
              .pipe(
                Effect.map((rows) =>
                  rows.map(
                    ({
                      recoveryEnabledAt,
                      recoveryEnvironmentPublicKey,
                      linkedEnvironmentPublicKey,
                      ...allocation
                    }) => ({
                      ...allocation,
                      recoveryEnabled:
                        recoveryEnabledAt !== null &&
                        recoveryEnvironmentPublicKey !== null &&
                        recoveryEnvironmentPublicKey === linkedEnvironmentPublicKey,
                    }),
                  ),
                ),
                Effect.mapError(
                  (cause) =>
                    new ManagedEndpointAllocationPersistenceError({
                      operation: "list-tunnels",
                      stage: "database-request",
                      userId: "*",
                      environmentId: "*",
                      cause,
                    }),
                ),
              ),
          { concurrency: 1 },
        );
        return results.flat();
      },
    ),
    claimRelease: Effect.fn("relay.managed_endpoint_allocations.claim_release")(function* (
      input: ClaimManagedEndpointReleaseInput,
    ) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const claimed = yield* db
        .update(relayManagedEndpointAllocations)
        .set({
          generation: sql`${relayManagedEndpointAllocations.generation} + 1`,
          ...(input.markReleased === true ? { tunnelReleasedAt: now, updatedAt: now } : {}),
        })
        .where(
          and(
            whereAllocation(input),
            yield* operationGuard(),
            eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "claim-release",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                tunnelId: input.tunnelId,
                cause,
              }),
          ),
        );
      return claimed;
    }),
    withClaimedTunnel: Effect.fn("relay.managed_endpoint_allocations.with_claimed_tunnel")(
      function* <A, E, R>(
        input: ClaimManagedEndpointReleaseInput,
        effect: Effect.Effect<A, E, R>,
      ): Effect.fn.Return<Option.Option<A>, E | ManagedEndpointAllocationPersistenceError, R> {
        const lockError = (cause: unknown) =>
          new ManagedEndpointAllocationPersistenceError({
            operation: "lock-tunnel",
            stage: "database-request",
            userId: input.userId,
            environmentId: input.environmentId,
            tunnelId: input.tunnelId,
            cause,
          });
        const rows = yield* db
          .select({ generation: relayManagedEndpointAllocations.generation })
          .from(relayManagedEndpointAllocations)
          .where(
            and(
              whereAllocation(input),
              eq(relayManagedEndpointAllocations.tunnelId, input.tunnelId),
              eq(relayManagedEndpointAllocations.generation, input.generation),
              yield* operationGuard(),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(lockError));
        return rows.length === 0 ? Option.none<A>() : yield* Effect.asSome(effect);
      },
    ),
    claimDeprovision: Effect.fn("relay.managed_endpoint_allocations.claim_deprovision")(function* (
      input: ClaimManagedEndpointDeprovisionInput,
    ) {
      const claimed = yield* db
        .update(relayManagedEndpointAllocations)
        // Claims move only the generation: the tunnel limit reads updatedAt as the last provisioning write.
        .set({ generation: sql`${relayManagedEndpointAllocations.generation} + 1` })
        .where(
          and(
            whereAllocation(input),
            yield* operationGuard(),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ generation: relayManagedEndpointAllocations.generation })
        .pipe(
          Effect.map((rows) => rows[0]?.generation ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "claim-deprovision",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      return claimed;
    }),
    removeClaimed: Effect.fn("relay.managed_endpoint_allocations.remove_claimed")(function* (
      input: RemoveClaimedManagedEndpointAllocationInput,
    ) {
      return yield* db
        .delete(relayManagedEndpointAllocations)
        .where(
          and(
            whereAllocation(input),
            yield* operationGuard(),
            eq(relayManagedEndpointAllocations.generation, input.generation),
          ),
        )
        .returning({ userId: relayManagedEndpointAllocations.userId })
        .pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "remove-claimed",
                stage: "database-request",
                userId: input.userId,
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointAllocationPersistence, make);
