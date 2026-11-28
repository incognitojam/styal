import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_MANAGED_TUNNEL_LIMIT } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import { EnvironmentLinkPersistence } from "../persistence/EnvironmentPersistence.ts";

import {
  ManagedEndpointAllocationPersistence,
  ManagedTunnelLimitPersistence,
} from "../persistence/TunnelPersistence.ts";
import {
  TunnelOperationExecution,
  TunnelOperationPersistence,
} from "../persistence/TunnelOperationPersistence.ts";

const key = { userId: "user-a", environmentId: "environment-a" };
const target = { ...key, hostname: "endpoint.example.test", tunnelName: "managed-a" };
const origin = { localHttpHost: "127.0.0.1", localHttpPort: 3000 };
const intent = { ...target, desired: { kind: "provision" as const, origin } };
function linkInput(input: typeof key, environmentPublicKey = "key-a") {
  const environmentId = EnvironmentId.make(input.environmentId);
  const endpoint = {
    httpBaseUrl: "https://endpoint.example.test/",
    wsBaseUrl: "wss://endpoint.example.test/",
    providerKind: "cloudflare_tunnel" as const,
  };
  return {
    ...input,
    request: {
      proof: "verified",
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: true,
    },
    proof: {
      environmentId,
      environmentPublicKey,
      iss: "environment",
      aud: "relay",
      sub: environmentId,
      jti: "proof",
      iat: 0,
      exp: 300,
      challenge: "verified",
      descriptor: {
        environmentId,
        label: "Synthetic environment",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      endpoint,
      origin,
      scopes: ["managed_tunnels"],
    },
    endpoint,
  } satisfies Parameters<EnvironmentLinkPersistence["Service"]["upsert"]>[0];
}

type Stores =
  | EnvironmentLinkPersistence
  | ManagedEndpointAllocationPersistence
  | ManagedTunnelLimitPersistence
  | TunnelOperationPersistence;

export function managedEndpointAllocationContract<E>(name: string, layer: Layer.Layer<Stores, E>) {
  describe(name, () => {
    it.effect("retains reservation names on relink and fences each generation transition", () =>
      Effect.gen(function* () {
        const allocations = yield* ManagedEndpointAllocationPersistence;
        expect(yield* allocations.get(key)).toBeNull();
        const first = yield* allocations.reserve(target);
        expect(first).toMatchObject({
          ...target,
          tunnelId: null,
          dnsRecordId: null,
          readyAt: null,
          origin: null,
          generation: 0,
          tunnelReleasedAt: null,
        });
        yield* TestClock.adjust("1 second");
        const again = yield* allocations.reserve({
          ...target,
          hostname: "changed.example.test",
          tunnelName: "changed",
        });
        expect(again).toEqual({ ...first, updatedAt: DateTime.formatIso(yield* DateTime.now) });
        expect(yield* allocations.getByTunnelName(target.tunnelName)).toEqual(again);
        expect(yield* allocations.getByTunnelName("absent")).toBeNull();
        const tunnel = { ...key, tunnelId: "tunnel-a", generation: first.generation };
        expect(yield* allocations.recordTunnel(tunnel)).toBe(1);
        expect(yield* allocations.recordTunnel(tunnel)).toBeNull();
        expect(
          yield* allocations.recordDns({
            ...tunnel,
            generation: 1,
            tunnelId: "wrong",
            dnsRecordId: "dns-a",
          }),
        ).toBeNull();
        expect(
          yield* allocations.recordDns({ ...tunnel, generation: 1, dnsRecordId: "dns-a" }),
        ).toBe(2);
        expect(yield* allocations.markReady({ ...tunnel, generation: 1, origin })).toBe(false);
        expect(yield* allocations.markReady({ ...tunnel, generation: 2, origin })).toBe(true);
        const ready = yield* allocations.get(key);
        expect(ready).toMatchObject({
          tunnelId: "tunnel-a",
          dnsRecordId: "dns-a",
          origin,
          generation: 3,
          readyAt: DateTime.formatIso(yield* DateTime.now),
        });
        expect(yield* allocations.listByTunnelNames([])).toEqual([]);
        expect(yield* allocations.listByTunnelNames([target.tunnelName])).toEqual([
          { ...ready, recoveryEnabled: false },
        ]);
        const called = yield* Ref.make(0);
        expect(
          yield* allocations.withClaimedTunnel(
            { ...tunnel, generation: 2 },
            Ref.update(called, (n) => n + 1),
          ),
        ).toEqual(Option.none());
        expect(
          yield* allocations.withClaimedTunnel(
            { ...tunnel, generation: 3 },
            Ref.update(called, (n) => n + 1),
          ),
        ).toEqual(Option.some(undefined));
        expect(yield* Ref.get(called)).toBe(1);
        yield* TestClock.adjust("1 second");
        expect(yield* allocations.claimRelease({ ...tunnel, generation: 3 })).toBe(4);
        expect((yield* allocations.get(key))?.updatedAt).toBe(ready?.updatedAt);
        expect(yield* allocations.claimDeprovision({ ...key, generation: 4 })).toBe(5);
        expect((yield* allocations.get(key))?.updatedAt).toBe(ready?.updatedAt);
        expect(yield* allocations.removeClaimed({ ...key, generation: 4 })).toBe(false);
        expect(
          yield* allocations.claimRelease({ ...tunnel, generation: 5, markReleased: true }),
        ).toBe(6);
        const released = yield* allocations.get(key);
        expect(released?.tunnelReleasedAt).toBe(DateTime.formatIso(yield* DateTime.now));
        expect(released?.updatedAt).toBe(released?.tunnelReleasedAt);
        expect(yield* allocations.removeClaimed({ ...key, generation: 6 })).toBe(true);
        expect(yield* allocations.removeClaimed({ ...key, generation: 6 })).toBe(false);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "guards every journal-sensitive transition against missing, stale and completed executors",
      () =>
        Effect.gen(function* () {
          const allocations = yield* ManagedEndpointAllocationPersistence;
          const journal = yield* TunnelOperationPersistence;
          yield* allocations.reserve(target);
          yield* allocations.recordTunnel({ ...key, tunnelId: "tunnel-a", generation: 0 });
          const operation = yield* journal.begin(intent);
          if (!operation) return yield* Effect.die("Missing operation");
          const blocked = Effect.gen(function* () {
            const before = yield* allocations.get(key);
            const snapshot = { ...key, tunnelId: "tunnel-a", generation: before!.generation };
            expect(yield* allocations.recordTunnel(snapshot)).toBeNull();
            expect(yield* allocations.recordDns({ ...snapshot, dnsRecordId: "dns-a" })).toBeNull();
            expect(yield* allocations.markReady({ ...snapshot, origin })).toBe(false);
            expect(yield* allocations.claimRelease(snapshot)).toBeNull();
            expect(yield* allocations.claimDeprovision(snapshot)).toBeNull();
            expect(yield* allocations.removeClaimed(snapshot)).toBe(false);
            expect(
              yield* allocations.withClaimedTunnel(snapshot, Effect.die("Blocked executor ran")),
            ).toEqual(Option.none());
            expect(yield* allocations.get(key)).toEqual(before);
          });
          yield* blocked;
          expect(yield* allocations.listByTunnelNames([target.tunnelName])).toEqual([]);
          yield* blocked.pipe(
            Effect.provideService(TunnelOperationExecution, { ...operation, operationId: "stale" }),
          );
          const authorized = Effect.gen(function* () {
            expect(
              yield* allocations.recordTunnel({ ...key, tunnelId: "tunnel-a", generation: 1 }),
            ).toBe(2);
            expect(
              yield* allocations.recordDns({
                ...key,
                tunnelId: "tunnel-a",
                generation: 2,
                dnsRecordId: "dns-a",
              }),
            ).toBe(3);
            expect(
              yield* allocations.markReady({ ...key, tunnelId: "tunnel-a", generation: 3, origin }),
            ).toBe(true);
            expect(
              yield* allocations.withClaimedTunnel(
                { ...key, tunnelId: "tunnel-a", generation: 4 },
                Effect.succeed("ran"),
              ),
            ).toEqual(Option.some("ran"));
            expect(
              yield* allocations.claimRelease({ ...key, tunnelId: "tunnel-a", generation: 4 }),
            ).toBe(5);
            expect(yield* allocations.claimDeprovision({ ...key, generation: 5 })).toBe(6);
          });
          yield* authorized.pipe(Effect.provideService(TunnelOperationExecution, operation));
          // Reservation refresh is intentionally independent of the journal executor.
          yield* allocations.reserve(target);
          yield* journal.complete(operation.operationId);
          yield* blocked.pipe(Effect.provideService(TunnelOperationExecution, operation));
          const links = yield* EnvironmentLinkPersistence;
          yield* links.upsert(linkInput(key));
          const recovery = { ...key, tunnelId: "tunnel-a", environmentPublicKey: "key-a", origin };
          expect(
            yield* allocations.enableRecovery({ ...recovery, environmentPublicKey: "wrong" }),
          ).toBe(false);
          expect(
            yield* allocations.enableRecovery({
              ...recovery,
              origin: { ...origin, localHttpPort: 4000 },
            }),
          ).toBe(false);
          const pending = yield* journal.begin(intent);
          if (!pending) return yield* Effect.die("Missing recovery operation");
          expect(yield* allocations.enableRecovery(recovery)).toBe(true);
          expect(yield* allocations.listByTunnelNames([target.tunnelName])).toEqual([]);
          yield* journal.complete(pending.operationId);
          expect(
            (yield* allocations.listByTunnelNames([target.tunnelName]))[0]?.recoveryEnabled,
          ).toBe(true);
          expect(
            yield* allocations.recordTunnel({ ...key, tunnelId: "tunnel-a", generation: 7 }),
          ).toBe(8);
          expect(
            (yield* allocations.listByTunnelNames([target.tunnelName]))[0]?.recoveryEnabled,
          ).toBe(true);
          yield* links.upsert(linkInput(key, "key-b"));
          expect(
            (yield* allocations.listByTunnelNames([target.tunnelName]))[0]?.recoveryEnabled,
          ).toBe(false);
          expect(
            yield* allocations.enableRecovery({ ...recovery, environmentPublicKey: "key-b" }),
          ).toBe(true);
          expect(
            yield* allocations.recordTunnel({ ...key, tunnelId: "tunnel-b", generation: 9 }),
          ).toBe(10);
          expect(yield* allocations.get(key)).toMatchObject({ readyAt: null, origin: null });
          expect(
            (yield* allocations.listByTunnelNames([target.tunnelName]))[0]?.recoveryEnabled,
          ).toBe(false);
          expect(
            yield* allocations.markReady({ ...key, tunnelId: "tunnel-b", generation: 10, origin }),
          ).toBe(true);
          expect(
            yield* allocations.enableRecovery({
              ...recovery,
              tunnelId: "tunnel-b",
              environmentPublicKey: "key-b",
            }),
          ).toBe(true);
          expect(
            (yield* allocations.listByTunnelNames([target.tunnelName]))[0]?.recoveryEnabled,
          ).toBe(true);
          yield* links.revokeForUser(key);
          expect(
            (yield* allocations.listByTunnelNames([target.tunnelName]))[0]?.recoveryEnabled,
          ).toBe(false);
          const removing = yield* journal.begin(intent);
          if (!removing) return yield* Effect.die("Missing removal operation");
          expect(
            yield* allocations
              .removeClaimed({ ...key, generation: 12 })
              .pipe(Effect.provideService(TunnelOperationExecution, removing)),
          ).toBe(true);
          yield* allocations.reserve(target);
          expect(
            yield* allocations
              .recordTunnel({ ...key, tunnelId: "tunnel-a", generation: 0 })
              .pipe(Effect.provideService(TunnelOperationExecution, removing)),
          ).toBe(1);
          yield* journal.complete(removing.operationId);
          expect(yield* allocations.removeClaimed({ ...key, generation: 1 })).toBe(true);
        }).pipe(Effect.provide(layer)),
    );
  });
}

export function managedTunnelLimitContract<E>(name: string, layer: Layer.Layer<Stores, E>) {
  describe(name, () => {
    it.effect(
      "counts concurrent reservations atomically and reuses an existing slot at the cap",
      () =>
        Effect.gen(function* () {
          const allocations = yield* ManagedEndpointAllocationPersistence;
          const limits = yield* ManagedTunnelLimitPersistence;
          expect(yield* limits.getOverride(key)).toBeNull();
          const results = yield* Effect.forEach(
            Array.from({ length: DEFAULT_MANAGED_TUNNEL_LIMIT + 2 }, (_, i) => i),
            (i) => {
              const reservation = {
                ...key,
                environmentId: `environment-${i}`,
                hostname: `endpoint-${i}.example.test`,
                tunnelName: `managed-${i}`,
              };
              return limits
                .withCapacity(reservation, allocations.reserve(reservation))
                .pipe(Effect.result);
            },
            { concurrency: "unbounded" },
          );
          const reserved = results.filter(Result.isSuccess).map((r) => r.success);
          expect(reserved).toHaveLength(DEFAULT_MANAGED_TUNNEL_LIMIT);
          expect(results.filter(Result.isFailure).map((r) => r.failure._tag)).toEqual([
            "ManagedTunnelLimitExceeded",
            "ManagedTunnelLimitExceeded",
          ]);
          expect(
            yield* limits.withCapacity(reserved[0]!, allocations.reserve(reserved[0]!)),
          ).toEqual(reserved[0]);
          const other = { ...target, userId: "user-b" };
          yield* limits.withCapacity(other, allocations.reserve(other));
        }).pipe(Effect.provide(layer)),
    );

    it.effect("serializes compatible reservations for the same environment so both succeed", () =>
      Effect.gen(function* () {
        const allocations = yield* ManagedEndpointAllocationPersistence;
        const limits = yield* ManagedTunnelLimitPersistence;
        const journal = yield* TunnelOperationPersistence;
        const reserve = Effect.gen(function* () {
          const allocation = yield* allocations.reserve(target);
          const operation = yield* journal.begin(intent);
          return { allocation, operation };
        });
        const results = yield* Effect.all(
          [limits.withCapacity(key, reserve), limits.withCapacity(key, reserve)],
          { concurrency: "unbounded" },
        );
        expect(results[0].allocation).toEqual(results[1].allocation);
        expect(results[0].operation?.operationId).toBe(results[1].operation?.operationId);
        expect(results[0].operation).not.toBeNull();
        expect(yield* allocations.getByTunnelName(target.tunnelName)).toEqual(
          results[0].allocation,
        );
        expect(yield* journal.pending(10)).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
    );

    it.effect(
      "expires unjournaled reservations at fifteen minutes but retains pending operations",
      () =>
        Effect.gen(function* () {
          const allocations = yield* ManagedEndpointAllocationPersistence;
          const limits = yield* ManagedTunnelLimitPersistence;
          const journal = yield* TunnelOperationPersistence;
          const reservations = Array.from({ length: DEFAULT_MANAGED_TUNNEL_LIMIT }, (_, i) => ({
            ...target,
            environmentId: `environment-${i}`,
            hostname: `endpoint-${i}.example.test`,
            tunnelName: `managed-${i}`,
          }));
          for (const r of reservations) yield* limits.withCapacity(r, allocations.reserve(r));
          const attempt = limits.withCapacity(target, Effect.succeed("available"));
          yield* TestClock.adjust("14 minutes");
          expect((yield* Effect.flip(attempt))._tag).toBe("ManagedTunnelLimitExceeded");
          yield* TestClock.adjust("1 minute");
          expect(yield* attempt).toBe("available");
          for (const r of reservations) {
            const op = yield* journal.begin({ ...r, desired: intent.desired });
            if (!op) return yield* Effect.die("Missing operation");
          }
          yield* TestClock.adjust("1 day");
          expect((yield* Effect.flip(attempt))._tag).toBe("ManagedTunnelLimitExceeded");
          for (const op of yield* journal.pending(100)) yield* journal.complete(op.operationId);
          expect(yield* attempt).toBe("available");
          for (const r of reservations)
            expect(
              yield* allocations.recordTunnel({
                ...r,
                tunnelId: `tunnel-${r.environmentId}`,
                generation: 0,
              }),
            ).toBe(1);
          yield* TestClock.adjust("1 day");
          expect((yield* Effect.flip(attempt))._tag).toBe("ManagedTunnelLimitExceeded");
          const first = reservations[0]!;
          expect(
            yield* allocations.claimRelease({
              ...first,
              tunnelId: `tunnel-${first.environmentId}`,
              generation: 1,
              markReleased: true,
            }),
          ).toBe(2);
          expect(yield* attempt).toBe("available");
          yield* TestClock.adjust("1 second");
          yield* allocations.reserve(first);
          expect((yield* Effect.flip(attempt))._tag).toBe("ManagedTunnelLimitExceeded");
          const links = yield* EnvironmentLinkPersistence;
          const second = reservations[1]!;
          yield* links.upsert(linkInput(second));
          yield* links.revokeForUser(second);
          expect(yield* attempt).toBe("available");
          yield* TestClock.adjust("1 second");
          yield* allocations.reserve(second);
          expect((yield* Effect.flip(attempt))._tag).toBe("ManagedTunnelLimitExceeded");
          const third = reservations[2]!;
          const withdrawn = linkInput(third);
          yield* links.upsert({
            ...withdrawn,
            request: { ...withdrawn.request, managedTunnelsEnabled: false },
          });
          expect(yield* attempt).toBe("available");
          yield* TestClock.adjust("1 second");
          yield* allocations.reserve(third);
          expect((yield* Effect.flip(attempt))._tag).toBe("ManagedTunnelLimitExceeded");
        }).pipe(Effect.provide(layer)),
    );

    it.effect("rolls back a failed reservation callback and releases its capacity", () =>
      Effect.gen(function* () {
        const allocations = yield* ManagedEndpointAllocationPersistence;
        const limits = yield* ManagedTunnelLimitPersistence;
        expect(
          yield* limits
            .withCapacity(
              target,
              allocations.reserve(target).pipe(Effect.andThen(Effect.fail("synthetic failure"))),
            )
            .pipe(Effect.flip),
        ).toBe("synthetic failure");
        expect(yield* allocations.get(key)).toBeNull();
        yield* limits.withCapacity(target, allocations.reserve(target));
      }).pipe(Effect.provide(layer)),
    );
  });
}
