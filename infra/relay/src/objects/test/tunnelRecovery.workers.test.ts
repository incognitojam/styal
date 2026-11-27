import { expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";
import {
  ManagedEndpointAllocationPersistence as Allocations,
  ManagedTunnelLimitPersistence as Limits,
} from "../../persistence/TunnelPersistence.ts";
import {
  TunnelOperationExecution,
  TunnelOperationPersistence as Journal,
} from "../../persistence/TunnelOperationPersistence.ts";
import { T3ChatAccounts, T3ChatRequestFailed } from "../../t3chat/T3ChatAccounts.ts";
import { tunnelPersistenceLayer } from "../TunnelPersistence.ts";
import { tunnelOperationsLayer } from "../TunnelOperations.ts";
import { accountName, allocationRouteName } from "../names.ts";
import { accountMigrations } from "../AccountObject.ts";
import { migrate } from "../storage.ts";

const now = "1970-01-01T00:00:00.000Z";
function fixture(slug: string) {
  const key = { userId: `${slug}-owner`, environmentId: `${slug}-machine` };
  const target = { ...key, hostname: `${slug}.example.test`, tunnelName: `managed-${slug}` };
  return {
    key,
    target,
    intent: {
      ...target,
      desired: {
        kind: "provision" as const,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3000 },
      },
    },
  };
}
const layer = Layer.mergeAll(tunnelPersistenceLayer(env), tunnelOperationsLayer(env)).pipe(
  Layer.provide(SecureRandom.layerWebCrypto),
  Layer.provide(Layer.mock(T3ChatAccounts, { available: false })),
);

