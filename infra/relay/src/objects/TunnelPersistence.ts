import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { DEFAULT_MANAGED_TUNNEL_LIMIT, T3CHAT_PLAN_TUNNEL_LIMITS } from "@t3tools/contracts/relay";
import { ManagedEndpointAllocationPersistenceError } from "../environments/ManagedEndpointAllocations.ts";
import type { ManagedEndpointAllocation } from "../environments/ManagedEndpointAllocations.ts";
import {
  ManagedTunnelLimitExceeded,
  ManagedTunnelLimitPersistenceError,
} from "../environments/ManagedTunnelLimits.ts";
import {
  ManagedEndpointAllocationPersistence,
  ManagedTunnelLimitPersistence,
} from "../persistence/TunnelPersistence.ts";
import { TunnelOperationExecution } from "../persistence/TunnelOperationPersistence.ts";
import { T3ChatAccounts } from "../t3chat/T3ChatAccounts.ts";
import { AccountReservation } from "./AccountReservation.ts";
import { allocationTransition, pending, publicAllocation, recovery } from "./AccountTunnels.ts";
import type { AllocationCommand, TunnelSnapshot, StoredAllocation } from "./AccountTunnels.ts";
import type { AllocationRouteObject } from "./AllocationRouteObject.ts";
import type { ObjectBindings } from "./TunnelOperations.ts";
import { accountName, allocationRouteName, inventoryShardName } from "./names.ts";
import { RPC_VERSION as version } from "./storage.ts";

