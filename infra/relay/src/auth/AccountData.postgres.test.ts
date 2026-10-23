import * as Cloudflare from "alchemy/Cloudflare";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { eq, inArray, sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

import * as RelayDb from "../db.ts";
import { managedEndpointTunnelName } from "../deploymentConfig.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ApnsDeliveryQueue from "../agentActivity/ApnsDeliveryQueue.ts";
import * as Devices from "../agentActivity/Devices.ts";
import type { SignedApnsDeliveryJob } from "../agentActivity/apnsDeliveryJobs.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "../environments/ManagedTunnelLimits.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import { unlinkEnvironmentRecord } from "../http/Api.ts";
import * as Tables from "../persistence/schema.ts";
import { config } from "../test/fixtures.ts";
import * as AccountData from "./AccountData.ts";

const databaseUrl = process.env.RELAY_TEST_DATABASE_URL;
const layerDb = Layer.effect(RelayDb.RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(PgClient.layer({ url: Redacted.make(databaseUrl ?? "postgres://unused") })),
);

const fixture = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const userId = `usr_test_${yield* (yield* Crypto.Crypto).randomUUIDv4}`;
  const otherUserId = `${userId}_other`;
  const now = "2026-10-18T12:00:00.000Z";
  const queued: Array<SignedApnsDeliveryJob> = [];
  const deletedTunnels: Array<string> = [];
  const clearedInboxes: Array<string> = [];
  let failTunnel = false;
  let failInbox = false;
  let failQueue = false;
  const services = Layer.mergeAll(
    AccountData.layer,
    EnvironmentLinks.layer,
    EnvironmentCredentials.layer,
    ManagedEndpointProvider.layer,
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(ManagedEndpointAllocations.layer, ManagedTunnelLimits.layer)),
    Layer.provideMerge(RelayDb.RelayTransactions.layer),
    Layer.provide(ApnsDeliveryQueue.layer),
    Layer.provide(
      Layer.succeed(ApnsDeliveryQueue.ApnsDeliveryQueueSender, {
        send: (job) =>
          failQueue
            ? Effect.fail(new Cloudflare.Queues.SendError({ message: "Synthetic queue outage" }))
            : Effect.sync(() => {
                queued.push(job);
              }),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagedEndpointProvider.ManagedEndpointTunnelClient, {
        delete: (tunnelId) =>
          failTunnel
            ? Effect.fail(
                new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
                  operation: "delete",
                  tunnelId,
                  cause: "synthetic outage",
                }),
              )
            : Effect.sync(() => {
                deletedTunnels.push(tunnelId);
              }),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagedEndpointProvider.ManagedEndpointDnsClient, {
        deleteRecord: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(HookInbox.HookInbox, {
        clear: ({ endpointKey }) =>
          failInbox
            ? Effect.fail(
                new HookInbox.HookInboxError({
                  operation: "clear",
                  endpointKey,
                  cause: "synthetic outage",
                }),
              )
            : Effect.sync(() => {
                clearedInboxes.push(endpointKey);
              }),
      }),
    ),
    Layer.provideMerge(RelayConfiguration.layer(config)),
    Layer.provideMerge(Layer.succeed(RelayDb.RelayDb, db)),
    Layer.provide(NodeCrypto.layer),
  );
  yield* db
    .insert(Tables.relayUsers)
    .values({ userId, email: `${userId}@example.test`, createdAt: now, updatedAt: now });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* db
        .delete(Tables.relayAgentActivityRows)
        .where(inArray(Tables.relayAgentActivityRows.environmentId, [userId, `${userId}_shared`]));
      yield* db
        .delete(Tables.relayEnvironmentLinks)
        .where(inArray(Tables.relayEnvironmentLinks.userId, [userId, otherUserId]));
      yield* db
        .delete(Tables.relayEnvironmentCredentials)
        .where(eq(Tables.relayEnvironmentCredentials.environmentId, userId));
      yield* db
        .delete(Tables.relayManagedEndpointAllocations)
        .where(eq(Tables.relayManagedEndpointAllocations.userId, userId));
      yield* db
        .delete(Tables.relayLiveActivities)
        .where(eq(Tables.relayLiveActivities.userId, userId));
      yield* db
        .delete(Tables.relayMobileDevices)
        .where(eq(Tables.relayMobileDevices.userId, userId));
      yield* db.delete(Tables.relayAuthSessions).where(eq(Tables.relayAuthSessions.userId, userId));
      yield* db
        .delete(Tables.relayManagedTunnelLimits)
        .where(eq(Tables.relayManagedTunnelLimits.userId, userId));
      yield* db.delete(Tables.relayUsers).where(eq(Tables.relayUsers.userId, userId));
    }).pipe(Effect.orDie),
  );
  const addLink = (
    environmentId: string,
    linkedUserId = userId,
    key = "key",
    revokedAt: string | null = null,
  ) =>
    db.insert(Tables.relayEnvironmentLinks).values({
      userId: linkedUserId,
      environmentId,
      environmentPublicKey: key,
      revokedAt,
      endpointHttpBaseUrl: "https://endpoint.example.test",
      endpointWsBaseUrl: "wss://endpoint.example.test",
      endpointProviderKind: "cloudflare_tunnel",
      createdAt: now,
      updatedAt: now,
    });
  const addAllocation = (environmentId = userId) =>
    Effect.gen(function* () {
      const hash = yield* (yield* Crypto.Crypto).digest(
        "SHA-256",
        new TextEncoder().encode(environmentId),
      );
      const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
      yield* db.insert(Tables.relayManagedEndpointAllocations).values({
        userId,
        environmentId,
        hostname: `${environmentId}.example.test`,
        tunnelName: managedEndpointTunnelName("test", hex),
        tunnelId: `tunnel-${environmentId}`,
        dnsRecordId: "dns",
        readyAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });
  const addDevice = (deviceId: string) =>
    Effect.gen(function* () {
      yield* db.insert(Tables.relayMobileDevices).values({
        userId,
        deviceId,
        platform: "ios",
        bundleId: "com.example.relay.test",
        apsEnvironment: "sandbox",
        preferencesJson: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          notifyOnApproval: true,
          notifyOnInput: true,
          notifyOnCompletion: true,
          notifyOnFailure: true,
        },
        createdAt: now,
        updatedAt: now,
      });
      yield* db.insert(Tables.relayLiveActivities).values({
        userId,
        deviceId,
        activityPushToken: `${userId}-${deviceId}`,
        createdAt: now,
        updatedAt: now,
      });
    });
  const deleteAccount = Effect.gen(function* () {
    const data = yield* AccountData.AccountData;
    for (const environmentId of yield* data.listEnvironmentIds(userId)) {
      yield* unlinkEnvironmentRecord({
        userId,
        environmentId,
        managedEndpointNamespace: "test",
        requireCleanup: true,
      });
    }
    yield* data.deleteForUser({ userId, email: `${userId}@example.test` });
  }).pipe(Effect.provide(services));
  const allocations = db
    .select()
    .from(Tables.relayManagedEndpointAllocations)
    .where(eq(Tables.relayManagedEndpointAllocations.userId, userId));
  const accounts = db.select().from(Tables.relayUsers).where(eq(Tables.relayUsers.userId, userId));
  return {
    db,
    userId,
    otherUserId,
    now,
    services,
    addLink,
    addAllocation,
    addDevice,
    queued,
    deletedTunnels,
    clearedInboxes,
    deleteAccount,
    allocations,
    accounts,
    failTunnel: (value: boolean) => {
      failTunnel = value;
    },
    failInbox: (value: boolean) => {
      failInbox = value;
    },
    failQueue: (value: boolean) => {
      failQueue = value;
    },
  };
});