it.effect(
  "resumes each interrupted name publication and fences old confirmation after restart",
  () =>
    Effect.gen(function* () {
      for (let stage = 0; stage <= 2; stage++) {
        const { key, target } = fixture(`names-${stage}`);
        yield* Effect.promise(() => reset());
        const allocations = yield* Allocations;
        const unknown = env.ALLOCATION_ROUTES.getByName(
          allocationRouteName("tunnel", `unknown-${stage}`),
        );
        expect(yield* allocations.getByTunnelName(`unknown-${stage}`)).toBeNull();
        yield* Effect.promise(() =>
          runInDurableObject(unknown, (_object, ctx) => {
            expect(
              ctx.storage.sql
                .exec(
                  "SELECT name FROM sqlite_master WHERE name IN ('allocation_route', 'relay_object_schema')",
                )
                .toArray(),
            ).toEqual([]);
          }),
        );
        const stub = env.ACCOUNTS.getByName(accountName(key.userId));
        yield* Effect.promise(async () => {
          await stub.allocation({
            version: 1,
            ...key,
            now,
            command: { kind: "reserve", ...target, reservationId: "old-operation" },
          });
          if (stage >= 1)
            await env.ALLOCATION_ROUTES.getByName(
              allocationRouteName("hostname", target.hostname),
            ).claim({ version: 1, owner: key, generation: 1 });
          if (stage >= 2)
            await env.ALLOCATION_ROUTES.getByName(
              allocationRouteName("tunnel", target.tunnelName),
            ).claim({ version: 1, owner: key, generation: 1 });
          await abortAllDurableObjects();
        });
        expect(yield* allocations.get(key)).toBeNull();
        expect(yield* allocations.getByTunnelName(target.tunnelName)).toBeNull();
        const resumed = yield* allocations.reserve({
          ...target,
          hostname: "other.example.test",
          tunnelName: "other",
        });
        expect(resumed).toMatchObject(target);
        yield* Effect.promise(() => abortAllDurableObjects());
        expect(yield* allocations.getByTunnelName(target.tunnelName)).toEqual(resumed);
        expect(
          (yield* Effect.promise(() =>
            env.ACCOUNTS.getByName(accountName(key.userId)).allocation({
              version: 1,
              userId: key.userId,
              now,
              command: {
                kind: "confirm-names",
                environmentId: key.environmentId,
                reservationId: "old-operation",
                nameClaims: { hostname: 1, tunnel: 1 },
              },
            }),
          )).applied,
        ).toBe(false);
        expect(yield* allocations.getByTunnelName(target.tunnelName)).toEqual(resumed);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "commits the reservation and journal together and rolls both back on callback failure",
  () =>
    Effect.gen(function* () {
      const { key, target, intent } = fixture("rollback");
      yield* Effect.promise(() => reset());
      const allocations = yield* Allocations;
      const limits = yield* Limits;
      const journal = yield* Journal;
      const reserve = Effect.gen(function* () {
        const allocation = yield* allocations.reserve(target);
        const operation = yield* journal.begin(intent);
        return { allocation, operation };
      });
      expect(
        yield* limits
          .withCapacity(key, reserve.pipe(Effect.andThen(Effect.fail("synthetic failure"))))
          .pipe(Effect.flip),
      ).toBe("synthetic failure");
      yield* Effect.promise(() => abortAllDurableObjects());
      expect(yield* allocations.get(key)).toBeNull();
      expect(yield* journal.pending(10)).toEqual([]);
      const other = { ...target, userId: "owner-b" };
      yield* allocations.reserve(other);
      const collision = { ...target, hostname: "free-name.example.test" };
      expect(
        (yield* limits.withCapacity(key, allocations.reserve(collision)).pipe(Effect.flip))._tag,
      ).toBe("ManagedEndpointAllocationPersistenceError");
      expect(yield* allocations.get(key)).toBeNull();
      expect(yield* allocations.getByTunnelName(target.tunnelName)).toMatchObject(other);
      const releasedPartial = { ...collision, userId: "owner-c", tunnelName: "other-name" };
      yield* allocations.reserve(releasedPartial);
      yield* allocations.removeClaimed({ ...releasedPartial, generation: 0 });
      yield* allocations.removeClaimed({ ...other, generation: 0 });
      const reserved = yield* limits.withCapacity(key, reserve);
      expect(reserved.operation?.phase).toBe("intent");
      yield* Effect.promise(() => abortAllDurableObjects());
      expect(yield* allocations.get(key)).toEqual(reserved.allocation);
      expect((yield* journal.pending(10))[0]?.operationId).toBe(reserved.operation?.operationId);
      yield* TestClock.adjust("1 day");
      for (let i = 0; i < 2; i++) {
        const v = {
          ...target,
          environmentId: `other-${i}`,
          hostname: `other-${i}.example.test`,
          tunnelName: `other-${i}`,
        };
        yield* limits.withCapacity(v, allocations.reserve(v));
      }
      expect(
        (yield* limits
          .withCapacity({ ...key, environmentId: "overflow" }, Effect.void)
          .pipe(Effect.flip))._tag,
      ).toBe("ManagedTunnelLimitExceeded");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "retains an interrupted callback intent without committing its staged allocation or journal",
  () =>
    Effect.gen(function* () {
      const { key, target, intent } = fixture("interrupted");
      yield* Effect.promise(() => reset());
      const allocations = yield* Allocations;
      const limits = yield* Limits;
      const journal = yield* Journal;
      const staged = yield* Deferred.make<void>();
      const continueCallback = yield* Deferred.make<void>();
      const interrupted = yield* limits
        .withCapacity(
          key,
          Effect.gen(function* () {
            yield* allocations.reserve(target);
            yield* journal.begin(intent);
            yield* Deferred.succeed(staged, undefined);
            yield* Deferred.await(continueCallback);
          }),
        )
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(staged);
      yield* Effect.promise(() => abortAllDurableObjects());
      yield* Deferred.succeed(continueCallback, undefined);
      yield* Fiber.join(interrupted);
      expect(yield* allocations.get(key)).toBeNull();
      expect(yield* journal.pending(10)).toEqual([]);
      const snapshot = yield* Effect.promise(() =>
        env.ACCOUNTS.getByName(accountName(key.userId)).tunnels({ version: 1, userId: key.userId }),
      );
      expect(snapshot.intents.map((a) => a.tunnelName)).toEqual([target.tunnelName]);
      const restarted = yield* limits.withCapacity(
        key,
        Effect.gen(function* () {
          const row = yield* allocations.reserve({
            ...target,
            hostname: "changed.example.test",
            tunnelName: "changed",
          });
          yield* journal.begin({ ...intent, hostname: row.hostname, tunnelName: row.tunnelName });
          return row;
        }),
      );
      expect(restarted).toMatchObject(target);
      yield* Effect.promise(() => abortAllDurableObjects());
      expect((yield* journal.pending(10))[0]?.tunnelName).toBe(target.tunnelName);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "finishes a lost name release without clearing a later owner's claims and uses direct lookup",
  () =>
    Effect.gen(function* () {
      const { key, target } = fixture("release");
      yield* Effect.promise(() => reset());
      const allocations = yield* Allocations;
      yield* allocations.reserve(target);
      const oldRoute = yield* Effect.promise(() =>
        env.ALLOCATION_ROUTES.getByName(allocationRouteName("tunnel", target.tunnelName)).resolve({
          version: 1,
        }),
      );
      yield* Effect.promise(async () => {
        await env.ACCOUNTS.getByName(accountName(key.userId)).allocation({
          version: 1,
          userId: key.userId,
          now,
          command: { kind: "remove-claimed", environmentId: key.environmentId, generation: 0 },
        });
        await abortAllDurableObjects();
      });
      expect(yield* allocations.getByTunnelName(target.tunnelName)).toBeNull();
      expect(yield* allocations.removeClaimed({ ...key, generation: 0 })).toBe(false);
      const other = { ...target, userId: "owner-b" };
      const moved = yield* allocations.reserve(other);
      yield* Effect.promise(() => abortAllDurableObjects());
      expect(
        yield* Effect.promise(() =>
          env.ALLOCATION_ROUTES.getByName(allocationRouteName("tunnel", target.tunnelName)).release(
            { version: 1, owner: key, epoch: oldRoute!.epoch },
          ),
        ),
      ).toBe(false);
      const noInventory = {
        ...env,
        ACCOUNTS: {
          getByName: (name: string) =>
            new Proxy(env.ACCOUNTS.getByName(name), {
              get(object, property) {
                if (property === "tunnels") throw new Error("Unexpected full account history read");
                return Reflect.get(object, property);
              },
            }),
        },
        INVENTORY: {
          getByName: () => {
            throw new Error("Unexpected inventory scan");
          },
        },
      } as unknown as typeof env;
      const readonlyLayer = tunnelPersistenceLayer(noInventory).pipe(
        Layer.provide(SecureRandom.layerWebCrypto),
        Layer.provide(Layer.mock(T3ChatAccounts, { available: false })),
      );
      expect(
        yield* Allocations.pipe(
          Effect.flatMap((a) => a.getByTunnelName(target.tunnelName)),
          Effect.provide(readonlyLayer),
        ),
      ).toEqual(moved);
      expect(
        yield* Allocations.pipe(
          Effect.flatMap((a) => a.listByTunnelNames([target.tunnelName])),
          Effect.provide(readonlyLayer),
        ),
      ).toEqual([{ ...moved, recoveryEnabled: false }]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "preserves existing account rows on upgrade and keeps overrides exact through plan failures",
  () =>
    Effect.gen(function* () {
      const { key, target } = fixture("upgrade");
      yield* Effect.promise(() => reset());
      const stub = env.ACCOUNTS.getByName(accountName(key.userId));
      yield* Effect.promise(() =>
        runInDurableObject(stub, async (_object, ctx) => {
          await ctx.storage.deleteAll();
          migrate(ctx.storage, accountMigrations.slice(0, 3));
          ctx.storage.sql.exec(
            "INSERT INTO tunnel_operations VALUES (?,'existing-operation',?,'endpoint.example.test','managed-a','{}','intent','{}',?)",
            key.environmentId,
            key.userId,
            now,
          );
          ctx.storage.sql.exec(
            "INSERT INTO account_identity VALUES (1, ?)",
            JSON.stringify({ userId: key.userId, epoch: 1 }),
          );
        }),
      );
      yield* Effect.promise(() => abortAllDurableObjects());
      yield* Effect.promise(() =>
        runInDurableObject(env.ACCOUNTS.getByName(accountName(key.userId)), (_object, ctx) => {
          expect(
            ctx.storage.sql.exec("SELECT version FROM relay_object_schema").one().version,
          ).toBe(accountMigrations.length);
          expect(
            ctx.storage.sql.exec("SELECT operation_id FROM tunnel_operations").one().operation_id,
          ).toBe("existing-operation");
          expect(
            JSON.parse(
              String(ctx.storage.sql.exec("SELECT value FROM account_identity").one().value),
            ),
          ).toEqual({ userId: key.userId, epoch: 1 });
          ctx.storage.sql.exec("INSERT INTO account_tunnel_limit VALUES (1, 1)");
        }),
      );
      const calls = yield* Ref.make(0);
      const plans = Layer.mock(T3ChatAccounts, {
        available: true,
        getLink: () =>
          Ref.update(calls, (n) => n + 1).pipe(
            Effect.andThen(
              Effect.fail(
                new T3ChatRequestFailed({ operation: "get-link", cause: "synthetic outage" }),
              ),
            ),
          ),
      });
      const custom = tunnelPersistenceLayer(env).pipe(
        Layer.provide(SecureRandom.layerWebCrypto),
        Layer.provide(plans),
      );
      yield* Effect.gen(function* () {
        const allocations = yield* Allocations;
        const limits = yield* Limits;
        expect(yield* limits.getOverride(key)).toBe(1);
        yield* limits.withCapacity(key, allocations.reserve(target));
        expect(
          yield* limits
            .withCapacity({ ...key, environmentId: "blocked" }, Effect.void)
            .pipe(Effect.flip),
        ).toMatchObject({ maxTunnels: 1 });
        expect(yield* Ref.get(calls)).toBe(0);
        yield* Effect.promise(() =>
          runInDurableObject(env.ACCOUNTS.getByName(accountName(key.userId)), (_object, ctx) => {
            ctx.storage.sql.exec("DELETE FROM account_tunnel_limit");
          }),
        );
        for (let i = 0; i < 2; i++) {
          const v = {
            ...target,
            environmentId: `plan-${i}`,
            hostname: `plan-${i}.example.test`,
            tunnelName: `plan-${i}`,
          };
          yield* limits.withCapacity(v, allocations.reserve(v));
        }
        expect(
          yield* limits
            .withCapacity({ ...key, environmentId: "blocked" }, Effect.void)
            .pipe(Effect.flip),
        ).toMatchObject({ maxTunnels: 3 });
        expect(yield* Ref.get(calls)).toBe(1);
      }).pipe(Effect.provide(custom));
    }).pipe(Effect.provide(layer)),
);

it.effect("fences overlapping reservation callbacks and revalidates journal reads at commit", () =>
  Effect.gen(function* () {
    const { key, target, intent } = fixture("overlap");
    yield* Effect.promise(() => reset());
    const allocations = yield* Allocations;
    const limits = yield* Limits;
    const journal = yield* Journal;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let continueClaim!: () => void;
    const proceed = new Promise<void>((resolve) => {
      continueClaim = resolve;
    });
    const tunnelRoute = allocationRouteName("tunnel", target.tunnelName);
    const delayed = {
      ...env,
      ALLOCATION_ROUTES: {
        getByName: (name: string) => {
          const stub = env.ALLOCATION_ROUTES.getByName(name);
          return new Proxy(stub, {
            get(object, property) {
              if (property === "claim")
                return async (input: Parameters<typeof stub.claim>[0]) => {
                  if (name === tunnelRoute) {
                    reached();
                    await proceed;
                  }
                  return await stub.claim(input);
                };
              return Reflect.get(object, property);
            },
          });
        },
      },
    } as unknown as typeof env;
    const delayedLayer = tunnelPersistenceLayer(delayed).pipe(
      Layer.provide(SecureRandom.layerWebCrypto),
      Layer.provide(Layer.mock(T3ChatAccounts, { available: false })),
    );
    const losing = yield* Effect.gen(function* () {
      const a = yield* Allocations;
      const l = yield* Limits;
      return yield* l.withCapacity(key, a.reserve(target));
    }).pipe(Effect.provide(delayedLayer), Effect.result, Effect.forkChild);
    yield* Effect.promise(() => waiting);
    const winner = yield* limits.withCapacity(key, allocations.reserve(target));
    continueClaim();
    expect((yield* Fiber.join(losing))._tag).toBe("Failure");
    expect(yield* allocations.getByTunnelName(target.tunnelName)).toEqual(winner);
    expect(yield* allocations.reserve(target)).toEqual(winner);
    const first = yield* journal.begin(intent);
    if (!first) return yield* Effect.die("Missing journal");
    const guarded = yield* Deferred.make<void>();
    const resumeGuarded = yield* Deferred.make<void>();
    const stale = yield* limits
      .withCapacity(
        key,
        Effect.gen(function* () {
          yield* Deferred.succeed(guarded, undefined);
          yield* Deferred.await(resumeGuarded);
          return yield* allocations.recordTunnel({
            ...key,
            generation: 0,
            tunnelId: "stale-tunnel",
          });
        }),
      )
      .pipe(
        Effect.provideService(TunnelOperationExecution, first),
        Effect.result,
        Effect.forkChild,
      );
    yield* Deferred.await(guarded);
    yield* journal.begin({
      ...intent,
      desired: { kind: "provision", origin: { ...intent.desired.origin, localHttpPort: 4000 } },
    });
    yield* Deferred.succeed(resumeGuarded, undefined);
    expect((yield* Fiber.join(stale))._tag).toBe("Failure");
    expect((yield* allocations.get(key))?.tunnelId).toBeNull();
  }).pipe(Effect.provide(layer)),
);