export interface TunnelBindings extends ObjectBindings {
  ALLOCATION_ROUTES: DurableObjectNamespace<AllocationRouteObject>;
}
export function tunnelPersistenceLayer(bindings: TunnelBindings) {
  return Layer.effectContext(
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const t3Chat = yield* T3ChatAccounts;
      const account = (id: string) => bindings.ACCOUNTS.getByName(accountName(id));
      const route = (kind: "hostname" | "tunnel", value: string) =>
        bindings.ALLOCATION_ROUTES.getByName(allocationRouteName(kind, value));
      const register = async (kind: "account" | "allocation-route", name: string) => {
        await bindings.INVENTORY.getByName(inventoryShardName(kind, name)).register({
          version,
          references: [{ kind, name }],
        });
      };
      const call = <A>(
        operation: ManagedEndpointAllocationPersistenceError["operation"],
        input: { userId: string; environmentId: string },
        body: () => Promise<A>,
      ) =>
        Effect.tryPromise({
          try: body,
          catch: (cause) =>
            new ManagedEndpointAllocationPersistenceError({
              operation,
              stage: "database-request",
              ...input,
              cause,
            }),
        });
      const snapshot = Effect.fn("relay.object_allocations.snapshot")(function* (userId: string) {
        const transaction = yield* Effect.serviceOption(AccountReservation);
        if (Option.isSome(transaction)) {
          if (transaction.value.userId !== userId) throw new Error("Reservation account mismatch");
          return transaction.value.state;
        }
        return yield* call(
          "get",
          { userId, environmentId: "" },
          async () => await account(userId).tunnels({ version, userId }),
        );
      });
      const command = Effect.fn("relay.object_allocations.command")(function* (
        userId: string,
        c: AllocationCommand,
        operation: ManagedEndpointAllocationPersistenceError["operation"],
      ) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const executor = yield* Effect.serviceOption(TunnelOperationExecution);
        const operationId = Option.getOrUndefined(Option.map(executor, (e) => e.operationId));
        const transaction = yield* Effect.serviceOption(AccountReservation);
        if (Option.isSome(transaction)) {
          if (transaction.value.userId !== userId) throw new Error("Reservation account mismatch");
          if (
            [
              "record-tunnel",
              "record-dns",
              "mark-ready",
              "claim-release",
              "claim-deprovision",
              "remove-claimed",
              "claimed",
            ].includes(c.kind)
          )
            transaction.value.state.guardedEnvironments.push(c.environmentId);
          return allocationTransition(
            transaction.value.state,
            userId,
            c.kind === "reserve"
              ? { ...c, reservationGeneration: transaction.value.reservationGeneration }
              : c,
            now,
            operationId,
          );
        }
        return yield* call(operation, { userId, environmentId: c.environmentId }, async () => {
          if (c.kind !== "get" && c.kind !== "claimed")
            await register("account", accountName(userId));
          return await account(userId).allocation({
            version,
            userId,
            command: c,
            now,
            ...(operationId === undefined ? {} : { operationId }),
          });
        });
      });
      const releaseNames = async (row: StoredAllocation) => {
        const claims = row.nameClaims ?? row.partialNameClaims;
        if (!claims) return;
        const owner = { userId: row.userId, environmentId: row.environmentId };
        if (claims.hostname !== undefined)
          await route("hostname", row.hostname).release({ version, owner, epoch: claims.hostname });
        if (claims.tunnel !== undefined)
          await route("tunnel", row.tunnelName).release({ version, owner, epoch: claims.tunnel });
      };
      const getByName = Effect.fn("relay.object_allocations.get_by_name")(function* (
        tunnelName: string,
      ) {
        const located = yield* call(
          "get-by-tunnel-name",
          { userId: "", environmentId: "" },
          async () => await route("tunnel", tunnelName).resolve({ version }),
        );
        if (!located) return null;
        const transaction = yield* Effect.serviceOption(AccountReservation);
        if (Option.isSome(transaction)) {
          if (transaction.value.userId !== located.owner.userId)
            throw new Error("Reservation account mismatch");
          const state = transaction.value.state;
          const row = state.allocations.find(
            (a) =>
              a.environmentId === located.owner.environmentId &&
              a.tunnelName === tunnelName &&
              a.nameClaims?.tunnel === located.epoch,
          );
          return row
            ? {
                allocation: publicAllocation(row),
                pending: pending(state, row.environmentId),
                recoveryEnabled: recovery(row, state),
              }
            : null;
        }
        return yield* call(
          "get-by-tunnel-name",
          located.owner,
          async () =>
            await account(located.owner.userId).tunnelLookup({
              version,
              ...located.owner,
              tunnelName,
              epoch: located.epoch,
            }),
        );
      });
      const allocations = ManagedEndpointAllocationPersistence.of({
        get: Effect.fn("relay.object_allocations.get")(function* (input) {
          return (yield* command(
            input.userId,
            { kind: "get", environmentId: input.environmentId },
            "get",
          )).allocation;
        }),
        getByTunnelName: Effect.fn("relay.object_allocations.get_by_tunnel_name")(function* (name) {
          const found = yield* getByName(name);
          return found?.allocation ?? null;
        }),
        reserve: Effect.fn("relay.object_allocations.reserve")(function* (input) {
          const reservationId = yield* random.uuidV4();
          const result = yield* command(
            input.userId,
            { ...input, kind: "reserve", reservationId },
            "reserve",
          );
          const value = result.allocation;
          if (!value)
            return yield* new ManagedEndpointAllocationPersistenceError({
              operation: "reserve",
              stage: "resolve-reservation",
              ...input,
            });
          const state = yield* snapshot(input.userId);
          const stored = state.allocations.find((a) => a.environmentId === input.environmentId)!;
          const transaction = yield* Effect.serviceOption(AccountReservation);
          if (Option.isSome(transaction))
            yield* call("reserve", input, async () => await transaction.value.record([stored]));
          const owner = { userId: input.userId, environmentId: input.environmentId };
          const claim = Effect.fn("relay.object_allocations.claim_name")(function* (
            kind: "hostname" | "tunnel",
            name: string,
          ) {
            const epoch = yield* call("reserve", input, async () => {
              await register("allocation-route", allocationRouteName(kind, name));
              return await route(kind, name).claim({
                version,
                owner,
                generation: stored.nameGeneration!,
                ...(stored.nameClaims ? { epoch: stored.nameClaims[kind] } : {}),
              });
            });
            stored.partialNameClaims = { ...stored.partialNameClaims, [kind]: epoch };
            yield* command(
              input.userId,
              {
                kind: "record-partial-names",
                environmentId: input.environmentId,
                reservationId,
                partialNameClaims: stored.partialNameClaims,
              },
              "reserve",
            );
            if (Option.isSome(transaction))
              yield* call("reserve", input, async () => await transaction.value.record([stored]));
            return epoch;
          });
          const nameClaims = {
            hostname: yield* claim("hostname", value.hostname),
            tunnel: yield* claim("tunnel", value.tunnelName),
          };
          const confirmed = yield* command(
            input.userId,
            {
              kind: "confirm-names",
              environmentId: input.environmentId,
              reservationId,
              nameClaims,
            },
            "reserve",
          );
          if (!confirmed.applied)
            return yield* new ManagedEndpointAllocationPersistenceError({
              operation: "reserve",
              stage: "resolve-reservation",
              ...input,
            });
          if (Option.isSome(transaction))
            yield* call("reserve", input, async () => await transaction.value.record([stored]));
          return value;
        }),
        recordTunnel: Effect.fn("relay.object_allocations.record_tunnel")(function* (i) {
          return (yield* command(i.userId, { ...i, kind: "record-tunnel" }, "record-tunnel"))
            .generation;
        }),
        recordDns: Effect.fn("relay.object_allocations.record_dns")(function* (i) {
          return (yield* command(i.userId, { ...i, kind: "record-dns" }, "record-dns")).generation;
        }),
        markReady: Effect.fn("relay.object_allocations.mark_ready")(function* (i) {
          return (yield* command(i.userId, { ...i, kind: "mark-ready" }, "mark-ready")).applied;
        }),
        enableRecovery: Effect.fn("relay.object_allocations.enable_recovery")(function* (i) {
          return (yield* command(i.userId, { ...i, kind: "enable-recovery" }, "enable-recovery"))
            .applied;
        }),
        claimRelease: Effect.fn("relay.object_allocations.claim_release")(function* (i) {
          return (yield* command(i.userId, { ...i, kind: "claim-release" }, "claim-release"))
            .generation;
        }),
        claimDeprovision: Effect.fn("relay.object_allocations.claim_deprovision")(function* (i) {
          return (yield* command(
            i.userId,
            { ...i, kind: "claim-deprovision" },
            "claim-deprovision",
          )).generation;
        }),
        removeClaimed: Effect.fn("relay.object_allocations.remove_claimed")(function* (i) {
          const result = yield* command(
            i.userId,
            { ...i, kind: "remove-claimed" },
            "remove-claimed",
          );
          const state = yield* snapshot(i.userId);
          for (const old of state.releases.filter((r) => r.environmentId === i.environmentId)) {
            yield* call("remove-claimed", i, async () => await releaseNames(old));
            yield* command(
              i.userId,
              {
                kind: "confirm-release",
                environmentId: i.environmentId,
                reservationId: old.nameOperationId!,
              },
              "remove-claimed",
            );
          }
          return result.applied;
        }),
        withClaimedTunnel: Effect.fn("relay.object_allocations.with_claimed_tunnel")(function* <
          A,
          E,
          R,
        >(
          i: { userId: string; environmentId: string; tunnelId: string; generation: number },
          effect: Effect.Effect<A, E, R>,
        ) {
          const result = yield* command(i.userId, { ...i, kind: "claimed" }, "lock-tunnel");
          return result.applied ? yield* Effect.asSome(effect) : Option.none<A>();
        }),
        listByTunnelNames: Effect.fn("relay.object_allocations.list_by_tunnel_names")(
          function* (names) {
            const rows: (ManagedEndpointAllocation & { recoveryEnabled: boolean })[] = [];
            for (const name of new Set(names)) {
              const found = yield* getByName(name);
              if (found && !found.pending)
                rows.push({ ...found.allocation, recoveryEnabled: found.recoveryEnabled });
            }
            return rows;
          },
        ),
      });
      const limits = ManagedTunnelLimitPersistence.of({
        getOverride: Effect.fn("relay.object_limits.get_override")(function* (i) {
          return yield* snapshot(i.userId).pipe(
            Effect.map((s) => s.override),
            Effect.mapError(
              (cause) =>
                new ManagedTunnelLimitPersistenceError({
                  operation: "load-limit",
                  userId: i.userId,
                  cause,
                }),
            ),
          );
        }),
        withCapacity: Effect.fn("relay.object_limits.with_capacity")(function* <A, E, R>(
          input: { userId: string; environmentId: string },
          reserve: Effect.Effect<A, E, R>,
        ) {
          const context = yield* Effect.context<R>();
          const now = yield* DateTime.now;
          const cutoff = DateTime.formatIso(DateTime.subtract(now, { minutes: 15 }));
          let outcome: Exit.Exit<A, E | ManagedTunnelLimitExceeded> | undefined;
          const token = yield* random.uuidV4();
          const invoke = (raisedLimit?: number) =>
            Effect.tryPromise({
              try: async (signal) => {
                await register("account", accountName(input.userId));
                const controller = new AbortController();
                const cancel = () => controller.abort();
                signal.addEventListener("abort", cancel, { once: true });
                if (signal.aborted) cancel();
                let running: Promise<TunnelSnapshot | null> | undefined;
                try {
                  return await account(input.userId).capacity(
                    {
                      version,
                      ...input,
                      token,
                      pendingCutoff: cutoff,
                      ...(raisedLimit === undefined ? {} : { raisedLimit }),
                    },
                    (state, record, reservationGeneration) => {
                      running = (async () => {
                        const before = structuredClone(state.allocations);
                        const transaction = {
                          userId: input.userId,
                          reservationGeneration,
                          state,
                          record,
                          uuid: random.uuidV4(),
                        };
                        outcome = await Effect.runPromiseExitWith(context)(
                          reserve.pipe(Effect.provideService(AccountReservation, transaction)),
                          { signal: controller.signal },
                        );
                        if (Exit.isSuccess(outcome) && !controller.signal.aborted) return state;
                        for (const row of state.allocations)
                          if (
                            !before.some(
                              (old) =>
                                old.environmentId === row.environmentId &&
                                old.nameClaims?.hostname === row.nameClaims?.hostname &&
                                old.nameClaims?.tunnel === row.nameClaims?.tunnel,
                            )
                          )
                            await releaseNames(row);
                        return null;
                      })();
                      return running;
                    },
                  );
                } catch (error) {
                  controller.abort();
                  if (running) await running.catch(() => null);
                  throw error;
                } finally {
                  signal.removeEventListener("abort", cancel);
                }
              },
              catch: (cause) =>
                new ManagedTunnelLimitPersistenceError({
                  operation: "transaction",
                  userId: input.userId,
                  cause,
                }),
            });
          let result = yield* invoke();
          if (!result.allowed && t3Chat.available && result.override === null) {
            const raised = yield* t3Chat.getLink({ userId: input.userId }).pipe(
              Effect.map((l) => (l && l.plan !== "free" ? T3CHAT_PLAN_TUNNEL_LIMITS[l.plan] : 0)),
              Effect.catch((error) =>
                Effect.logWarning("T3 Chat plan check failed", {
                  userId: input.userId,
                  error: error.message,
                }).pipe(Effect.as(0)),
              ),
            );
            result = yield* invoke(Math.max(DEFAULT_MANAGED_TUNNEL_LIMIT, raised));
          }
          if (!result.allowed)
            return yield* new ManagedTunnelLimitExceeded({
              ...input,
              maxTunnels: result.maxTunnels,
              activeTunnels: result.activeTunnels,
            });
          if (!outcome) throw new Error("Missing reservation outcome");
          return yield* outcome;
        }),
      });
      return Context.make(ManagedEndpointAllocationPersistence, allocations).pipe(
        Context.add(ManagedTunnelLimitPersistence, limits),
      );
    }),
  );
}
