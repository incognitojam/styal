import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { RelayDb } from "../db.ts";
import { relayManagedTunnelLimits } from "../persistence/schema.ts";
import * as PostgresTunnelOperations from "../persistence/PostgresTunnelOperations.ts";
import { TunnelOperationPersistence } from "../persistence/TunnelOperationPersistence.ts";
import { layerLocalRelayDb } from "../test/localRelayDb.ts";
import { config } from "../test/fixtures.ts";
import * as RelayConfiguration from "../Config.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import * as Allocations from "./ManagedEndpointAllocations.ts";
import * as Limits from "./ManagedTunnelLimits.ts";
import * as Provider from "./ManagedEndpointProvider.ts";
import * as Reaper from "./ManagedEndpointReaper.ts";

const key = { userId: "user-a", environmentId: "environment-a" };
const request = { ...key, origin: { localHttpHost: "localhost", localHttpPort: 3000 } };

function fixture(hooks?: {
  readonly beforeClaim?: Effect.Effect<void>;
  readonly afterDnsDelete?: Effect.Effect<void>;
}) {
  let tunnel: { id: string; name: string } | null = null;
  let record: { id: string; content: string } | null = null;
  let crash:
    | "before-create"
    | "after-create"
    | "after-dns"
    | "after-config"
    | "after-delete"
    | "disappear"
    | null = null;
  let created = 0;
  let deleted = 0;
  let ingress: unknown;
  let configurationWrites = 0;
  let refuseDelete = false;
  const tunnelClient = Provider.ManagedEndpointTunnelClient.of({
    get: (id) =>
      Effect.suspend(() =>
        tunnel
          ? Effect.succeed({
              ...tunnel,
              status: "down",
              connsInactiveAt: "2020-01-01T00:00:00.000Z",
            })
          : Effect.fail(
              new Provider.ManagedEndpointTunnelClientError({
                operation: "get",
                tunnelId: id,
                cause: { status: 404 },
              }),
            ),
      ),
    list: () => Effect.sync(() => ({ result: tunnel ? [tunnel] : [] })),
    create: ({ name }) =>
      Effect.gen(function* () {
        if (crash === "before-create") {
          crash = null;
          return yield* Effect.die("process lost before create");
        }
        tunnel = { id: `tunnel-${++created}`, name };
        if (crash === "after-create") {
          crash = null;
          return yield* Effect.die("process lost after create");
        }
        return tunnel;
      }),
    putConfiguration: (_, configuration) =>
      Effect.gen(function* () {
        ingress = configuration;
        configurationWrites++;
        if (crash === "after-config") {
          crash = null;
          return yield* Effect.die("process lost after configure");
        }
      }),
    getConfiguration: () => Effect.succeed({ ingress: [] }),
    getToken: () =>
      Effect.suspend(() => {
        if (crash === "disappear") {
          crash = null;
          tunnel = null;
          return Effect.fail(
            new Provider.ManagedEndpointTunnelClientError({
              operation: "get-token",
              cause: { status: 404 },
            }),
          );
        }
        return Effect.succeed("synthetic-token");
      }),
    delete: () =>
      Effect.gen(function* () {
        if (refuseDelete)
          return yield* new Provider.ManagedEndpointTunnelClientError({
            operation: "delete",
            cause: { message: "has active connections" },
          });
        const existed = tunnel !== null;
        tunnel = null;
        deleted++;
        if (!existed)
          return yield* new Provider.ManagedEndpointTunnelClientError({
            operation: "delete",
            cause: { status: 404 },
          });
        if (crash === "after-delete") {
          crash = null;
          return yield* Effect.die("process lost after delete");
        }
      }),
  });
  const dnsClient = Provider.ManagedEndpointDnsClient.of({
    listRecords: () => Effect.sync(() => (record ? [{ id: record.id }] : [])),
    createRecord: (input) =>
      Effect.gen(function* () {
        record = { id: "dns-a", content: input.content };
        if (crash === "after-dns") {
          crash = null;
          return yield* Effect.die("process lost after DNS create");
        }
        return record;
      }),
    updateRecord: (_, input) =>
      Effect.sync(() => {
        record = { id: "dns-a", content: input.content };
      }),
    deleteRecord: () =>
      Effect.gen(function* () {
        const existed = record !== null;
        record = null;
        if (hooks?.afterDnsDelete) yield* hooks.afterDnsDelete;
        if (!existed)
          return yield* new Provider.ManagedEndpointDnsClientError({
            operation: "delete-record",
            cause: { status: 404 },
          });
      }),
  });
  const storage = Layer.mergeAll(
    Layer.effect(
      Allocations.ManagedEndpointAllocations,
      Effect.gen(function* () {
        const allocations = yield* Allocations.ManagedEndpointAllocations;
        return Allocations.ManagedEndpointAllocations.of({
          ...allocations,
          claimDeprovision: (input) =>
            (hooks?.beforeClaim ?? Effect.void).pipe(
              Effect.andThen(allocations.claimDeprovision(input)),
            ),
        });
      }),
    ).pipe(Layer.provide(Allocations.layer)),
    PostgresTunnelOperations.layer,
    Limits.layer,
  ).pipe(
    Layer.provide(
      Layer.mock(T3ChatAccounts.T3ChatAccounts, {
        available: false,
        getLink: () => Effect.succeed(null),
      }),
    ),
    Layer.provideMerge(layerLocalRelayDb),
    Layer.provide(NodeCrypto.layer),
  );
  const layer = Provider.layer.pipe(
    Layer.provideMerge(storage),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(RelayConfiguration.layer(config)),
    Layer.provideMerge(Provider.layerTunnelClient(tunnelClient)),
    Layer.provideMerge(Provider.layerDnsClient(dnsClient)),
  );
  return {
    layer: Reaper.layer.pipe(Layer.provideMerge(layer)),
    crash: (point: typeof crash) => {
      crash = point;
    },
    refuseDelete: (value: boolean) => {
      refuseDelete = value;
    },
    state: () => ({ tunnel, record, created, deleted, ingress, configurationWrites }),
  };
}