describe.skipIf(!databaseUrl)("account deletion (Postgres)", () => {
  it.live(
    "recovers the held-hook inbox key after an older unlink already removed its allocation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.addLink(f.userId, f.userId, "key", f.now);
        f.failInbox(true);
        expect((yield* Effect.flip(f.deleteAccount))._tag).toBe("HookInboxError");
        expect(yield* f.accounts).toHaveLength(1);
        f.failInbox(false);
        yield* f.deleteAccount;
        expect(f.clearedInboxes).toHaveLength(1);
        expect(f.clearedInboxes[0]).toMatch(/^[0-9a-f]+$/);
        expect(f.deletedTunnels).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDb, NodeCrypto.layer))),
  );

  it.live("retains registrations and account data when enqueue fails so removal can retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.addDevice("phone");
      f.failQueue(true);
      expect((yield* Effect.flip(f.deleteAccount))._tag).toBe("AccountDataDeletePersistenceError");
      expect(yield* f.accounts).toHaveLength(1);
      expect(
        yield* f.db
          .select()
          .from(Tables.relayLiveActivities)
          .where(eq(Tables.relayLiveActivities.userId, f.userId)),
      ).toHaveLength(1);
      f.failQueue(false);
      yield* f.deleteAccount;
      expect(f.queued).toHaveLength(1);
      expect(yield* f.accounts).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDb, NodeCrypto.layer))),
  );

  it.live(
    "retries revoked links and allocation-only environments after external teardown fails",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.addLink(f.userId);
        yield* f.addAllocation();
        yield* f.addAllocation(`${f.userId}_orphan`);
        f.failTunnel(true);
        expect((yield* Effect.flip(f.deleteAccount))._tag).toBe(
          "ManagedEndpointDeprovisioningFailed",
        );
        expect(yield* f.allocations).toHaveLength(2);
        expect(yield* f.accounts).toHaveLength(1);
        const links = yield* f.db
          .select()
          .from(Tables.relayEnvironmentLinks)
          .where(eq(Tables.relayEnvironmentLinks.userId, f.userId));
        expect(links[0]?.revokedAt).not.toBeNull();
        f.failTunnel(false);
        yield* f.deleteAccount;
        expect(f.deletedTunnels.sort()).toEqual(
          [`tunnel-${f.userId}`, `tunnel-${f.userId}_orphan`].sort(),
        );
        expect(f.clearedInboxes.length).toBeGreaterThanOrEqual(3);
        expect(yield* f.allocations).toHaveLength(0);
        expect(yield* f.accounts).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDb, NodeCrypto.layer))),
  );

  it.live("keeps allocation and account state until the held-hook inbox clears", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.addLink(f.userId, f.userId, "key", f.now);
      yield* f.addAllocation();
      f.failInbox(true);
      expect((yield* Effect.flip(f.deleteAccount))._tag).toBe("HookInboxError");
      expect(f.deletedTunnels).toEqual([]);
      expect(yield* f.allocations).toHaveLength(1);
      expect(yield* f.accounts).toHaveLength(1);
      f.failInbox(false);
      yield* f.deleteAccount;
      expect(f.deletedTunnels).toEqual([`tunnel-${f.userId}`]);
      expect(yield* f.allocations).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDb, NodeCrypto.layer))),
  );

  it.live("refuses to erase an outstanding allocation even if teardown was skipped", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.addAllocation();
      const error = yield* Effect.flip(
        Effect.flatMap(AccountData.AccountData, (data) =>
          data.deleteForUser({ userId: f.userId, email: null }),
        ).pipe(Effect.provide(f.services)),
      );
      expect(error._tag).toBe("AccountDataDeletePersistenceError");
      expect(yield* f.allocations).toHaveLength(1);
      expect(yield* f.accounts).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDb, NodeCrypto.layer))),
  );

  it.live(
    "removes only activity pairs with no other active account owner and queues every card end",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const shared = `${f.userId}_shared`;
        yield* f.addLink(f.userId, f.userId, "owned", f.now);
        yield* f.addLink(f.userId, f.otherUserId, "different-key");
        yield* f.addLink(shared, f.userId, "shared", f.now);
        yield* f.addLink(shared, f.otherUserId, "shared");
        const state = {
          environmentId: EnvironmentId.make(f.userId),
          threadId: ThreadId.make("thread"),
          projectTitle: "Synthetic project",
          threadTitle: "Synthetic thread",
          modelTitle: "Agent",
          phase: "running",
          headline: "Running",
          updatedAt: f.now,
          deepLink: "/",
        } satisfies TablesType;
        yield* f.db.insert(Tables.relayAgentActivityRows).values([
          {
            environmentId: f.userId,
            environmentPublicKey: "owned",
            threadId: "thread",
            stateJson: state,
            createdAt: f.now,
            updatedAt: f.now,
          },
          {
            environmentId: f.userId,
            environmentPublicKey: "different-key",
            threadId: "thread",
            stateJson: state,
            createdAt: f.now,
            updatedAt: f.now,
          },
          {
            environmentId: shared,
            environmentPublicKey: "shared",
            threadId: "thread",
            stateJson: state,
            createdAt: f.now,
            updatedAt: f.now,
          },
        ]);
        yield* f.addDevice("phone-a");
        yield* f.addDevice("phone-b");
        yield* f.deleteAccount;
        expect(
          f.queued
            .map((job) => ({
              kind: job.payload.kind,
              removed: job.payload.registrationRemoved,
              device: job.payload.target.deviceId,
            }))
            .sort((a, b) => a.device.localeCompare(b.device)),
        ).toEqual([
          { kind: "live_activity_end", removed: true, device: "phone-a" },
          { kind: "live_activity_end", removed: true, device: "phone-b" },
        ]);
        const remaining = yield* f.db
          .select()
          .from(Tables.relayAgentActivityRows)
          .where(inArray(Tables.relayAgentActivityRows.environmentId, [f.userId, shared]));
        expect(remaining.map((row) => row.environmentPublicKey).sort()).toEqual([
          "different-key",
          "shared",
        ]);
        expect(
          yield* f.db
            .select()
            .from(Tables.relayLiveActivities)
            .where(eq(Tables.relayLiveActivities.userId, f.userId)),
        ).toEqual([]);
        expect(
          yield* f.db
            .select()
            .from(Tables.relayMobileDevices)
            .where(eq(Tables.relayMobileDevices.userId, f.userId)),
        ).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDb, NodeCrypto.layer))),
  );

  it.live("account deletion and session-bound registration take locks in the same order", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const db = f.db;
      const sessionId = "a".repeat(32);
      yield* db.insert(Tables.relayAuthSessions).values({
        sessionId,
        userId: f.userId,
        clientId: "t3-mobile",
        thumbprint: "key",
        tokenHash: "hash",
        lastUsedAt: f.now,
        expiresAt: "2999-01-01T00:00:00.000Z",
        createdAt: f.now,
      });
      yield* db.insert(Tables.relayManagedTunnelLimits).values({
        userId: f.userId,
        maxTunnels: 1,
        createdAt: f.now,
        updatedAt: f.now,
      });
      const devices = yield* Devices.make;
      const register = devices.register({
        userId: f.userId,
        sessionId,
        registration: {
          deviceId: "phone",
          label: "Test phone",
          platform: "ios",
          iosMajorVersion: 18,
          preferences: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            notifyOnApproval: true,
            notifyOnInput: true,
            notifyOnCompletion: true,
            notifyOnFailure: true,
          },
        },
      });
      yield* register;

      // Hold the account's tunnel-limit row so deletion stops after it has
      // touched sessions and devices, then start a registration against the
      // same session. Opposite lock orders deadlock here (40P01).
      const blockerPid = yield* Deferred.make<number>();
      const release = yield* Deferred.make<void>();
      const blocker = yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            yield* db.execute(
              sql`select 1 from relay_managed_tunnel_limits where user_id = ${f.userId} for update`,
            );
            const [row] = yield* db.$client<{ pid: number }>`select pg_backend_pid() as pid`;
            yield* Deferred.succeed(blockerPid, row!.pid);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      const pid = yield* Deferred.await(blockerPid);
      // Waits on lock state, which Postgres reports through pg_blocking_pids.
      const waitingOn = (blocking: number) =>
        db.$client<{ pid: number }>`
          select pid from pg_stat_activity where ${blocking} = any(pg_blocking_pids(pid))
        `.pipe(
          Effect.repeat({
            until: (rows) => rows.length > 0,
            schedule: Schedule.spaced("5 millis"),
          }),
          Effect.map((rows) => rows[0]!.pid),
          Effect.timeout("10 seconds"),
        );
      const deletion = yield* Effect.flatMap(AccountData.AccountData, (data) =>
        data.deleteForUser({ userId: f.userId, email: null }),
      ).pipe(Effect.provide(f.services), Effect.exit, Effect.forkChild);
      const deletionPid = yield* waitingOn(pid);
      const registration = yield* register.pipe(Effect.exit, Effect.forkChild);
      yield* waitingOn(deletionPid);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(blocker);

      expect(Exit.isSuccess(yield* Fiber.join(deletion))).toBe(true);
      const registered = yield* Fiber.join(registration);
      expect(Exit.isFailure(registered) && Exit.findErrorOption(registered)).toMatchObject({
        value: { _tag: "DeviceSessionRevoked" },
      });
      expect(
        yield* db
          .select()
          .from(Tables.relayMobileDevices)
          .where(eq(Tables.relayMobileDevices.userId, f.userId)),
      ).toEqual([]);
      expect(yield* f.accounts).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layerDb, NodeCrypto.layer))),
  );
});

type TablesType = typeof Tables.relayAgentActivityRows.$inferInsert.stateJson;