describe("durable endpoint operations", () => {
  it.effect.each([
    "before-create",
    "after-create",
    "after-dns",
    "after-config",
    "disappear",
  ] as const)("resumes %s from persisted intent without allocating a different name", (point) => {
    const f = fixture();
    return Effect.gen(function* () {
      const provider = yield* Provider.ManagedEndpointProvider;
      const journal = yield* TunnelOperationPersistence;
      if (point === "after-config") yield* provider.provision(request);
      f.crash(point);
      yield* Effect.exit(provider.provision(request));
      const pending = yield* journal.pending(10);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.desired).toEqual({ kind: "provision", origin: request.origin });
      const names = { hostname: pending[0]?.hostname, tunnelName: pending[0]?.tunnelName };
      if (point === "before-create") {
        yield* (yield* Reaper.ManagedEndpointReaper).sweep;
        expect(yield* journal.pending(10)).toEqual([]);
      }
      const result = yield* provider.provision({ ...request, reuseReadyTunnel: true });
      if (point === "after-config") expect(f.state().configurationWrites).toBe(3);
      expect(result.runtime.tunnelName).toBe(names.tunnelName);
      expect(result.endpoint.httpBaseUrl).toBe(`https://${names.hostname}/`);
      expect(f.state().created).toBe(point === "disappear" ? 2 : 1);
      expect(f.state().record?.content).toBe(`${result.runtime.tunnelId}.cfargotunnel.com`);
      expect(yield* journal.pending(10)).toEqual([]);
      const again = yield* provider.provision(request);
      expect(again.runtime.tunnelId).toBe(result.runtime.tunnelId);
      expect(f.state().created).toBe(point === "disappear" ? 2 : 1);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("retains old pending capacity and rejects reaping until resume completes", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const provider = yield* Provider.ManagedEndpointProvider;
      const allocations = yield* Allocations.ManagedEndpointAllocations;
      const limits = yield* Limits.ManagedTunnelLimits;
      const db = yield* RelayDb;
      yield* db.insert(relayManagedTunnelLimits).values({
        userId: key.userId,
        maxTunnels: 1,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
      f.crash("after-dns");
      yield* Effect.exit(provider.provision(request));
      yield* TestClock.adjust("1 day");
      const allocation = yield* allocations.get(key);
      if (!allocation || !allocation.tunnelId) return yield* Effect.die("missing allocation");
      expect(yield* allocations.listByTunnelNames([allocation.tunnelName])).toEqual([]);
      expect(
        yield* allocations.claimRelease({
          ...key,
          tunnelId: allocation.tunnelId,
          generation: allocation.generation,
        }),
      ).toBeNull();
      expect(
        (yield* Effect.flip(
          limits.withCapacity({ ...key, environmentId: "environment-b" }, Effect.void),
        ))._tag,
      ).toBe("ManagedTunnelLimitExceeded");
      yield* provider.provision(request);
      expect(f.state().deleted).toBe(0);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("repeats teardown after a lost delete result, including already-gone resources", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const provider = yield* Provider.ManagedEndpointProvider;
      const journal = yield* TunnelOperationPersistence;
      const allocations = yield* Allocations.ManagedEndpointAllocations;
      yield* provider.provision(request);
      f.refuseDelete(true);
      expect(yield* provider.release({ ...key, markReleased: true })).toBe(false);
      expect((yield* allocations.get(key))?.tunnelReleasedAt).toBeNull();
      f.refuseDelete(false);
      f.crash("after-delete");
      yield* Effect.exit(provider.deprovision(key));
      expect(yield* journal.pending(10)).toHaveLength(1);
      expect(yield* provider.deprovision(key)).toBe(true);
      expect(yield* allocations.get(key)).toBeNull();
      expect(yield* journal.pending(10)).toEqual([]);
      expect(yield* provider.deprovision(key)).toBe(true);
      expect(f.state().tunnel).toBeNull();
      expect(f.state().record).toBeNull();
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("keeps a shared deletion pending when an overlapping retry loses its claim", () =>
    Effect.gen(function* () {
      const retryRead = yield* Deferred.make<void>();
      const allowRetry = yield* Deferred.make<void>();
      const deletedDns = yield* Deferred.make<void>();
      const allowDelete = yield* Deferred.make<void>();
      let claims = 0;
      const f = fixture({
        beforeClaim: Effect.suspend(() =>
          ++claims === 1
            ? Deferred.succeed(retryRead, undefined).pipe(
                Effect.andThen(Deferred.await(allowRetry)),
                Effect.asVoid,
              )
            : Effect.void,
        ),
        afterDnsDelete: Deferred.succeed(deletedDns, undefined).pipe(
          Effect.andThen(Deferred.await(allowDelete)),
          Effect.asVoid,
        ),
      });
      yield* Effect.gen(function* () {
        const provider = yield* Provider.ManagedEndpointProvider;
        const journal = yield* TunnelOperationPersistence;
        yield* provider.provision(request);
        const retry = yield* Effect.forkChild(provider.deprovision(key));
        yield* Deferred.await(retryRead);
        const deleting = yield* Effect.forkChild(provider.deprovision(key));
        yield* Deferred.await(deletedDns);
        yield* Deferred.succeed(allowRetry, undefined);
        expect(yield* Fiber.join(retry)).toBe(false);
        expect(yield* journal.pending(10)).toHaveLength(1);
        yield* Deferred.succeed(allowDelete, undefined);
        expect(yield* Fiber.join(deleting)).toBe(true);
        expect(yield* journal.pending(10)).toEqual([]);
        expect(f.state().tunnel).toBeNull();
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect("reclaims capacity after a guarded cleanup loses the successful delete result", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const provider = yield* Provider.ManagedEndpointProvider;
      const allocations = yield* Allocations.ManagedEndpointAllocations;
      const limits = yield* Limits.ManagedTunnelLimits;
      const journal = yield* TunnelOperationPersistence;
      yield* provider.provision(request);
      const allocation = yield* allocations.get(key);
      if (!allocation?.tunnelId) return yield* Effect.die("missing tunnel");
      yield* (yield* RelayDb).insert(relayManagedTunnelLimits).values({
        userId: key.userId,
        maxTunnels: 1,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
      const options = {
        ...key,
        expectedTunnelId: allocation.tunnelId,
        expectedStatus: "down" as const,
        expectedInactiveBefore: "2026-01-01T00:00:00.000Z",
        markReleased: true,
      };
      f.crash("after-delete");
      yield* Effect.exit(provider.release(options));
      expect(f.state().tunnel).toBeNull();
      expect(yield* journal.pending(10)).toHaveLength(1);
      expect(yield* provider.release(options)).toBe(true);
      expect((yield* allocations.get(key))?.tunnelReleasedAt).not.toBeNull();
      expect(yield* journal.pending(10)).toEqual([]);
      expect(
        yield* limits.withCapacity(
          { ...key, environmentId: "environment-b" },
          Effect.succeed("capacity available"),
        ),
      ).toBe("capacity available");
    }).pipe(Effect.provide(f.layer));
  });
});
